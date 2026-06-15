import * as path from "node:path";
import * as vscode from "vscode";
import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	TransportKind,
} from "vscode-languageclient/node";
import { EXTENSION_NAME, PROTO_FILE_PATTERN } from "./constants";
import { findProtoFiles, getActiveProtoEditor } from "./utils/fileUtils";

let client: LanguageClient;

/**
 * Activates the LSP-based Google API Linter extension.
 * Starts the language server and registers commands.
 * @param context - The extension context provided by VS Code
 */
export function activate(context: vscode.ExtensionContext) {
	console.log(`${EXTENSION_NAME} LSP extension activating...`);

	const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
	console.log("Server module path:", serverModule);

	const serverOptions = createServerOptions(serverModule);
	const clientOptions = createClientOptions();

	client = new LanguageClient(
		"googleApiLinter",
		EXTENSION_NAME,
		serverOptions,
		clientOptions,
	);

	startLanguageServer();
	registerCommands(context);
}

/**
 * Creates server options for the language server.
 * @param serverModule - Path to the server module
 * @returns Server options configuration
 */
function createServerOptions(serverModule: string): ServerOptions {
	return {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ["--nolazy", "--inspect=6009"] },
		},
	};
}

/**
 * Creates client options for the language client.
 * @returns Client options configuration
 */
function createClientOptions(): LanguageClientOptions {
	const outputChannel = vscode.window.createOutputChannel(
		"Google API Linter Language Server",
	);

	return {
		documentSelector: [
			{ scheme: "file", language: "proto3" },
			{ scheme: "file", language: "protobuf" },
			{ scheme: "file", pattern: PROTO_FILE_PATTERN },
		],
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher(PROTO_FILE_PATTERN),
		},
		outputChannel: outputChannel as unknown as vscode.LogOutputChannel,
		revealOutputChannelOn: 4, // RevealOutputChannelOn.Never - only show when user opens it
	};
}

/**
 * Starts the language server and handles initialization.
 */
function startLanguageServer(): void {
	console.log("Starting Language Server...");
	client
		.start()
		.then(() => {
			console.log("Language Server started successfully");
			vscode.window.showInformationMessage(`${EXTENSION_NAME} LSP activated`);
		})
		.catch((error) => {
			console.error("Failed to start Language Server:", error);
			vscode.window.showErrorMessage(
				`Failed to start ${EXTENSION_NAME}: ${error}`,
			);
		});
}

/**
 * Registers extension commands.
 * @param context - The extension context
 */
function registerCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"googleApiLinter.lintCurrentFile",
			lintCurrentFile,
		),
		vscode.commands.registerCommand(
			"googleApiLinter.lintWorkspace",
			lintWorkspace,
		),
	);
}

/**
 * Command handler to lint the currently active proto file.
 */
async function lintCurrentFile(): Promise<void> {
	const editor = getActiveProtoEditor();
	if (editor) {
		console.log(
			"Linting file:",
			editor.document.fileName,
			"Language ID:",
			editor.document.languageId,
		);
		await vscode.workspace.save(editor.document.uri);
		vscode.window.showInformationMessage("Linting current file...");
	} else {
		vscode.window.showWarningMessage("Please open a .proto file to lint.");
	}
}

/**
 * Command handler to lint all proto files in the workspace.
 */
async function lintWorkspace(): Promise<void> {
	const protoFiles = await findProtoFiles();

	if (protoFiles.length === 0) {
		vscode.window.showInformationMessage("No .proto files found in workspace.");
		return;
	}

	vscode.window.showInformationMessage(
		`Linting ${protoFiles.length} proto file(s)...`,
	);

	for (const fileUri of protoFiles) {
		await vscode.workspace.save(fileUri);
	}

	vscode.window.showInformationMessage("Workspace linting completed.");
}

/**
 * Deactivates the extension and stops the language server.
 * @returns Promise that resolves when the server has stopped
 */
export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
