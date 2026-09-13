import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BinaryManager } from "./binaryManager";
import type { LinterOptions, LinterOutput } from "./types";
import { getProtoPaths } from "./utils/configReader";
import { findProtoFiles } from "./utils/fileUtils";
import {
	buildLinterArgs,
	buildLinterBatches,
	disposeLinterBatchPlan,
	type LinterBatch,
	parseLinterOutput,
} from "./utils/linterUtils";

/** Debounce window, in ms, before the workspace-wide `buf build` syntax check runs. */
const WORKSPACE_SYNTAX_DEBOUNCE_MS = 500;

/** Source string for diagnostics produced by the `buf build` syntax check. */
const SYNTAX_DIAGNOSTIC_SOURCE = "google-api-linter (syntax)";

/** Matches `file:line:col: message`, with an optional Go log timestamp prefix. */
const SYNTAX_ERROR_REGEX =
	/^(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} )?([^:]+):(\d+):(\d+):\s*(.*)$/;

/** Result of one child process run. */
interface SpawnResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Manages linting of Protocol Buffer files using the api-linter binary.
 * Handles running the linter, parsing output, and updating diagnostics.
 *
 * Per-file linting never shells out to `buf`: the whole-workspace syntax check is
 * a separate, debounced, workspace-level pass (see `scheduleWorkspaceSyntaxCheck`).
 */
export class ApiLinterProvider {
	private diagnosticCollection: vscode.DiagnosticCollection;
	private outputChannel: vscode.OutputChannel;
	private binaryManager: BinaryManager;
	private workspaceLintInProgress = false;
	private activeLintUris = new Set<string>();
	/** When a lint is already running for a URI, set true so we run one more pass after it finishes. */
	private lintAgainPending = new Map<string, boolean>();
	private lastOptionsLogFingerprint: string | null = null;
	/**
	 * Syntax diagnostics live in their own collection so the workspace `buf build`
	 * pass and the per-file api-linter pass never overwrite each other's results.
	 */
	private syntaxDiagnosticCollection: vscode.DiagnosticCollection;
	private syntaxCheckTimer: ReturnType<typeof setTimeout> | null = null;
	private syntaxCheckRunning = false;
	private syntaxCheckQueued = false;
	private syntaxCheckProcess: cp.ChildProcess | null = null;
	private disposed = false;

	/**
	 * Creates a new linter provider.
	 * @param diagnosticCollection - Collection for storing diagnostics
	 * @param outputChannel - Output channel for logging
	 */
	constructor(
		diagnosticCollection: vscode.DiagnosticCollection,
		outputChannel: vscode.OutputChannel,
	) {
		this.diagnosticCollection = diagnosticCollection;
		this.outputChannel = outputChannel;
		this.binaryManager = new BinaryManager(outputChannel);
		this.syntaxDiagnosticCollection =
			vscode.languages.createDiagnosticCollection("google-api-linter-syntax");
	}

	/** Exposes the binary manager for extension commands (reinstall, proto view). */
	public getBinaryManager(): BinaryManager {
		return this.binaryManager;
	}

	/**
	 * Releases the syntax diagnostic collection and cancels any pending or in-flight
	 * workspace syntax check. Safe to call more than once.
	 */
	public dispose(): void {
		this.disposed = true;
		if (this.syntaxCheckTimer) {
			clearTimeout(this.syntaxCheckTimer);
			this.syntaxCheckTimer = null;
		}
		this.syntaxCheckQueued = false;
		if (this.syntaxCheckProcess) {
			try {
				this.syntaxCheckProcess.kill();
			} catch {
				// already exited
			}
			this.syntaxCheckProcess = null;
		}
		this.syntaxDiagnosticCollection.dispose();
	}

	/**
	 * Lints a single document and updates diagnostics.
	 * @param document - The document to lint
	 * @param saveFirst - Whether to save the document before linting (for unsaved changes)
	 * @param silent - If true, runs the lint without showing a progress notification
	 */
	public async lintDocument(
		document: vscode.TextDocument,
		saveFirst: boolean = false,
		silent: boolean = false,
	): Promise<void> {
		if (!document.fileName.endsWith(".proto")) {
			return;
		}

		if (saveFirst && document.isDirty) {
			await document.save();
		}

		const filePath = document.uri.fsPath;
		const uriStr = document.uri.toString();

		if (this.activeLintUris.has(uriStr)) {
			this.lintAgainPending.set(uriStr, true);
			return;
		}

		this.activeLintUris.add(uriStr);
		this.outputChannel.appendLine(
			`Starting lint for: ${filePath} (silent: ${silent})`,
		);

		const runLint = async (
			progress?: vscode.Progress<{ message?: string }>,
		) => {
			try {
				if (progress) progress.report({ message: "Ensuring deps…" });
				const binaryPath = await this.binaryManager.ensureBinary();
				this.outputChannel.appendLine(`Using binary: ${binaryPath}`);

				if (!fs.existsSync(binaryPath)) {
					throw new Error(`Binary not found at ${binaryPath} after download`);
				}

				await this.binaryManager.ensureGoogleapis();
				await this.binaryManager.ensureProtobuf();

				const options = await this.getLinterOptions();
				const diagnostics = await this.runLinter(binaryPath, filePath, options);

				this.outputChannel.appendLine(
					`Found ${diagnostics.length} diagnostic(s)`,
				);
				this.diagnosticCollection.set(document.uri, diagnostics);
			} catch (error) {
				this.outputChannel.appendLine(`Error linting ${filePath}: ${error}`);
				if (error instanceof Error) {
					this.outputChannel.appendLine(`Error stack: ${error.stack}`);
				}
				if (!silent) {
					vscode.window.showErrorMessage(`Google API Linter error: ${error}`);
				}
				this.diagnosticCollection.set(document.uri, []);
			}
		};

		try {
			if (silent) {
				await runLint();
			} else {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Google API Linter",
						cancellable: false,
					},
					async (progress) => {
						progress.report({ message: "Linting current file…" });
						await runLint(progress);
					},
				);
			}
		} finally {
			this.activeLintUris.delete(uriStr);
			const runAgain = this.lintAgainPending.get(uriStr);
			this.lintAgainPending.delete(uriStr);
			if (runAgain) {
				void this.lintDocument(document, saveFirst, silent);
			}
		}
	}

	/**
	 * Gets linter options from VS Code configuration.
	 * @returns Linter configuration options
	 */
	private async getLinterOptions(): Promise<LinterOptions> {
		const config = vscode.workspace.getConfiguration("gapi");

		// Get proto paths from workspace.protobuf.yaml and buf.yaml (modules + deps)
		const configProtoPaths = await getProtoPaths(this.outputChannel);
		const userProtoPaths = config.get<string[]>("protoPath") || [];

		// Merge config file paths with user settings
		const allProtoPaths = [...configProtoPaths, ...userProtoPaths];

		// Include system paths (googleapis and protobuf) from BinaryManager
		const googleapisDir = this.binaryManager.getGoogleapisDir();
		const protobufDir = this.binaryManager.getProtobufDir();

		if (fs.existsSync(googleapisDir)) {
			allProtoPaths.push(googleapisDir);
		}
		if (fs.existsSync(protobufDir)) {
			allProtoPaths.push(protobufDir);
		}

		const options = {
			configPath: config.get<string>("configPath"),
			protoPath: allProtoPaths,
			disableRules: config.get<string[]>("disableRules") || [],
			enableRules: config.get<string[]>("enableRules") || [],
			outputFormat: config.get<string>("outputFormat") || "json",
			setExitStatus: config.get<boolean>("setExitStatus") || false,
		};

		const debugLint = config.get<boolean>("debugLintLogging", false) === true;
		const fingerprint = JSON.stringify({
			configPath: options.configPath,
			configProtoPaths,
			userProtoPaths,
			disableRules: options.disableRules,
			enableRules: options.enableRules,
		});
		if (debugLint || fingerprint !== this.lastOptionsLogFingerprint) {
			this.lastOptionsLogFingerprint = fingerprint;
			this.outputChannel.appendLine("=".repeat(60));
			this.outputChannel.appendLine("Applied Linter Settings:");
			this.outputChannel.appendLine(
				`  Config Path: ${options.configPath || "(not set)"}`,
			);
			this.outputChannel.appendLine(`  Proto Paths (${allProtoPaths.length}):`);
			if (configProtoPaths.length > 0) {
				this.outputChannel.appendLine(
					`    From workspace.protobuf.yaml and/or buf.yaml (modules + deps): ${configProtoPaths.length} path(s)`,
				);
				for (const p of configProtoPaths) {
					this.outputChannel.appendLine(`      - ${p}`);
				}
			}
			if (userProtoPaths.length > 0) {
				this.outputChannel.appendLine(
					`    From settings.json: ${userProtoPaths.length} path(s)`,
				);
				for (const p of userProtoPaths) {
					this.outputChannel.appendLine(`      - ${p}`);
				}
			}
			if (options.disableRules.length > 0) {
				this.outputChannel.appendLine(
					`  Disabled Rules: ${options.disableRules.join(", ")}`,
				);
			}
			if (options.enableRules.length > 0) {
				this.outputChannel.appendLine(
					`  Enabled Rules: ${options.enableRules.join(", ")}`,
				);
			}
			this.outputChannel.appendLine(
				`  Set Exit Status: ${options.setExitStatus}`,
			);
			this.outputChannel.appendLine(
				`  Enable on Save: ${config.get<boolean>("enableOnSave")}`,
			);
			this.outputChannel.appendLine(
				`  Enable on Type: ${config.get<boolean>("enableOnType")}`,
			);
			this.outputChannel.appendLine("=".repeat(60));
		}

		return options;
	}

	/**
	 * Lints a single file by URI (does not require the document to be open).
	 * @param uri - The proto file to lint
	 * @param preloaded - Binary path and options resolved by the caller, to skip re-resolution
	 */
	public async lintUri(
		uri: vscode.Uri,
		preloaded?: { binaryPath: string; options: LinterOptions },
	): Promise<void> {
		const filePath = uri.fsPath;
		if (!filePath.endsWith(".proto")) {
			return;
		}

		const uriStr = uri.toString();
		if (this.activeLintUris.has(uriStr)) {
			return;
		}
		this.activeLintUris.add(uriStr);

		this.outputChannel.appendLine(`Starting lint for: ${filePath}`);
		try {
			let binaryPath: string;
			let options: LinterOptions;
			if (preloaded) {
				binaryPath = preloaded.binaryPath;
				options = preloaded.options;
			} else {
				this.outputChannel.appendLine(
					"Ensuring deps (binary, googleapis, protobuf)…",
				);
				binaryPath = await this.binaryManager.ensureBinary();
				if (!fs.existsSync(binaryPath)) {
					throw new Error(`Binary not found at ${binaryPath} after download`);
				}
				await this.binaryManager.ensureGoogleapis();
				await this.binaryManager.ensureProtobuf();
				options = await this.getLinterOptions();
			}

			const diagnostics = await this.runLinter(binaryPath, filePath, options);
			this.outputChannel.appendLine(
				`Found ${diagnostics.length} diagnostic(s)`,
			);
			this.diagnosticCollection.set(uri, diagnostics);
		} catch (error) {
			this.outputChannel.appendLine(`Error linting ${filePath}: ${error}`);
			this.diagnosticCollection.set(uri, []);
		} finally {
			this.activeLintUris.delete(uriStr);
		}
	}

	/**
	 * Lints all proto files in the workspace using batched api-linter invocations
	 * (many file arguments per process), then schedules one workspace syntax check.
	 */
	public async lintWorkspace(): Promise<void> {
		if (this.workspaceLintInProgress) {
			vscode.window.showInformationMessage(
				"Workspace lint is already running.",
			);
			return;
		}
		const protoFiles = await findProtoFiles();
		if (protoFiles.length === 0) {
			vscode.window.showInformationMessage(
				"No .proto files found in workspace.",
			);
			return;
		}

		this.workspaceLintInProgress = true;
		const total = protoFiles.length;
		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "Google API Linter",
					cancellable: false,
				},
				async (progress) => {
					progress.report({ message: "Ensuring deps…" });
					const binaryPath = await this.binaryManager.ensureBinary();
					if (!fs.existsSync(binaryPath)) {
						throw new Error(`Binary not found at ${binaryPath} after download`);
					}
					await this.binaryManager.ensureGoogleapis();
					await this.binaryManager.ensureProtobuf();
					const options = await this.getLinterOptions();

					// Keep the caller's URIs so diagnostics land on the exact resource
					// VS Code already knows about, rather than a re-derived file URI.
					const uriByPath = new Map<string, vscode.Uri>();
					for (const uri of protoFiles) {
						uriByPath.set(path.normalize(uri.fsPath), uri);
					}

					const plan = buildLinterBatches(
						protoFiles.map((uri) => uri.fsPath),
						options,
					);
					const batchTotal = plan.batches.length;
					this.outputChannel.appendLine(
						`Workspace lint: ${total} file(s) in ${batchTotal} batch(es)`,
					);

					try {
						for (let i = 0; i < batchTotal; i++) {
							progress.report({
								message: `Linting batch ${i + 1}/${batchTotal}…`,
								increment: i === 0 ? 0 : 100 / batchTotal,
							});
							await this.runLinterBatch(binaryPath, plan.batches[i], uriByPath);
						}
					} finally {
						disposeLinterBatchPlan(plan);
					}

					progress.report({ message: "Done", increment: 100 / batchTotal });
				},
			);
			// One whole-workspace `buf build`, not one per file.
			this.scheduleWorkspaceSyntaxCheck();
			vscode.window.showInformationMessage(
				`Google API Linter: workspace linting completed (${total} file(s)).`,
			);
		} finally {
			this.workspaceLintInProgress = false;
		}
	}

	/**
	 * Queues the workspace-wide `buf build` syntax check, collapsing bursts of calls
	 * into a single run. Safe to call on every save or edit.
	 * @param delayMs - Debounce window in milliseconds
	 */
	public scheduleWorkspaceSyntaxCheck(
		delayMs: number = WORKSPACE_SYNTAX_DEBOUNCE_MS,
	): void {
		if (this.disposed) {
			return;
		}
		if (this.syntaxCheckTimer) {
			clearTimeout(this.syntaxCheckTimer);
		}
		this.syntaxCheckTimer = setTimeout(() => {
			this.syntaxCheckTimer = null;
			void this.runWorkspaceSyntaxCheck();
		}, delayMs);
	}

	/**
	 * Runs `buf build` once over the workspace and fans the resulting syntax errors
	 * out to the files they belong to. Concurrent calls are coalesced: a request made
	 * while a check is running re-schedules one run afterwards instead of spawning a
	 * second `buf build`.
	 */
	public async runWorkspaceSyntaxCheck(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.syntaxCheckRunning) {
			this.syntaxCheckQueued = true;
			return;
		}
		this.syntaxCheckRunning = true;
		try {
			await this.executeWorkspaceSyntaxCheck();
		} catch (error) {
			this.outputChannel.appendLine(`Workspace syntax check failed: ${error}`);
		} finally {
			this.syntaxCheckRunning = false;
			if (this.syntaxCheckQueued && !this.disposed) {
				this.syntaxCheckQueued = false;
				this.scheduleWorkspaceSyntaxCheck();
			}
		}
	}

	/** Spawns the single `buf build` and publishes its diagnostics. */
	private async executeWorkspaceSyntaxCheck(): Promise<void> {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		const cwd = workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			return;
		}
		const bufPath = vscode.workspace
			.getConfiguration("gapi")
			.get<string>("bufPath", "buf");

		const stderr = await new Promise<string | null>((resolve) => {
			let child: cp.ChildProcess;
			try {
				child = cp.spawn(bufPath, ["build"], {
					cwd,
					stdio: ["ignore", "ignore", "pipe"],
				});
			} catch {
				resolve(null);
				return;
			}
			this.syntaxCheckProcess = child;
			let buffer = "";
			child.stderr?.on("data", (data: Buffer) => {
				buffer += data.toString();
			});
			child.on("error", () => {
				this.syntaxCheckProcess = null;
				resolve(null);
			});
			child.on("close", (code) => {
				this.syntaxCheckProcess = null;
				resolve(code === 0 ? "" : buffer);
			});
		});

		if (this.disposed || stderr === null) {
			// buf is unavailable (or we were disposed); leave existing state alone.
			return;
		}

		const byFile = parseSyntaxErrorsByFile(stderr, cwd);
		const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
		for (const [filePath, diagnostics] of byFile) {
			entries.push([vscode.Uri.file(filePath), diagnostics]);
		}
		this.syntaxDiagnosticCollection.clear();
		if (entries.length > 0) {
			this.syntaxDiagnosticCollection.set(entries);
			this.outputChannel.appendLine(
				`Workspace syntax check: ${entries.length} file(s) with syntax errors`,
			);
		}
	}

	/**
	 * Runs one api-linter process over many files and routes every reported problem
	 * back to the file it came from. Files in the batch that reported nothing are
	 * cleared so stale diagnostics do not linger.
	 */
	private async runLinterBatch(
		binaryPath: string,
		batch: LinterBatch,
		uriByPath: Map<string, vscode.Uri>,
	): Promise<void> {
		const args = [...batch.baseArgs, ...batch.fileNames];
		this.outputChannel.appendLine(
			`Running batch: ${binaryPath} (${batch.fileNames.length} file(s)) in ${batch.workingDir}`,
		);

		// Every file in the batch starts clean; results only ever add to these.
		const byPath = new Map<string, vscode.Diagnostic[]>();
		for (const filePath of batch.filePaths) {
			byPath.set(path.normalize(filePath), []);
		}

		let result: SpawnResult;
		try {
			result = await this.spawnLinter(binaryPath, args, batch.workingDir);
		} catch (error) {
			this.outputChannel.appendLine(`Batch failed to run: ${error}`);
			return;
		}

		const { stdout, stderr, code } = result;
		// Exit codes 0 and 1 are both expected: 1 only means findings exist.
		if (code !== 0 && code !== 1) {
			this.outputChannel.appendLine(
				`api-linter exited with code ${code} for batch in ${batch.workingDir}`,
			);
			if (stderr.trim()) {
				this.outputChannel.appendLine(`stderr: ${stderr.substring(0, 2000)}`);
			}
		}

		for (const [filePath, diagnostics] of parseBatchProblems(
			stdout,
			batch,
			this.outputChannel,
		)) {
			const existing = byPath.get(filePath);
			if (existing) {
				existing.push(...diagnostics);
			} else {
				byPath.set(filePath, diagnostics);
			}
		}

		// Compile/syntax errors reach stderr; they are reported per file too.
		if (stderr.trim().length > 0) {
			for (const [filePath, diagnostics] of parseSyntaxErrorsByFile(
				stderr,
				batch.workingDir,
			)) {
				const existing = byPath.get(filePath);
				if (existing) {
					existing.unshift(...diagnostics);
				}
			}
		}

		const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];
		for (const [filePath, diagnostics] of byPath) {
			const uri = uriByPath.get(filePath) ?? vscode.Uri.file(filePath);
			entries.push([uri, diagnostics]);
		}
		this.diagnosticCollection.set(entries);
	}

	/**
	 * Runs the linter binary on a file.
	 * @param binaryPath - Path to the api-linter binary
	 * @param filePath - Path to the file to lint
	 * @param options - Linter configuration options
	 * @returns Array of diagnostics found
	 */
	private async runLinter(
		binaryPath: string,
		filePath: string,
		options: LinterOptions,
	): Promise<vscode.Diagnostic[]> {
		const { args, workingDir, tempConfigPath } = buildLinterArgs(
			filePath,
			options,
		);

		this.outputChannel.appendLine(`Running: ${binaryPath} ${args.join(" ")}`);
		this.outputChannel.appendLine(`Working directory: ${workingDir}`);

		let result: SpawnResult;
		try {
			result = await this.spawnLinter(binaryPath, args, workingDir);
		} finally {
			if (tempConfigPath) {
				try {
					fs.unlinkSync(tempConfigPath);
				} catch {
					// already gone
				}
			}
		}

		const { stdout, stderr, code } = result;
		if (stderr) {
			this.outputChannel.appendLine(`stderr: ${stderr}`);
		}
		this.outputChannel.appendLine(
			`Raw linter output (first 500 chars): ${stdout.substring(0, 500)}`,
		);

		// Try to parse diagnostics from stdout first (standard JSON output)
		let diagnostics = parseLinterOutput(stdout, this.outputChannel);

		// If no diagnostics found from stdout, check stderr (syntax errors often go here)
		if (diagnostics.length === 0 && stderr.trim().length > 0) {
			const stderrDiagnostics = parseLinterOutput(stderr, this.outputChannel);
			if (stderrDiagnostics.length > 0) {
				diagnostics = stderrDiagnostics;
				this.outputChannel.appendLine(
					`Found ${diagnostics.length} diagnostic(s) in stderr`,
				);
			}
		}

		// Only fail if we failed and found no diagnostics. 0 and 1 are both fine.
		if (diagnostics.length === 0 && code !== 0 && code !== 1) {
			this.outputChannel.appendLine(`api-linter exited with code ${code}`);
			this.outputChannel.appendLine(`stdout: ${stdout}`);
			throw new Error(`api-linter exited with code ${code}`);
		}

		if (
			diagnostics.length === 0 &&
			stdout.trim() !== "" &&
			stdout.trim() !== "[]" &&
			stderr.trim() === ""
		) {
			this.outputChannel.appendLine(
				`Warning: No diagnostics parsed from output`,
			);
		}

		return diagnostics;
	}

	/** Spawns the api-linter binary and collects its output. */
	private async spawnLinter(
		binaryPath: string,
		args: string[],
		workingDir: string,
	): Promise<SpawnResult> {
		return new Promise<SpawnResult>((resolve, reject) => {
			const child = cp.spawn(binaryPath, args, { cwd: workingDir });

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (data: Buffer) => {
				stdout += data.toString();
			});

			child.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			child.on("error", (error: Error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(
						new Error(
							`api-linter binary not found at: ${binaryPath}. Please install it or configure the correct path in settings.`,
						),
					);
				} else {
					reject(error);
				}
			});

			child.on("close", (code: number | null) => {
				resolve({ stdout, stderr, code });
			});
		});
	}
}

/**
 * Parses api-linter JSON output covering many files and groups the resulting
 * diagnostics by normalized absolute file path.
 *
 * api-linter echoes the file argument it was given, so paths are resolved against
 * the batch's working directory; anything it reports that is not in the batch is
 * matched by base name as a fallback.
 */
function parseBatchProblems(
	stdout: string,
	batch: LinterBatch,
	outputChannel: vscode.OutputChannel,
): Map<string, vscode.Diagnostic[]> {
	const byPath = new Map<string, vscode.Diagnostic[]>();
	const trimmed = stdout.trim();
	if (trimmed === "" || trimmed === "[]") {
		return byPath;
	}

	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start === -1 || end <= start) {
		outputChannel.appendLine("Batch output contained no JSON array");
		return byPath;
	}

	let results: LinterOutput[];
	try {
		results = JSON.parse(trimmed.substring(start, end + 1));
	} catch (error) {
		outputChannel.appendLine(`Failed to parse batch JSON output: ${error}`);
		return byPath;
	}
	if (!Array.isArray(results)) {
		return byPath;
	}

	const byBaseName = new Map<string, string>();
	for (const filePath of batch.filePaths) {
		byBaseName.set(path.basename(filePath), path.normalize(filePath));
	}

	for (const result of results) {
		if (!result?.problems || result.problems.length === 0) {
			continue;
		}
		const reported = result.file_path ?? "";
		const resolved = path.normalize(
			path.isAbsolute(reported)
				? reported
				: path.resolve(batch.workingDir, reported),
		);
		const key = byBaseName.get(path.basename(reported)) ?? resolved;

		// Re-use the shared parser (and therefore the shared diagnostic source and
		// rule-doc handling) by handing it a single-result array.
		const diagnostics = parseLinterOutput(JSON.stringify([result]));
		if (diagnostics.length === 0) {
			continue;
		}
		const existing = byPath.get(key);
		if (existing) {
			existing.push(...diagnostics);
		} else {
			byPath.set(key, diagnostics);
		}
	}

	return byPath;
}

/**
 * Parses buf/protoc-style output (`file:line:col: message`) into diagnostics grouped
 * by normalized absolute file path. Relative paths resolve against `cwd`.
 * @param output - Combined stderr text from buf or api-linter
 * @param cwd - Directory the reported paths are relative to
 */
function parseSyntaxErrorsByFile(
	output: string,
	cwd: string,
): Map<string, vscode.Diagnostic[]> {
	const byFile = new Map<string, vscode.Diagnostic[]>();
	if (!output) {
		return byFile;
	}

	for (const line of output.split("\n")) {
		const match = line.match(SYNTAX_ERROR_REGEX);
		if (!match) {
			continue;
		}
		const reported = match[1].trim();
		if (!reported.endsWith(".proto")) {
			continue;
		}
		const lineNum = parseInt(match[2], 10) - 1;
		const colNum = Math.max(0, parseInt(match[3], 10) - 1);
		if (lineNum < 0) {
			continue;
		}
		const message = match[4].trim();
		const resolved = path.normalize(
			path.isAbsolute(reported) ? reported : path.join(cwd, reported),
		);

		const diagnostic = new vscode.Diagnostic(
			new vscode.Range(lineNum, colNum, lineNum, Math.max(colNum + 1, 200)),
			message,
			vscode.DiagnosticSeverity.Error,
		);
		diagnostic.source = SYNTAX_DIAGNOSTIC_SOURCE;

		const existing = byFile.get(resolved);
		if (existing) {
			existing.push(diagnostic);
		} else {
			byFile.set(resolved, [diagnostic]);
		}
	}

	return byFile;
}
