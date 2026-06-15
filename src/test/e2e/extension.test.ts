import * as path from "node:path";
import * as vscode from "vscode";

/**
 * End-to-end tests run inside the Extension Development Host
 * with the smoke_test/protobuf workspace loaded.
 */
export async function run(): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		throw new Error(
			"Expected a workspace folder (smoke_test/protobuf) to be open",
		);
	}

	// 1. Extension should see workspace with workspace.protobuf.yaml (activation)
	const protobufYaml = path.join(workspaceRoot, "workspace.protobuf.yaml");
	const yamlUri = vscode.Uri.file(protobufYaml);
	try {
		await vscode.workspace.fs.stat(yamlUri);
	} catch {
		throw new Error(
			`Expected workspace to contain workspace.protobuf.yaml at ${protobufYaml}`,
		);
	}

	// 2. Open a .proto file and get document symbols (outline)
	const protoPath = path.join(
		workspaceRoot,
		"the-protobuf-project",
		"service",
		"service.proto",
	);
	const doc = await vscode.workspace.openTextDocument(protoPath);
	if (doc.languageId !== "proto3" && doc.languageId !== "protobuf") {
		throw new Error(
			`Expected .proto file to have language proto3 or protobuf, got ${doc.languageId}`,
		);
	}

	const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
		"vscode.executeDocumentSymbolProvider",
		doc.uri,
	);
	if (!Array.isArray(symbols) || symbols.length === 0) {
		throw new Error(
			"Expected document symbol provider to return at least one symbol (e.g. service TodoService)",
		);
	}

	const hasService = symbols.some(
		(s) => s.name === "TodoService" && s.kind === vscode.SymbolKind.Interface,
	);
	if (!hasService) {
		throw new Error(
			`Expected a document symbol "TodoService" (service), got: ${symbols.map((s) => s.name).join(", ")}`,
		);
	}

	// 3. Completion provider: request completions at a position
	const position = new vscode.Position(0, 0);
	const completions =
		await vscode.commands.executeCommand<vscode.CompletionList>(
			"vscode.executeCompletionItemProvider",
			doc.uri,
			position,
		);
	if (!completions?.items?.length) {
		throw new Error("Expected completion provider to return at least one item");
	}

	// 4. Smoke test: run all extension commands (must not throw)
	const extensionCommands = [
		"googleApiLinter.lintCurrentFile",
		"googleApiLinter.lintWorkspace",
		"googleApiLinter.formatAllProtos",
		"googleApiLinter.refreshProtoView",
		"googleApiLinter.collapseAll",
		"googleApiLinter.lintFileFromTree",
		"googleApiLinter.formatFileFromTree",
		"googleApiLinter.reportIssue",
	];
	for (const cmd of extensionCommands) {
		try {
			await vscode.commands.executeCommand(cmd);
		} catch (e) {
			throw new Error(
				`Command ${cmd} threw: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// revealLocation needs (uri, range); call with doc we have — should not throw
	try {
		await vscode.commands.executeCommand(
			"googleApiLinter.revealLocation",
			doc.uri,
			new vscode.Range(0, 0, 0, 0),
		);
	} catch (e) {
		throw new Error(
			`googleApiLinter.revealLocation threw: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// Optional/contextual commands: execute without side-effect checks (may show dialogs or no-op)
	const optionalCommands = [
		"googleApiLinter.createConfig",
		"googleApiLinter.initWorkspace",
		"googleApiLinter.restart",
		"googleApiLinter.updateGoogleapisCommit",
		"googleApiLinter.reinstallAll",
	];
	for (const cmd of optionalCommands) {
		try {
			await vscode.commands.executeCommand(cmd);
		} catch (e) {
			// Allow cancellation or expected failures (e.g. no selection, dialog cancelled)
			console.log(
				`Optional command ${cmd}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	console.log(
		"E2E: extension activated, document symbols, completions, and command smoke tests OK",
	);
}
