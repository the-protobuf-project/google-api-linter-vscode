import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const CONFIG_DIAGNOSTIC_SOURCE = "protobuf-aip-linter (config)";

const KNOWN_API_LINTER_KEYS = new Set([
	"included_paths",
	"excluded_paths",
	"disabled_rules",
	"enabled_rules",
	"proto_paths",
	"ignore_comment_disables",
	"descriptor_set_in",
]);

const KNOWN_WORKSPACE_PROTOBUF_KEYS = new Set([
	"proto_path",
	"proto_paths",
	"exclude",
	"excluded_paths",
]);

/**
 * Validate .api-linter.yaml: unknown keys, invalid proto_paths.
 */
function validateApiLinterYaml(
	document: vscode.TextDocument,
	configDir: string,
): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const text = document.getText();
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const keyMatch = line.match(/^\s*([a-z_][a-z0-9_]*)\s*:/i);
		if (keyMatch) {
			const key = keyMatch[1].trim();
			if (!KNOWN_API_LINTER_KEYS.has(key)) {
				diagnostics.push({
					range: new vscode.Range(
						i,
						keyMatch.index ?? 0,
						i,
						(keyMatch.index ?? 0) + key.length,
					),
					message: `Unknown key "${key}". Known keys: ${[...KNOWN_API_LINTER_KEYS].join(", ")}.`,
					severity: vscode.DiagnosticSeverity.Warning,
					source: CONFIG_DIAGNOSTIC_SOURCE,
				});
			}
			if (key === "proto_paths") {
				const listMatch = line.match(/proto_paths\s*:\s*$/);
				if (listMatch) {
					for (let j = i + 1; j < lines.length; j++) {
						const listLine = lines[j];
						if (/^\s*-\s*["']?([^"'\n]+)["']?\s*$/.test(listLine)) {
							const pathMatch = listLine.match(/-\s*["']?([^"'\n]+)["']?/);
							if (pathMatch) {
								const rawPath = pathMatch[1].trim();
								const resolved = path.resolve(configDir, rawPath);
								if (!fs.existsSync(resolved)) {
									const start = listLine.indexOf(pathMatch[1]);
									diagnostics.push({
										range: new vscode.Range(
											j,
											start,
											j,
											start + pathMatch[1].length,
										),
										message: `Path does not exist: ${resolved}`,
										severity: vscode.DiagnosticSeverity.Warning,
										source: CONFIG_DIAGNOSTIC_SOURCE,
									});
								}
							}
						}
						if (listLine.trim() && !listLine.trim().startsWith("-")) {
							break;
						}
					}
				}
			}
		}
	}
	return diagnostics;
}

/**
 * Validate workspace.protobuf.yaml: unknown keys, invalid proto_path.
 */
function validateWorkspaceProtobufYaml(
	document: vscode.TextDocument,
	configDir: string,
): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const text = document.getText();
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const keyMatch = line.match(/^\s*([a-z_][a-z0-9_]*)\s*:/i);
		if (keyMatch) {
			const key = keyMatch[1].trim();
			if (!KNOWN_WORKSPACE_PROTOBUF_KEYS.has(key)) {
				diagnostics.push({
					range: new vscode.Range(
						i,
						keyMatch.index ?? 0,
						i,
						(keyMatch.index ?? 0) + key.length,
					),
					message: `Unknown key "${key}". Known keys: ${[...KNOWN_WORKSPACE_PROTOBUF_KEYS].join(", ")}.`,
					severity: vscode.DiagnosticSeverity.Warning,
					source: CONFIG_DIAGNOSTIC_SOURCE,
				});
			}
			if (key === "proto_path") {
				const pathMatch = line.match(/proto_path\s*:\s*["']?([^"'\n#]+)/);
				if (pathMatch) {
					const rawPath = pathMatch[1].trim();
					const resolved = path.resolve(configDir, rawPath);
					if (!fs.existsSync(resolved)) {
						const start = line.indexOf(pathMatch[1]);
						diagnostics.push({
							range: new vscode.Range(i, start, i, start + pathMatch[1].length),
							message: `Path does not exist: ${resolved}`,
							severity: vscode.DiagnosticSeverity.Warning,
							source: CONFIG_DIAGNOSTIC_SOURCE,
						});
					}
				}
			}
		}
	}
	return diagnostics;
}

export function validateConfigDocument(
	document: vscode.TextDocument,
): vscode.Diagnostic[] {
	const fileName = path.basename(document.uri.fsPath);
	const configDir = path.dirname(document.uri.fsPath);

	if (fileName === ".api-linter.yaml") {
		return validateApiLinterYaml(document, configDir);
	}
	if (fileName === "workspace.protobuf.yaml") {
		return validateWorkspaceProtobufYaml(document, configDir);
	}
	return [];
}

export function registerConfigValidation(
	context: vscode.ExtensionContext,
	configDiagnosticCollection: vscode.DiagnosticCollection,
): void {
	const run = (doc: vscode.TextDocument) => {
		const name = path.basename(doc.uri.fsPath);
		if (name !== ".api-linter.yaml" && name !== "workspace.protobuf.yaml") {
			return;
		}
		const diags = validateConfigDocument(doc);
		configDiagnosticCollection.set(doc.uri, diags);
	};

	context.subscriptions.push(
		configDiagnosticCollection,
		vscode.workspace.onDidOpenTextDocument((doc) => run(doc)),
		vscode.workspace.onDidSaveTextDocument((doc) => run(doc)),
	);

	for (const doc of vscode.workspace.textDocuments) {
		run(doc);
	}
}
