import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "./constants";

let statusBarItem: vscode.StatusBarItem | undefined;

export function registerStatusBar(
	context: vscode.ExtensionContext,
	_diagnosticCollection: vscode.DiagnosticCollection,
): void {
	statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	context.subscriptions.push(statusBarItem);

	const update = () => {
		if (!statusBarItem) {
			return;
		}
		const all = vscode.languages.getDiagnostics();
		let errorCount = 0;
		let warningCount = 0;
		for (const [, diags] of all) {
			for (const d of diags) {
				if (d.source !== DIAGNOSTIC_SOURCE) {
					continue;
				}
				if (d.severity === vscode.DiagnosticSeverity.Error) {
					errorCount++;
				} else if (d.severity === vscode.DiagnosticSeverity.Warning) {
					warningCount++;
				}
			}
		}
		const total = errorCount + warningCount;
		if (total > 0) {
			statusBarItem.text = `$(symbol-misc) Proto: ${errorCount} error(s), ${warningCount} warning(s)`;
			statusBarItem.tooltip = "Protobuf AIP Linter: click to open Proto view";
		} else {
			statusBarItem.text = "$(symbol-misc) Proto";
			statusBarItem.tooltip = "Protobuf AIP Linter: click to open Proto view";
		}
		statusBarItem.show();
	};

	statusBarItem.command = {
		command: "workbench.view.extension.protobuf-aip-linter",
		title: "Open Proto view",
	};

	update();
	context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(update));
}

export function disposeStatusBar(): void {
	statusBarItem?.dispose();
	statusBarItem = undefined;
}
