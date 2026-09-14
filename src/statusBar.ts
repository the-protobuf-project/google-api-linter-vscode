import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "./constants";
import type { EnvironmentReport } from "./doctor/environment";

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * The toolchain item, to the right of the problem counts.
 *
 * Separate from the diagnostics item on purpose: they answer different
 * questions and change on different schedules. "Which api-linter am I running"
 * is a property of the machine, and putting it beside a count that changes on
 * every keystroke would make it look like it changed too.
 */
let toolchainItem: vscode.StatusBarItem | undefined;

/**
 * Shows the toolchain version, the way a Go file shows its Go version.
 *
 * @param report - The environment as last inspected
 */
export function updateToolchainStatus(report: EnvironmentReport): void {
	if (!toolchainItem) {
		return;
	}
	const linter = report.dependencies.find((d) => d.id === "api-linter");
	const missing = report.dependencies.filter(
		(d) => d.requirement === "required" && d.state !== "ok",
	);

	if (missing.length > 0) {
		toolchainItem.text = `$(tools) Proto: setup needed`;
		toolchainItem.backgroundColor = new vscode.ThemeColor(
			"statusBarItem.warningBackground",
		);
	} else {
		toolchainItem.text = `$(tools) ${linter?.version ?? "api-linter"}`;
		toolchainItem.backgroundColor = undefined;
	}

	const lines = [
		"**Proto toolchain**",
		"",
		`\`${report.platform}-${report.arch}\``,
		"",
		"| | |",
		"| --- | --- |",
	];
	for (const dep of report.dependencies) {
		const mark =
			dep.state === "ok"
				? "$(check)"
				: dep.requirement === "required"
					? "$(error)"
					: "$(dash)";
		const value =
			dep.version ?? (dep.state === "ok" ? "installed" : "not found");
		lines.push(`| ${mark} ${dep.label} | ${value} |`);
	}
	lines.push("", `\`${report.gapiRoot}\``, "", "Click to check the setup.");

	const tooltip = new vscode.MarkdownString(lines.join("\n"));
	tooltip.supportThemeIcons = true;
	toolchainItem.tooltip = tooltip;
	toolchainItem.show();
}

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

	// Priority below the diagnostics item puts it to that item's right, which
	// is where an editor conventionally reports what it is running against.
	toolchainItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		99,
	);
	toolchainItem.command = {
		command: "googleApiLinter.checkSetup",
		title: "Check Proto Setup",
	};
	toolchainItem.text = "$(tools) Proto";
	toolchainItem.tooltip = "Checking the proto toolchain…";
	toolchainItem.show();
	context.subscriptions.push(toolchainItem);

	update();
	context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(update));
}

export function disposeStatusBar(): void {
	statusBarItem?.dispose();
	statusBarItem = undefined;
	toolchainItem?.dispose();
	toolchainItem = undefined;
}
