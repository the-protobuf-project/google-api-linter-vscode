import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import YAML from "yaml";
import { CONFIG_FILE_NAME } from "../constants";
import type { LinterOptions, LinterOutput, LinterProblem } from "../types";
import { toPosix } from "./glob";

export type ResolvedApiLinterConfig = {
	/** Path passed to api-linter --config */
	path: string;
	/** Temp file to delete after the run, if any */
	tempFile: string | null;
};

/**
 * api-linter expects config to be an array of config objects (lint.Configs).
 * If the file is a single map (e.g. disabled_rules at top level), wrap it in an array
 * and write to a temp file so the binary can parse it.
 */
function resolveConfigToArrayFormat(
	configPath: string,
): ResolvedApiLinterConfig {
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		const parsed = YAML.parse(raw);
		if (parsed === null || typeof parsed !== "object") {
			return { path: configPath, tempFile: null };
		}
		if (Array.isArray(parsed)) {
			return { path: configPath, tempFile: null };
		}
		// Single map: wrap in array and write to temp file
		const arrayConfig = [parsed];
		const tempPath = path.join(
			os.tmpdir(),
			`api-linter-config-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`,
		);
		fs.writeFileSync(tempPath, YAML.stringify(arrayConfig), "utf8");
		return { path: tempPath, tempFile: tempPath };
	} catch {
		return { path: configPath, tempFile: null };
	}
}

/**
 * Resolves workspace variables in a path string.
 * @param pathStr - Path string potentially containing variables like ${workspaceFolder}
 * @param filePath - Current file path for context
 * @returns Resolved absolute path
 */
const resolveWorkspaceVariables = (
	pathStr: string,
	filePath: string,
): string => {
	let resolved = pathStr;

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(
			vscode.Uri.file(filePath),
		);
		const workspacePath =
			workspaceFolder?.uri.fsPath || workspaceFolders[0].uri.fsPath;

		resolved = resolved.replace(/\$\{workspaceFolder\}/g, workspacePath);
		resolved = resolved.replace(/\$\{workspaceRoot\}/g, workspacePath);
	}

	return path.resolve(resolved);
};

/**
 * Find .api-linter.yaml in workspace root or walking up from the file's directory.
 * So linting works from inside any folder and the config is still used.
 */
function findApiLinterConfig(filePath: string): string | null {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const workspaceRoot = workspaceFolders?.length
		? (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri
				.fsPath ?? workspaceFolders[0].uri.fsPath)
		: path.dirname(filePath);
	const rootAt = path.resolve(workspaceRoot);
	let dir = path.resolve(path.dirname(filePath));
	while (dir && (dir === rootAt || dir.startsWith(rootAt + path.sep))) {
		const candidate = path.join(dir, CONFIG_FILE_NAME);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		if (dir === rootAt) {
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	const atRoot = path.join(rootAt, CONFIG_FILE_NAME);
	return fs.existsSync(atRoot) ? atRoot : null;
}

/**
 * If the file is under a directory named "protobuf", return that directory so
 * imports like "store/info/v1/category.proto" resolve (root = protobuf).
 */
function getProtobufRootProtoPath(filePath: string): string | null {
	const absolute = path.resolve(filePath);
	const parts = absolute.split(path.sep);
	for (let i = parts.length - 2; i >= 0; i--) {
		if (parts[i] === "protobuf") {
			const protoRoot = parts.slice(0, i + 1).join(path.sep);
			if (fs.existsSync(protoRoot)) {
				return protoRoot;
			}
			return null;
		}
	}
	return null;
}

/** True when `candidate` is `dir` itself or sits somewhere beneath it. */
const contains = (dir: string, candidate: string): boolean => {
	const root = path.resolve(dir);
	const target = path.resolve(candidate);
	return target === root || target.startsWith(root + path.sep);
};

/**
 * The directory api-linter runs from, and therefore the directory every file
 * argument -- and every `included_paths` / `excluded_paths` glob in the config
 * -- is relative to.
 *
 * This is the whole reason path scoping works at all. api-linter matches those
 * globs against the file name it was handed, so passing a bare `book.proto`
 * from inside its own directory made every directory glob a guaranteed miss:
 * `vendor/**` can never match `book.proto`. Running from the directory that
 * owns the config instead, with `vendor/book.proto` as the argument, is what
 * lets a config say which folders it governs.
 *
 * Without a config there is nothing to be relative to, so the file's own
 * directory stays the root and the argument stays a bare base name.
 *
 * @param absolutePath - The proto being linted
 * @param configPath - Governing `.api-linter.yaml`, if one was found
 * @returns Absolute directory to spawn in
 */
const resolveLintRoot = (
	absolutePath: string,
	configPath: string | null,
): string => {
	const fileDir = path.dirname(absolutePath);
	if (!configPath) {
		return fileDir;
	}

	const configDir = path.dirname(path.resolve(configPath));
	if (contains(configDir, absolutePath)) {
		return configDir;
	}

	// A config pointed at from elsewhere (`gapi.configPath` naming a shared file
	// outside the tree) still needs a root its globs can be written against, and
	// the workspace folder is the one the author would have had in mind.
	const workspaceFolder = vscode.workspace.workspaceFolders?.length
		? (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolutePath))?.uri
				.fsPath ?? vscode.workspace.workspaceFolders[0].uri.fsPath)
		: null;
	if (workspaceFolder && contains(workspaceFolder, absolutePath)) {
		return path.resolve(workspaceFolder);
	}
	return fileDir;
};

/**
 * The file argument for one proto: posix, and relative to the lint root so the
 * config's path globs have something with directories in it to match.
 *
 * @param absolutePath - The proto being linted
 * @param lintRoot - Directory api-linter will be spawned in
 */
const toFileArgument = (absolutePath: string, lintRoot: string): string => {
	const relative = path.relative(lintRoot, absolutePath);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		return path.basename(absolutePath);
	}
	return toPosix(relative);
};

/**
 * Builds every argument an api-linter invocation needs except the file names:
 * config, proto paths, rule toggles, output format. All of these are derived from
 * the file's directory, so any two files sharing a directory share this argv.
 */
const buildSharedLinterArgs = (
	filePath: string,
	options: LinterOptions,
): {
	args: string[];
	workingDir: string;
	tempConfigPath: string | null;
} => {
	const args: string[] = [];
	let tempConfigPath: string | null = null;

	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(filePath);
	const fileDir = path.dirname(absolutePath);

	const configToUse = options.configPath
		? resolveWorkspaceVariables(options.configPath, filePath)
		: findApiLinterConfig(filePath);
	const activeConfig =
		configToUse && fs.existsSync(configToUse) ? configToUse : null;
	if (activeConfig) {
		const resolved = resolveConfigToArrayFormat(activeConfig);
		args.push("--config", resolved.path);
		tempConfigPath = resolved.tempFile;
	}

	const workingDir = resolveLintRoot(absolutePath, activeConfig);

	// The root comes first so the root-relative file argument resolves against
	// it; the file's own directory follows so sibling imports keep resolving the
	// way they did when it was the only root.
	args.push("--proto-path", workingDir);
	if (fileDir !== workingDir) {
		args.push("--proto-path", fileDir);
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(
			vscode.Uri.file(filePath),
		);
		const workspaceRoot =
			workspaceFolder?.uri.fsPath || workspaceFolders[0].uri.fsPath;

		if (workspaceRoot !== workingDir && fs.existsSync(workspaceRoot)) {
			args.push("--proto-path", workspaceRoot);
		}

		const workspaceGapiDir = path.join(workspaceRoot, ".gapi", "googleapis");
		if (fs.existsSync(workspaceGapiDir)) {
			args.push("--proto-path", workspaceGapiDir);
		}
	}

	const protobufRoot = getProtobufRootProtoPath(filePath);
	if (protobufRoot) {
		args.push("--proto-path", protobufRoot);
	}

	const homeGapiDir = path.join(
		require("node:os").homedir(),
		".gapi",
		"googleapis",
	);
	if (fs.existsSync(homeGapiDir)) {
		args.push("--proto-path", homeGapiDir);
	}

	options.protoPath.forEach((protoPath) => {
		const resolvedPath = resolveWorkspaceVariables(protoPath, filePath);
		if (fs.existsSync(resolvedPath)) {
			args.push("--proto-path", resolvedPath);
		}
	});

	options.disableRules.forEach((rule) => {
		args.push("--disable-rule", rule);
	});

	options.enableRules.forEach((rule) => {
		args.push("--enable-rule", rule);
	});

	if (options.setExitStatus) {
		args.push("--set-exit-status");
	}

	args.push("--output-format", "json");

	return { args, workingDir, tempConfigPath };
};

/**
 * Builds command-line arguments for the api-linter binary.
 * @param filePath - Path to the proto file to lint
 * @param options - Linter configuration options
 * @returns Object containing args array, working directory, and file name
 */
export const buildLinterArgs = (
	filePath: string,
	options: LinterOptions,
): {
	args: string[];
	workingDir: string;
	fileName: string;
	/** Temp config from resolveConfigToArrayFormat — unlink after spawn completes */
	tempConfigPath: string | null;
} => {
	const { args, workingDir, tempConfigPath } = buildSharedLinterArgs(
		filePath,
		options,
	);
	const fileName = toFileArgument(path.resolve(filePath), workingDir);
	args.push(fileName);
	return { args, workingDir, fileName, tempConfigPath };
};

/**
 * Largest number of file arguments in one api-linter invocation.
 * Paired with MAX_BATCH_ARGV_CHARS to stay well clear of ARG_MAX.
 */
export const MAX_BATCH_FILES = 400;

/** Largest combined argv length, in characters, for one api-linter invocation. */
export const MAX_BATCH_ARGV_CHARS = 100_000;

/** One api-linter invocation covering many files that share a cwd and proto paths. */
export interface LinterBatch {
	/** Working directory for the spawned process; every fileName is relative to it. */
	workingDir: string;
	/** Shared flags: --config, --proto-path, rule toggles, --output-format. */
	baseArgs: string[];
	/** File arguments, in argv order: posix paths relative to `workingDir`. */
	fileNames: string[];
	/** Absolute path of each entry in fileNames, same order. */
	filePaths: string[];
}

/** A complete set of batches plus the temp files that outlive individual batches. */
export interface LinterBatchPlan {
	batches: LinterBatch[];
	/** Shared across batches of the same directory — unlink only once all have run. */
	tempConfigPaths: string[];
}

/**
 * Groups proto files into as few api-linter invocations as possible.
 *
 * api-linter resolves each file argument against its --proto-path entries and cwd,
 * and both of those are derived from the file's own directory, so a directory is the
 * largest unit whose files can share one argv without changing how any path resolves.
 *
 * @param filePaths - Proto files to lint; relative paths are resolved against cwd
 * @param options - Linter configuration options
 * @returns Batches to run, and temp configs to dispose once they all have
 */
export function buildLinterBatches(
	filePaths: readonly string[],
	options: LinterOptions,
): LinterBatchPlan {
	const byWorkingDir = new Map<string, string[]>();
	for (const filePath of filePaths) {
		const absolute = path.resolve(filePath);
		const dir = path.dirname(absolute);
		const group = byWorkingDir.get(dir);
		if (group) {
			group.push(absolute);
		} else {
			byWorkingDir.set(dir, [absolute]);
		}
	}

	const batches: LinterBatch[] = [];
	const tempConfigPaths: string[] = [];

	for (const group of byWorkingDir.values()) {
		const shared = buildSharedLinterArgs(group[0], options);
		if (shared.tempConfigPath) {
			tempConfigPaths.push(shared.tempConfigPath);
		}
		// +1 per argument for the separator the kernel counts alongside each argv entry.
		const baseChars = shared.args.reduce((sum, arg) => sum + arg.length + 1, 0);

		let fileNames: string[] = [];
		let batchFilePaths: string[] = [];
		let chars = baseChars;

		const flush = () => {
			if (fileNames.length === 0) {
				return;
			}
			batches.push({
				workingDir: shared.workingDir,
				baseArgs: shared.args,
				fileNames,
				filePaths: batchFilePaths,
			});
			fileNames = [];
			batchFilePaths = [];
			chars = baseChars;
		};

		for (const absolute of group) {
			const fileName = toFileArgument(absolute, shared.workingDir);
			const cost = fileName.length + 1;
			if (
				fileNames.length > 0 &&
				(fileNames.length >= MAX_BATCH_FILES ||
					chars + cost > MAX_BATCH_ARGV_CHARS)
			) {
				flush();
			}
			fileNames.push(fileName);
			batchFilePaths.push(absolute);
			chars += cost;
		}
		flush();
	}

	return { batches, tempConfigPaths };
}

/**
 * Deletes the temp configs a batch plan created. Call once every batch has run.
 * @param plan - The plan returned by buildLinterBatches
 */
export function disposeLinterBatchPlan(plan: LinterBatchPlan): void {
	for (const tempConfigPath of plan.tempConfigPaths) {
		try {
			fs.unlinkSync(tempConfigPath);
		} catch {
			// already gone
		}
	}
}

/**
 * Parses JSON output from the api-linter into VS Code diagnostics.
 * @param output - Raw JSON output from the linter
 * @param outputChannel - Optional output channel for logging
 * @returns Array of VS Code Diagnostic objects
 */
/**
 * Matches `file:line:col: message`, with an optional Go log timestamp prefix.
 *
 * Three details are load-bearing, and all three were once wrong in each of the
 * three copies of this pattern that used to exist -- which is why it now lives
 * here alone and `linterProvider` imports it.
 *
 * - `(?:[A-Za-z]:)?` admits a Windows drive letter. Without it `([^:]+)` stops
 *   at the colon in `C:\proto\a.proto`, the line never matches, and a Windows
 *   user sees no syntax errors at all.
 * - `\r?$` tolerates CRLF. The output is split on "\n", so a CRLF stream leaves
 *   a carriage return on every line; `$` without the `m` flag then matches only
 *   the true end of the string, so every line failed.
 * - The message is non-greedy so the optional `\r` is left for the anchor
 *   rather than swallowed into the text.
 *
 * Example: `proto/library.proto:12:4: syntax error: unexpected identifier`
 * Example: `2026/02/20 14:49:31 proto/library.proto:12:4: syntax error: ...`
 * Example: `C:\src\proto\library.proto:12:4: syntax error`
 */
export const SYNTAX_ERROR_REGEX =
	/^(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} )?((?:[A-Za-z]:)?[^:]+):(\d+):(\d+):\s*(.*?)\r?$/;

export const parseLinterOutput = (
	output: string,
	outputChannel?: vscode.OutputChannel,
): vscode.Diagnostic[] => {
	const diagnostics: vscode.Diagnostic[] = [];

	if (!output || output.trim() === "") {
		return diagnostics;
	}

	try {
		// Extract JSON array from output - linter might output non-JSON text before/after
		let jsonOutput = output.trim();

		// Find the first '[' which starts the JSON array
		const jsonStart = jsonOutput.indexOf("[");
		if (jsonStart === -1) {
			if (outputChannel) {
				outputChannel.appendLine(
					`No JSON array found, trying generic output parser`,
				);
			}
			return parseGenericOutput(output, outputChannel);
		}

		// Find the last ']' which ends the JSON array
		const jsonEnd = jsonOutput.lastIndexOf("]");
		if (jsonEnd === -1 || jsonEnd < jsonStart) {
			if (outputChannel) {
				outputChannel.appendLine(
					`Invalid JSON array, trying generic output parser`,
				);
			}
			return parseGenericOutput(output, outputChannel);
		}

		// Extract only the JSON part
		jsonOutput = jsonOutput.substring(jsonStart, jsonEnd + 1);

		if (outputChannel) {
			outputChannel.appendLine(
				`Extracted JSON (first 200 chars): ${jsonOutput.substring(0, 200)}`,
			);
		}

		const results: LinterOutput[] = JSON.parse(jsonOutput);

		results.forEach((result) => {
			if (!result.problems || result.problems.length === 0) {
				return;
			}

			result.problems.forEach((problem) => {
				// Guarded per problem. A findings array is now one batched run over
				// a whole module, so letting a single malformed entry throw would
				// unwind the loop, discard every finding already collected, and
				// hand the output to the text parser -- which matches nothing in
				// JSON. The user would see no diagnostics at all for thousands of
				// files, with nothing to say why.
				try {
					diagnostics.push(createDiagnosticFromProblem(problem));
				} catch (error) {
					outputChannel?.appendLine(
						`Skipping a malformed finding${
							result.file_path ? ` in ${result.file_path}` : ""
						}: ${error}`,
					);
				}
			});
		});
	} catch (error) {
		// If JSON parsing fails, try to parse as generic text output (e.g. syntax errors)
		if (outputChannel) {
			outputChannel.appendLine(
				`JSON parsing failed, trying generic output parser: ${error}`,
			);
		}
		return parseGenericOutput(output, outputChannel);
	}

	return diagnostics;
};

/**
 * Parses generic text output (e.g., syntax errors) from the linter.
 * Format: file_path:line:col: message
 */
export const parseGenericOutput = (
	output: string,
	outputChannel?: vscode.OutputChannel,
): vscode.Diagnostic[] => {
	const diagnostics: vscode.Diagnostic[] = [];
	const lines = output.split("\n");

	const errorRegex = SYNTAX_ERROR_REGEX;

	for (const line of lines) {
		const match = line.match(errorRegex);
		if (match) {
			const [, , lineStr, colStr, message] = match;

			const lineNum = parseInt(lineStr, 10) - 1; // 1-based to 0-based
			// Clamped, not rejected. Some protoc builds report column 0 to mean
			// "the whole line"; subtracting one gave -1 and the guard below then
			// dropped the report entirely, losing a real syntax error. The other
			// two parsers in this pipeline already clamp.
			const colNum = Math.max(0, parseInt(colStr, 10) - 1);

			if (lineNum >= 0) {
				const range = new vscode.Range(lineNum, colNum, lineNum, 200); // 200 is arbitrary end char
				const diagnostic = new vscode.Diagnostic(
					range,
					message.trim(),
					vscode.DiagnosticSeverity.Error,
				);
				diagnostic.source = "protobuf-aip-linter (syntax)";
				diagnostics.push(diagnostic);
			}
		}
	}

	if (outputChannel && diagnostics.length > 0) {
		outputChannel.appendLine(
			`Parsed ${diagnostics.length} syntax error(s) from text output`,
		);
	}

	return diagnostics;
};

/**
 * Parses buf/protoc-style stderr (file:line:col: message) and returns diagnostics
 * only for the given file. Paths in the output are resolved relative to cwd.
 */
export function parseSyntaxErrorsForFile(
	output: string,
	currentFileAbsolutePath: string,
	cwd: string,
): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const lines = output.split("\n");
	const errorRegex = SYNTAX_ERROR_REGEX;
	const normalizedCurrent = path.normalize(currentFileAbsolutePath);

	for (const line of lines) {
		const match = line.match(errorRegex);
		if (!match) {
			continue;
		}
		const filePathFromError = match[1].trim();
		const lineStr = match[2];
		const colStr = match[3];
		const message = match[4].trim();
		const resolvedPath = path.normalize(
			path.isAbsolute(filePathFromError)
				? filePathFromError
				: path.join(cwd, filePathFromError),
		);
		if (resolvedPath !== normalizedCurrent) {
			continue;
		}

		const lineNum = parseInt(lineStr, 10) - 1;
		// A reported line of 0 converts to -1, which `vscode.Position` rejects by
		// throwing. This runs inside the `close` handler of the syntax check, so
		// the throw escaped into an event callback and left that promise for ever
		// unsettled -- the check simply never returned. The by-file parser in
		// linterProvider already skips such a line.
		if (lineNum < 0) {
			continue;
		}
		const colNum = Math.max(0, parseInt(colStr, 10) - 1);
		const range = new vscode.Range(
			lineNum,
			colNum,
			lineNum,
			Math.max(colNum + 1, 200),
		);
		const diagnostic = new vscode.Diagnostic(
			range,
			message,
			vscode.DiagnosticSeverity.Error,
		);
		diagnostic.source = "protobuf-aip-linter (syntax)";
		diagnostics.push(diagnostic);
	}
	return diagnostics;
}

/**
 * Runs `buf build` to detect proto syntax errors and returns diagnostics for the given file.
 * Uses gapi.bufPath for the buf binary. No-op if buf is not available.
 */
export async function runBufSyntaxCheck(
	fileAbsolutePath: string,
	outputChannel?: vscode.OutputChannel,
): Promise<vscode.Diagnostic[]> {
	const bufPath = vscode.workspace
		.getConfiguration("gapi")
		.get<string>("bufPath", "buf");
	const workspaceFolders = vscode.workspace.workspaceFolders;
	const cwd =
		workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(fileAbsolutePath);

	return new Promise((resolve) => {
		const child = cp.spawn(bufPath, ["build"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", () => resolve([]));
		child.on("close", (code) => {
			if (code === 0) {
				resolve([]);
				return;
			}
			const diagnostics = parseSyntaxErrorsForFile(
				stderr,
				fileAbsolutePath,
				cwd,
			);
			if (outputChannel && diagnostics.length > 0) {
				outputChannel.appendLine(
					`Buf syntax check: ${diagnostics.length} error(s) in ${path.basename(fileAbsolutePath)}`,
				);
			}
			resolve(diagnostics);
		});
	});
}

/**
 * Creates a VS Code Diagnostic from a linter problem.
 * @param problem - The linter problem to convert
 * @returns A VS Code Diagnostic object
 */
const createDiagnosticFromProblem = (
	problem: LinterProblem,
): vscode.Diagnostic => {
	const startLine = Math.max(
		0,
		problem.location.start_position.line_number - 1,
	);
	const startChar = Math.max(
		0,
		problem.location.start_position.column_number - 1,
	);
	const endLine = Math.max(0, problem.location.end_position.line_number - 1);
	const endChar = Math.max(0, problem.location.end_position.column_number - 1);

	const diagnostic = new vscode.Diagnostic(
		new vscode.Range(startLine, startChar, endLine, endChar),
		problem.message,
		vscode.DiagnosticSeverity.Error,
	);

	diagnostic.source = "protobuf-aip-linter";

	// Use configurable documentation endpoint
	const config = vscode.workspace.getConfiguration("gapi");
	const baseUrl =
		config.get<string>("rulesDocumentationEndpoint") ||
		"https://linter.aip.dev";
	const ruleDocUri = problem.rule_doc_uri.replace(
		"https://linter.aip.dev",
		baseUrl,
	);

	diagnostic.code = {
		value: problem.rule_id,
		target: vscode.Uri.parse(ruleDocUri),
	};

	return diagnostic;
};
