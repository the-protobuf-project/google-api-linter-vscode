import * as vscode from "vscode";
import { registerAnnotationSupport } from "./annotations/support";
import { ProtoCodeActionProvider } from "./codeActionProvider";
import {
	createConfigCommand,
	createFormatAllProtosCommand,
	createFormatFileFromTreeCommand,
	createInitWorkspaceCommand,
	createLintCurrentFileCommand,
	createLintFileFromTreeCommand,
	createLintWorkspaceCommand,
	createReinstallCommand,
	createRestartCommand,
	createUpdateGoogleapisCommitCommand,
} from "./commands";
import { ProtoCompletionProvider } from "./completionProvider";
import { registerConfigValidation } from "./configValidator";
import {
	DIAGNOSTIC_SOURCE,
	EXTENSION_NAME,
	OUTPUT_CHANNEL_NAME,
} from "./constants";
import { ProtoDefinitionProvider } from "./definitionProvider";
import { ProtoDocumentLinkProvider } from "./documentLinkProvider";
import { ProtoDocumentSymbolProvider } from "./documentSymbolProvider";
import { ProtoFoldingRangeProvider } from "./foldingProvider";
import { getFormatEdits, registerFormatProvider } from "./formatProvider";
import { ApiLinterHoverProvider } from "./hoverProvider";
import { createProtoIndex } from "./index";
import type { IndexBudget, ProtoIndex } from "./index/types";
import { ApiLinterProvider } from "./linterProvider";
import { registerProtoView } from "./protoView";
import { ProtoReferenceProvider } from "./referenceProvider";
import { ProtoRenameProvider } from "./renameProvider";
import { registerReportIssueCommand } from "./reportIssue";
import { ProtoSignatureHelpProvider } from "./signatureHelpProvider";
import { registerStatusBar } from "./statusBar";
import { ProtoSymbolHoverProvider } from "./symbolHoverProvider";
import { isProtoFile } from "./utils/fileUtils";
import {
	getBufModuleCacheRoot,
	getModuleGraph,
	invalidateModuleGraphCache,
} from "./utils/moduleGraph";
import { invalidateProtoImportRootsCache } from "./utils/protoImportRoots";
import { ProtoWorkspaceSymbolProvider } from "./workspaceSymbolProvider";

let diagnosticCollection: vscode.DiagnosticCollection;
let linterProvider: ApiLinterProvider;
let protoIndex: ProtoIndex | undefined;

/** Reads the index budget from settings, so a big monorepo can raise it. */
function readIndexBudget(): IndexBudget {
	const config = vscode.workspace.getConfiguration("gapi");
	return {
		maxMemoryMB: config.get<number>("index.maxMemoryMB", 150),
		maxFiles: config.get<number>("index.maxFiles", 20000),
	};
}

/**
 * Directories holding the annotation vocabularies (`mcp.v1`, `buf.validate`, …).
 * These live in the buf module cache rather than the workspace, so they have to
 * be handed to the index explicitly.
 */
async function annotationRootsFor(
	outputChannel: vscode.OutputChannel,
): Promise<string[]> {
	try {
		const graph = await getModuleGraph(outputChannel);
		const roots = graph
			.allProtoPaths()
			.filter((p) => p.startsWith(getBufModuleCacheRoot()));
		return [...new Set(roots)];
	} catch {
		return [];
	}
}

/**
 * Activates the Google API Linter extension.
 * Sets up providers, commands, and document listeners.
 * @param context - The extension context provided by VS Code
 */
export async function activate(context: vscode.ExtensionContext) {
	try {
		console.log(`${EXTENSION_NAME} extension is now active`);

		diagnosticCollection =
			vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
		const outputChannel =
			vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

		linterProvider = new ApiLinterProvider(diagnosticCollection, outputChannel);
		const binaryManager = linterProvider.getBinaryManager();

		const protoDocSelector = [
			{ scheme: "file", language: "proto3" },
			{ scheme: "file", language: "protobuf" },
		];

		// The index is created now but built in the background: activation must not
		// wait on a workspace walk. Every provider takes it as an optional trailing
		// argument and degrades to file-local behaviour until the build lands.
		const indexEnabled = vscode.workspace
			.getConfiguration("gapi")
			.get<boolean>("index.enabled", true);
		protoIndex = indexEnabled
			? createProtoIndex({
					budget: readIndexBudget(),
					annotationRoots: await annotationRootsFor(outputChannel),
					moduleRootOf: undefined,
					onDegrade: (tier, reason) => {
						outputChannel.appendLine(`[index] ${tier}: ${reason}`);
						// A ceiling the user can act on is worth interrupting for; a
						// silent stall is exactly the failure this replaces.
						void vscode.window.showWarningMessage(
							`Proto index reduced to "${tier}": ${reason}`,
						);
					},
				})
			: undefined;
		const index = protoIndex;

		const definitionProvider = new ProtoDefinitionProvider(index);
		context.subscriptions.push(
			diagnosticCollection,
			outputChannel,
			registerHoverProvider(diagnosticCollection),
			registerSymbolHoverProvider(protoDocSelector),
			registerDefinitionProvider(definitionProvider),
			registerReferenceProvider(protoDocSelector, index),
			registerRenameProvider(protoDocSelector, index),
			registerCodeActionProvider(protoDocSelector),
			registerDocumentLinkProvider(protoDocSelector),
			registerFormatProvider(protoDocSelector),
			registerDocumentSymbolProvider(protoDocSelector),
			registerWorkspaceSymbolProvider(index),
			registerFoldingProvider(protoDocSelector),
			registerCompletionProvider(protoDocSelector, index),
			registerSignatureHelpProvider(protoDocSelector),
		);
		context.subscriptions.push(createLintCurrentFileCommand(linterProvider));
		context.subscriptions.push(createLintWorkspaceCommand(linterProvider));
		context.subscriptions.push(
			createFormatAllProtosCommand(await getModuleGraph(outputChannel)),
		);
		context.subscriptions.push(createLintFileFromTreeCommand(linterProvider));
		context.subscriptions.push(createFormatFileFromTreeCommand());
		context.subscriptions.push(createConfigCommand());
		context.subscriptions.push(
			createRestartCommand(diagnosticCollection, linterProvider),
		);
		context.subscriptions.push(createUpdateGoogleapisCommitCommand());
		context.subscriptions.push(createReinstallCommand(binaryManager));
		context.subscriptions.push(createInitWorkspaceCommand());
		context.subscriptions.push(registerReportIssueCommand(context));

		registerProtoView(
			context,
			diagnosticCollection,
			() => binaryManager.getBinaryVersion(),
			() => binaryManager.getGoogleapisCommit(),
			() => binaryManager.getProtobufCommit(),
			(typeName: string, contextUri: vscode.Uri) =>
				definitionProvider.resolveTypeToLocation(typeName, contextUri),
			index,
			vscode.workspace
				.getConfiguration("gapi")
				.get<number>("protoView.maxFiles", 5000),
		);

		// Highlighting, hover, completion and diagnostics for every custom
		// annotation, derived from the extend blocks the index found.
		registerAnnotationSupport(context, index);

		// ApiLinterProvider owns a diagnostic collection, a debounce timer and
		// possibly a live buf process.
		context.subscriptions.push({ dispose: () => linterProvider.dispose() });

		if (index) {
			context.subscriptions.push({ dispose: () => index.dispose() });
			void buildIndex(index, outputChannel);

			// One watcher keeps the index current. Re-parsing a single file costs
			// well under a millisecond, so there is never a full rebuild here.
			const protoWatcher =
				vscode.workspace.createFileSystemWatcher("**/*.proto");
			protoWatcher.onDidChange((uri) => void index.update(uri.fsPath));
			protoWatcher.onDidCreate((uri) => void index.update(uri.fsPath));
			protoWatcher.onDidDelete((uri) => index.remove(uri.fsPath));
			context.subscriptions.push(protoWatcher);
		}

		registerStatusBar(context, diagnosticCollection);

		const configDiagnosticCollection =
			vscode.languages.createDiagnosticCollection(
				`${DIAGNOSTIC_SOURCE}-config`,
			);
		registerConfigValidation(context, configDiagnosticCollection);

		let documentListeners = registerDocumentListeners(context, linterProvider);
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("gapi")) {
					invalidateProtoImportRootsCache();
					invalidateModuleGraphCache();
					// Dynamically update listeners when config changes
					documentListeners.dispose();
					documentListeners = registerDocumentListeners(
						context,
						linterProvider,
					);
				}
			}),
		);
	} catch (error) {
		console.error("Failed to activate extension:", error);
		vscode.window.showErrorMessage(
			`${EXTENSION_NAME} failed to activate: ${error}`,
		);
	}
}

/**
 * Registers the hover provider for displaying rule documentation.
 * @param diagnosticCollection - The diagnostic collection to read from
 * @returns Disposable for the hover provider registration
 */
function registerHoverProvider(
	diagnosticCollection: vscode.DiagnosticCollection,
): vscode.Disposable {
	const hoverProvider = new ApiLinterHoverProvider(diagnosticCollection);
	return vscode.languages.registerHoverProvider(
		[
			{ scheme: "file", language: "proto3" },
			{ scheme: "file", language: "protobuf" },
		],
		hoverProvider,
	);
}

/**
 * Registers hover for proto symbols (message, service, enum, rpc) when no linter diagnostic at position.
 */
function registerSymbolHoverProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	return vscode.languages.registerHoverProvider(
		selector,
		new ProtoSymbolHoverProvider(),
	);
}

/**
 * Registers the definition provider for go-to-definition on proto types.
 * @returns Disposable for the definition provider registration
 */
function registerDefinitionProvider(
	definitionProvider: ProtoDefinitionProvider,
): vscode.Disposable {
	return vscode.languages.registerDefinitionProvider(
		[
			{ scheme: "file", language: "proto3" },
			{ scheme: "file", language: "protobuf" },
		],
		definitionProvider,
	);
}

/**
 * Registers find references for message/enum/service types.
 */
function registerReferenceProvider(
	selector: vscode.DocumentSelector,
	index?: ProtoIndex,
): vscode.Disposable {
	return vscode.languages.registerReferenceProvider(
		selector,
		new ProtoReferenceProvider(index),
	);
}

/**
 * Registers rename for message/service/enum/rpc; updates all references.
 */
function registerRenameProvider(
	selector: vscode.DocumentSelector,
	index?: ProtoIndex,
): vscode.Disposable {
	return vscode.languages.registerRenameProvider(
		selector,
		new ProtoRenameProvider(index),
	);
}

/**
 * Registers code actions: Add (google.api.http), Add (google.api.resource), Add UNSPECIFIED enum value.
 */
function registerCodeActionProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	return vscode.languages.registerCodeActionsProvider(
		selector,
		new ProtoCodeActionProvider(),
		{
			providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
		},
	);
}

/**
 * Registers document links for import "path/to/file.proto" (click to open).
 */
function registerDocumentLinkProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	return vscode.languages.registerDocumentLinkProvider(
		selector,
		new ProtoDocumentLinkProvider(),
	);
}

/**
 * Registers document outline (Outline view) for message, service, enum, rpc.
 */
function registerDocumentSymbolProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	return vscode.languages.registerDocumentSymbolProvider(
		selector,
		new ProtoDocumentSymbolProvider(),
	);
}

/**
 * Registers workspace symbol search (Go to Symbol in Workspace).
 */
function registerWorkspaceSymbolProvider(
	index?: ProtoIndex,
): vscode.Disposable {
	return vscode.languages.registerWorkspaceSymbolProvider(
		new ProtoWorkspaceSymbolProvider(index),
	);
}

/**
 * Registers folding for message, service, enum, oneof blocks.
 */
function registerFoldingProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	return vscode.languages.registerFoldingRangeProvider(
		selector,
		new ProtoFoldingRangeProvider(),
	);
}

/**
 * Registers the completion provider for type hints (messages, services, RPC, options).
 * @param selector - Document selector for proto files
 * @returns Disposable for the completion provider registration
 */
function registerCompletionProvider(
	selector: vscode.DocumentSelector,
	index?: ProtoIndex,
): vscode.Disposable {
	const completionProvider = new ProtoCompletionProvider(index);
	return vscode.languages.registerCompletionItemProvider(
		selector,
		completionProvider,
	);
}

/**
 * Registers the signature help provider for RPC and option(...) parameter hints.
 * @param selector - Document selector for proto files
 * @returns Disposable for the signature help provider registration
 */
function registerSignatureHelpProvider(
	selector: vscode.DocumentSelector,
): vscode.Disposable {
	const signatureHelpProvider = new ProtoSignatureHelpProvider();
	return vscode.languages.registerSignatureHelpProvider(
		selector,
		signatureHelpProvider,
		"(",
		",",
	);
}

/**
 * Registers document event listeners for auto-linting.
 * Handles save, change, open, and configuration change events.
 * @param _context - The extension context (reserved for future subscriptions)
 * @param linterProvider - The linter provider instance
 */
function registerDocumentListeners(
	_context: vscode.ExtensionContext,
	linterProvider: ApiLinterProvider,
): vscode.Disposable {
	const disposables: vscode.Disposable[] = [];
	const config = vscode.workspace.getConfiguration("gapi");
	const enableOnSave = config.get<boolean>("enableOnSave", true);
	const enableOnType = config.get<boolean>("enableOnType", false);
	const formatOnSave = config.get<boolean>("formatOnSave", true);

	// gapi.formatOnSave: format buffer before save (uses getFormatEdits; avoids stale disk with buf)
	if (formatOnSave) {
		disposables.push(
			vscode.workspace.onWillSaveTextDocument((event) => {
				if (!isProtoFile(event.document.fileName)) {
					return;
				}
				event.waitUntil(
					(async () => {
						const doc = event.document;
						const editorConfig = vscode.workspace.getConfiguration(
							"editor",
							doc.uri,
						);
						const options: vscode.FormattingOptions = {
							tabSize: editorConfig.get<number>("tabSize", 2),
							insertSpaces: editorConfig.get<boolean>("insertSpaces", true),
						};
						const edits = await getFormatEdits(doc, options);
						if (edits.length === 0) {
							return;
						}
						const edit = new vscode.WorkspaceEdit();
						for (const te of edits) {
							edit.replace(doc.uri, te.range, te.newText);
						}
						await vscode.workspace.applyEdit(edit);
					})(),
				);
			}),
		);
	}

	// Lint on save
	if (enableOnSave) {
		disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (isProtoFile(doc.fileName)) {
					linterProvider.lintDocument(doc);
				}
			}),
		);
	}

	// Per-file lint no longer shells out to buf, so syntax errors come only from
	// this workspace pass. It is debounced and self-coalescing, so firing it on
	// every save collapses a burst into a single `buf build`.
	disposables.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (isProtoFile(doc.fileName)) {
				linterProvider.scheduleWorkspaceSyntaxCheck();
			}
		}),
	);

	// Lint on open
	disposables.push(
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (isProtoFile(doc.fileName)) {
				linterProvider.lintDocument(doc, false, true);
			}
		}),
	);

	// Lint on type (debounced)
	if (enableOnType) {
		let timeout: NodeJS.Timeout | undefined;
		disposables.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (isProtoFile(e.document.fileName)) {
					if (timeout) {
						clearTimeout(timeout);
					}
					timeout = setTimeout(() => {
						void linterProvider.lintDocument(e.document, false, true);
					}, 1000); // 1s debounce, silent (no progress spam)
				}
			}),
		);
	}

	// Initial lint if an editor is already active
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && isProtoFile(activeEditor.document.fileName)) {
		linterProvider.lintDocument(activeEditor.document, false, true);
	}

	return vscode.Disposable.from(...disposables);
}

/**
 * Deactivates the extension and cleans up resources.
 */
export function deactivate() {
	if (diagnosticCollection) {
		diagnosticCollection.clear();
		diagnosticCollection.dispose();
	}

	// Nothing to clean up for buf any more: dependencies resolve by reading
	// buf.lock and pointing at the module cache, so no temp tree is ever created.
	protoIndex?.dispose();
	protoIndex = undefined;
}

/**
 * Builds the index in the background and reports the outcome.
 *
 * Kept off the activation path deliberately: a cold walk of a large workspace
 * is measured in hundreds of milliseconds, and blocking activation on it would
 * trade one stall for another.
 */
async function buildIndex(
	index: ProtoIndex,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const roots = (vscode.workspace.workspaceFolders ?? []).map(
		(f) => f.uri.fsPath,
	);
	if (roots.length === 0) {
		return;
	}
	try {
		const stats = await index.build(roots);
		outputChannel.appendLine(
			`[index] ${stats.tier}: ${stats.symbolCount} symbol(s) in ${stats.fileCount} file(s), ` +
				`${stats.annotationCount} annotation(s), ${stats.buildMs}ms`,
		);
		if (stats.tier === "onDemand") {
			outputChannel.appendLine(
				"[index] workspace-wide features are off; per-file features still work",
			);
		}
	} catch (error) {
		outputChannel.appendLine(`[index] build failed: ${error}`);
	}
}
