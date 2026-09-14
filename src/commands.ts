import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { BinaryManager } from "./binaryManager";
import {
	CONFIG_FILE_NAME,
	CONFIG_TEMPLATE,
	WORKSPACE_PROTOBUF_YAML,
} from "./constants";
import type { ModuleGraph } from "./index/types";
import type { ApiLinterProvider } from "./linterProvider";
import { findProtoFiles, getActiveProtoEditor } from "./utils/fileUtils";

const exec = promisify(cp.exec);

/** Resolved `gapi.bufPath` setting (defaults to `buf` on PATH). */
const getBufPath = (): string =>
	vscode.workspace.getConfiguration("gapi").get<string>("bufPath", "buf");

/**
 * Runs a single `buf format -w <target>` process.
 * @param bufPath - Path to the buf binary
 * @param target - File or directory to format in place
 * @param cwd - Working directory for the child process (module root)
 */
const runBufFormatWrite = (
	bufPath: string,
	target: string,
	cwd?: string,
): Promise<void> =>
	new Promise((resolve, reject) => {
		cp.execFile(
			bufPath,
			["format", "-w", target],
			{ cwd, maxBuffer: 10 * 1024 * 1024 },
			(err, _stdout, stderr) => {
				if (err) {
					const detail = typeof stderr === "string" ? stderr.trim() : "";
					reject(new Error(detail || err.message));
				} else {
					resolve();
				}
			},
		);
	});

/** True when `child` is `parent` or lives underneath it. */
const isUnder = (child: string, parent: string): boolean => {
	const c = path.resolve(child);
	const p = path.resolve(parent);
	return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

/**
 * Removes roots that are already covered by an ancestor root. `buf format -w <dir>`
 * walks the whole subtree, so formatting a parent also formats every nested module;
 * keeping both would run the same files twice.
 */
const dropNestedRoots = (roots: readonly string[]): string[] => {
	const unique = [...new Set(roots.map((r) => path.resolve(r)))].sort(
		(a, b) => a.length - b.length,
	);
	const kept: string[] = [];
	for (const root of unique) {
		if (!kept.some((k) => isUnder(root, k))) {
			kept.push(root);
		}
	}
	return kept;
};

/**
 * Directories that own a buf module, deduplicated and de-nested.
 * Prefers the shared {@link ModuleGraph} when the integrator supplies one; otherwise
 * discovers `buf.yaml` files directly (a glob, never `openTextDocument`).
 */
const discoverModuleRoots = async (
	moduleGraph?: ModuleGraph,
): Promise<string[]> => {
	const fromGraph = moduleGraph?.modules().map((m) => m.root) ?? [];
	if (fromGraph.length > 0) {
		return dropNestedRoots(fromGraph);
	}
	const configs = await vscode.workspace.findFiles(
		"**/buf.yaml",
		"**/node_modules/**",
	);
	return dropNestedRoots(configs.map((uri) => path.dirname(uri.fsPath)));
};

/** Open `.proto` documents backed by a real file under one of `roots` (or all, when omitted). */
const openProtoDocumentsUnder = (
	roots?: readonly string[],
): vscode.TextDocument[] =>
	vscode.workspace.textDocuments.filter(
		(doc) =>
			!doc.isClosed &&
			!doc.isUntitled &&
			doc.uri.scheme === "file" &&
			doc.uri.fsPath.endsWith(".proto") &&
			(roots === undefined ||
				roots.some((root) => isUnder(doc.uri.fsPath, root))),
	);

/**
 * `buf format -w` rewrites files on disk. An open buffer with unsaved edits is not
 * visible to it, and reverting afterwards would throw those edits away — so flush
 * them first, with the user's consent.
 * @returns false when the user cancelled; true when it is safe to format.
 */
const flushDirtyDocuments = async (
	docs: readonly vscode.TextDocument[],
): Promise<boolean> => {
	const dirty = docs.filter((doc) => doc.isDirty);
	if (dirty.length === 0) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		`${dirty.length} open .proto file(s) have unsaved changes. \`buf format -w\` rewrites files on disk, so those buffers must be saved first or their edits would be lost.`,
		{ modal: true },
		"Save and Format",
	);
	if (choice !== "Save and Format") {
		return false;
	}
	// Bounded by the number of OPEN editors, not by workspace size — these documents
	// already exist, so no `openTextDocument` call is made here.
	for (const doc of dirty) {
		await doc.save();
	}
	return true;
};

/**
 * Re-reads formatted content into already-open editors.
 *
 * WHY revert and not `doc.save()`: the old code saved each document *after* the
 * on-disk rewrite, which pushed the stale pre-format buffer straight back over the
 * file buf had just formatted — it silently undid the format for every open file.
 * The correct direction is disk → buffer. Every document here was saved by
 * {@link flushDirtyDocuments} first, so it is clean and a revert cannot discard work
 * even if VS Code applies the command to the active editor rather than the passed URI.
 */
const revertOpenDocuments = async (
	docs: readonly vscode.TextDocument[],
): Promise<void> => {
	for (const doc of docs) {
		try {
			await vscode.commands.executeCommand(
				"workbench.action.files.revert",
				doc.uri,
			);
		} catch {
			// Non-fatal: VS Code also reloads clean editors from disk on its own.
		}
	}
};

/**
 * Creates the command to lint the currently active proto file.
 * @param linterProvider - The linter provider instance
 * @returns Disposable command registration
 */
export const createLintCurrentFileCommand = (
	linterProvider: ApiLinterProvider,
) => {
	return vscode.commands.registerCommand(
		"googleApiLinter.lintCurrentFile",
		async () => {
			const editor = getActiveProtoEditor();
			if (editor) {
				console.log(
					"Linting:",
					editor.document.fileName,
					"Language:",
					editor.document.languageId,
				);
				await linterProvider.lintDocument(editor.document);
			} else {
				vscode.window.showWarningMessage("Please open a .proto file to lint.");
			}
		},
	);
};

/**
 * Creates the command to lint all proto files in the workspace.
 * @param linterProvider - The linter provider instance
 * @returns Disposable command registration
 */
export const createLintWorkspaceCommand = (
	linterProvider: ApiLinterProvider,
) => {
	return vscode.commands.registerCommand(
		"googleApiLinter.lintWorkspace",
		async () => {
			await linterProvider.lintWorkspace();
		},
	);
};

/**
 * Command run from Proto view context menu: lint the selected file node.
 */
export const createLintFileFromTreeCommand = (
	linterProvider: ApiLinterProvider,
) => {
	return vscode.commands.registerCommand(
		"googleApiLinter.lintFileFromTree",
		async (element: unknown) => {
			if (
				element &&
				typeof element === "object" &&
				"kind" in element &&
				(element as { kind: string }).kind === "file" &&
				"uri" in element
			) {
				const uri = (element as { uri: vscode.Uri }).uri;
				if (uri?.fsPath.endsWith(".proto")) {
					await linterProvider.lintUri(uri);
				}
			}
		},
	);
};

/**
 * Command run from Proto view context menu: format the selected file node with buf format -w.
 */
export const createFormatFileFromTreeCommand = () => {
	return vscode.commands.registerCommand(
		"googleApiLinter.formatFileFromTree",
		async (element: unknown) => {
			if (
				element &&
				typeof element === "object" &&
				"kind" in element &&
				(element as { kind: string }).kind === "file" &&
				"uri" in element
			) {
				const uri = (element as { uri: vscode.Uri }).uri;
				if (!uri?.fsPath.endsWith(".proto")) {
					return;
				}
				const filePath = uri.fsPath;
				try {
					// Single file stays a single process — that is already the right shape here.
					const open = openProtoDocumentsUnder().filter(
						(d) => d.uri.toString() === uri.toString(),
					);
					if (!(await flushDirtyDocuments(open))) {
						return;
					}
					await runBufFormatWrite(
						getBufPath(),
						filePath,
						path.dirname(filePath),
					);
					await revertOpenDocuments(open);
					vscode.window.showInformationMessage(
						`Formatted ${vscode.workspace.asRelativePath(uri)}`,
					);
				} catch (e) {
					vscode.window.showErrorMessage(
						`Format failed: ${e instanceof Error ? e.message : String(e)}`,
					);
				}
			}
		},
	);
};

/**
 * Creates the command to format all proto files in the workspace.
 *
 * One `buf format -w` process per MODULE (a directory owning a `buf.yaml`), not per
 * file. Measured on protobuf-fhir (9,280 protos): per-file is ~1.33 s × 9,280 ≈ 3.4 h
 * because process startup dominates; a single whole-tree invocation is 1.84 s.
 * Falls back to one process per workspace folder when no module is found.
 *
 * @param moduleGraph - Optional shared module graph; when omitted, `buf.yaml` files
 *   are discovered with a workspace glob.
 * @returns Disposable command registration
 */
export const createFormatAllProtosCommand = (moduleGraph?: ModuleGraph) => {
	return vscode.commands.registerCommand(
		"googleApiLinter.formatAllProtos",
		async () => {
			const protoUris = await findProtoFiles();
			if (protoUris.length === 0) {
				vscode.window.showInformationMessage(
					"No .proto files found in workspace.",
				);
				return;
			}

			const moduleRoots = await discoverModuleRoots(moduleGraph);
			const usingModules = moduleRoots.length > 0;
			const targets = usingModules
				? moduleRoots
				: dropNestedRoots(
						(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
					);
			if (targets.length === 0) {
				vscode.window.showWarningMessage(
					"No buf module or workspace folder found to format.",
				);
				return;
			}

			// Attribute files to targets by longest-prefix match, so the final count is
			// the real number of files each invocation rewrote — not a per-process tally.
			const counts = new Map<string, number>(targets.map((t) => [t, 0]));
			let uncovered = 0;
			for (const uri of protoUris) {
				let best: string | undefined;
				for (const target of targets) {
					if (
						isUnder(uri.fsPath, target) &&
						(best === undefined || target.length > best.length)
					) {
						best = target;
					}
				}
				if (best === undefined) {
					uncovered++;
				} else {
					counts.set(best, (counts.get(best) ?? 0) + 1);
				}
			}

			const affectedDocs = openProtoDocumentsUnder(targets);
			if (!(await flushDirtyDocuments(affectedDocs))) {
				return;
			}

			const bufPath = getBufPath();
			const failures: string[] = [];
			let formatted = 0;
			let succeededTargets = 0;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: usingModules
						? `Formatting ${protoUris.length} proto file(s) in ${targets.length} module(s)`
						: `Formatting ${protoUris.length} proto file(s)`,
					cancellable: false,
				},
				async (progress) => {
					for (let i = 0; i < targets.length; i++) {
						const target = targets[i];
						const label = vscode.workspace.asRelativePath(target) || target;
						progress.report({
							message: `${i + 1}/${targets.length}: ${label}`,
						});
						try {
							// `.` with cwd = the module root, so buf resolves that module's buf.yaml.
							await runBufFormatWrite(bufPath, ".", target);
							formatted += counts.get(target) ?? 0;
							succeededTargets++;
						} catch (e) {
							failures.push(
								`${label}: ${e instanceof Error ? e.message : String(e)}`,
							);
						}
					}
				},
			);

			await revertOpenDocuments(affectedDocs);

			const scope = usingModules
				? `${succeededTargets}/${targets.length} module(s)`
				: `${succeededTargets}/${targets.length} workspace folder(s)`;
			const skipped =
				uncovered > 0
					? ` ${uncovered} file(s) outside any buf module were skipped.`
					: "";
			if (failures.length > 0) {
				vscode.window.showWarningMessage(
					`Formatted ${formatted} proto file(s) across ${scope}.${skipped} ${failures.length} failed: ${failures[0]}`,
				);
			} else {
				vscode.window.showInformationMessage(
					`Formatted ${formatted} proto file(s) across ${scope} with \`buf format -w\`.${skipped}`,
				);
			}
		},
	);
};

/**
 * Creates the command to generate a .api-linter.yaml configuration file.
 * @returns Disposable command registration
 */
export const createConfigCommand = () => {
	return vscode.commands.registerCommand(
		"googleApiLinter.createConfig",
		async () => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}

			const configPath = vscode.Uri.joinPath(
				workspaceFolders[0].uri,
				CONFIG_FILE_NAME,
			);
			await vscode.workspace.fs.writeFile(
				configPath,
				Buffer.from(CONFIG_TEMPLATE, "utf8"),
			);
			const doc = await vscode.workspace.openTextDocument(configPath);
			await vscode.window.showTextDocument(doc);
			vscode.window.showInformationMessage(
				`Created ${CONFIG_FILE_NAME} config file`,
			);
		},
	);
};

/** Minimal content for workspace.protobuf.yaml (enables extension and proto paths). */
const WORKSPACE_PROTOBUF_YAML_TEMPLATE = `# Proto workspace config (Protobuf AIP Linter)
# See: https://github.com/the-protobuf-project/google-api-linter-vscode

# Optional: list of directories containing .proto files (default: this directory)
# proto_path: .

# Optional: folders and files the linter skips entirely. A bare directory name
# covers everything under it; * and ** work as usual.
# exclude:
#   - vendor
#   - third_party
#   - "**/*.pb.proto"
`;

/**
 * Creates the command to initialize a Proto workspace (creates workspace.protobuf.yaml).
 * @returns Disposable command registration
 */
export const createInitWorkspaceCommand = () => {
	return vscode.commands.registerCommand(
		"googleApiLinter.initWorkspace",
		async (folderUri?: vscode.Uri) => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders?.length) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}
			const targetFolder = folderUri ?? workspaceFolders[0].uri;
			const yamlPath = vscode.Uri.joinPath(
				targetFolder,
				WORKSPACE_PROTOBUF_YAML,
			);
			try {
				await vscode.workspace.fs.writeFile(
					yamlPath,
					Buffer.from(WORKSPACE_PROTOBUF_YAML_TEMPLATE, "utf8"),
				);
				const doc = await vscode.workspace.openTextDocument(yamlPath);
				await vscode.window.showTextDocument(doc);
				vscode.window.showInformationMessage(
					`Created ${WORKSPACE_PROTOBUF_YAML}. Proto workspace ready.`,
				);
			} catch (e) {
				vscode.window.showErrorMessage(
					`Failed to create ${WORKSPACE_PROTOBUF_YAML}: ${e}`,
				);
			}
		},
	);
};

/**
 * Creates the command to restart the linter and re-lint all open proto files.
 * @param diagnosticCollection - The diagnostic collection to clear
 * @param linterProvider - The linter provider instance
 * @returns Disposable command registration
 */
export const createRestartCommand = (
	diagnosticCollection: vscode.DiagnosticCollection,
	linterProvider: ApiLinterProvider,
) => {
	return vscode.commands.registerCommand(
		"googleApiLinter.restart",
		async () => {
			diagnosticCollection.clear();
			vscode.window.showInformationMessage(
				"Protobuf AIP Linter restarted. Re-linting all open proto files...",
			);

			for (const editor of vscode.window.visibleTextEditors) {
				if (editor.document.fileName.endsWith(".proto")) {
					await linterProvider.lintDocument(editor.document);
				}
			}

			vscode.window.showInformationMessage(
				"Protobuf AIP Linter restart complete!",
			);
		},
	);
};

/**
 * Creates the command to update googleapis commit in workspace .gapi directory.
 * @returns Disposable command registration
 */
export const createUpdateGoogleapisCommitCommand = () => {
	return vscode.commands.registerCommand(
		"googleApiLinter.updateGoogleapisCommit",
		async () => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders) {
				vscode.window.showErrorMessage("No workspace folder open");
				return;
			}

			const commitHash = await vscode.window.showInputBox({
				prompt: "Enter googleapis commit hash (leave empty for latest)",
				placeHolder: "e.g., abc123def456 or leave empty",
				validateInput: (value) => {
					if (value && !/^[a-f0-9]{7,40}$/i.test(value)) {
						return "Invalid commit hash format. Must be 7-40 hexadecimal characters.";
					}
					return null;
				},
			});

			if (commitHash === undefined) {
				return;
			}

			const gapiDir = path.join(workspaceFolders[0].uri.fsPath, ".gapi");
			const googleapisDir = path.join(gapiDir, "googleapis");

			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Downloading googleapis",
						cancellable: false,
					},
					async (progress) => {
						progress.report({ message: "Checking buf CLI..." });

						try {
							await exec("buf --version");
						} catch {
							vscode.window.showErrorMessage(
								"buf CLI not found. Please install it first: https://buf.build/docs/installation",
							);
							return;
						}

						progress.report({ message: "Creating .gapi directory..." });
						await vscode.workspace.fs.createDirectory(vscode.Uri.file(gapiDir));

						progress.report({ message: "Exporting googleapis protos..." });
						const bufRef = commitHash
							? `buf.build/googleapis/googleapis:${commitHash}`
							: "buf.build/googleapis/googleapis";
						const command = `buf export ${bufRef} --output "${googleapisDir}"`;

						try {
							await exec(command);
						} catch (error) {
							throw new Error(
								`Failed to export googleapis: ${error}. Check if commit hash is valid.`,
							);
						}

						const commitInfo = commitHash
							? ` (commit: ${commitHash})`
							: " (latest)";
						vscode.window.showInformationMessage(
							`googleapis${commitInfo} downloaded to ${path.relative(workspaceFolders[0].uri.fsPath, googleapisDir)}`,
						);

						const updateConfig = await vscode.window.showInformationMessage(
							"Update workspace settings to use downloaded googleapis?",
							"Yes",
							"No",
						);

						if (updateConfig === "Yes") {
							const config = vscode.workspace.getConfiguration("gapi");
							const currentProtoPaths = config.get<string[]>("protoPath", []);
							const newPath = `\${workspaceFolder}/.gapi/googleapis`;

							if (!currentProtoPaths.includes(newPath)) {
								await config.update(
									"protoPath",
									[...currentProtoPaths, newPath],
									vscode.ConfigurationTarget.Workspace,
								);
								vscode.window.showInformationMessage(
									"Workspace settings updated!",
								);
							}
						}
					},
				);
			} catch (error) {
				vscode.window.showErrorMessage(
					`Failed to download googleapis: ${error}`,
				);
			}
		},
	);
};

/**
 * Creates the command to reinstall all Protobuf AIP Linter dependencies.
 * Deletes the .gapi directory and reinstalls api-linter, googleapis, and protobuf.
 * @param binaryManager - The binary manager instance
 * @returns Disposable command registration
 */
export const createReinstallCommand = (binaryManager: BinaryManager) => {
	return vscode.commands.registerCommand(
		"googleApiLinter.reinstallAll",
		async () => {
			const confirm = await vscode.window.showWarningMessage(
				"This will delete the .gapi directory and reinstall all dependencies (api-linter, googleapis, protobuf). Continue?",
				{ modal: true },
				"Yes",
				"No",
			);

			if (confirm !== "Yes") {
				return;
			}

			try {
				const gapiDir = path.join(os.homedir(), ".gapi");

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Reinstalling Protobuf AIP Linter dependencies",
						cancellable: false,
					},
					async (progress) => {
						// Delete .gapi directory
						progress.report({ message: "Deleting .gapi directory..." });
						if (fs.existsSync(gapiDir)) {
							await fs.promises.rm(gapiDir, { recursive: true, force: true });
						}

						// Reinstall api-linter
						progress.report({ message: "Downloading api-linter binary..." });
						await binaryManager.ensureBinary();

						// Reinstall googleapis
						progress.report({ message: "Downloading googleapis..." });
						await binaryManager.ensureGoogleapis();

						// Reinstall protobuf
						progress.report({ message: "Downloading protobuf..." });
						await binaryManager.ensureProtobuf();

						vscode.window.showInformationMessage(
							"Successfully reinstalled all Protobuf AIP Linter dependencies!",
						);
					},
				);
			} catch (error) {
				vscode.window.showErrorMessage(
					`Failed to reinstall dependencies: ${error}`,
				);
			}
		},
	);
};
