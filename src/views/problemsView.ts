/**
 * The Problems view: findings grouped by the rule that produced them.
 *
 * VS Code's own Problems panel groups by file, which answers "what is wrong
 * with this file". The question this view exists for is the other one — "which
 * rule is firing 34 times, and is it one I should be suppressing" — and no
 * amount of per-file grouping surfaces that.
 *
 * Diagnostics are read from the collection rather than re-linted: the linter
 * already published them, and a second source of truth would drift.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "../constants";

/** View id, matching `contributes.views` in package.json. */
export const PROBLEMS_VIEW_ID = "googleApiLinter.views.problems";

/** How the view is currently grouped. */
export type ProblemGrouping = "rule" | "file";

/** A node in the Problems tree. */
export type ProblemNode =
	| {
			kind: "rule";
			ruleId: string;
			count: number;
			docUrl?: string;
			severity: vscode.DiagnosticSeverity;
	  }
	| { kind: "file"; uri: vscode.Uri; count: number }
	| {
			kind: "finding";
			uri: vscode.Uri;
			range: vscode.Range;
			message: string;
			ruleId: string;
			severity: vscode.DiagnosticSeverity;
	  }
	| { kind: "info"; label: string; detail?: string; icon: string };

/** One diagnostic paired with the file it came from. */
interface Located {
	readonly uri: vscode.Uri;
	readonly diagnostic: vscode.Diagnostic;
}

/** The rule id carried on a diagnostic's `code`. */
function ruleIdOf(diagnostic: vscode.Diagnostic): string {
	const code = diagnostic.code;
	if (code && typeof code === "object" && "value" in code) {
		return String((code as { value: string | number }).value);
	}
	return typeof code === "string" || typeof code === "number"
		? String(code)
		: "unknown";
}

/** The documentation URL on a diagnostic's `code`. */
function docUrlOf(diagnostic: vscode.Diagnostic): string | undefined {
	const code = diagnostic.code;
	if (code && typeof code === "object" && "target" in code) {
		return (code as { target?: vscode.Uri }).target?.toString();
	}
	return undefined;
}

/** The icon and theme colour for a severity. */
function severityIcon(severity: vscode.DiagnosticSeverity): vscode.ThemeIcon {
	if (severity === vscode.DiagnosticSeverity.Error) {
		return new vscode.ThemeIcon(
			"error",
			new vscode.ThemeColor("editorError.foreground"),
		);
	}
	if (severity === vscode.DiagnosticSeverity.Warning) {
		return new vscode.ThemeIcon(
			"warning",
			new vscode.ThemeColor("editorWarning.foreground"),
		);
	}
	return new vscode.ThemeIcon(
		"info",
		new vscode.ThemeColor("editorInfo.foreground"),
	);
}

export class ProblemsProvider
	implements vscode.TreeDataProvider<ProblemNode>, vscode.Disposable
{
	private readonly emitter = new vscode.EventEmitter<ProblemNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	private grouping: ProblemGrouping = "rule";

	constructor(private readonly diagnostics: vscode.DiagnosticCollection) {}

	/** Redraw from the current diagnostics. */
	refresh(): void {
		this.emitter.fire(undefined);
	}

	/** Flip between grouping by rule and by file. */
	toggleGrouping(): ProblemGrouping {
		this.grouping = this.grouping === "rule" ? "file" : "rule";
		this.refresh();
		return this.grouping;
	}

	/** Total findings from this extension, for a view badge. */
	total(): number {
		return this.collect().length;
	}

	getTreeItem(node: ProblemNode): vscode.TreeItem {
		if (node.kind === "rule") {
			const item = new vscode.TreeItem(
				node.ruleId,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.description = String(node.count);
			item.iconPath = severityIcon(node.severity);
			item.contextValue = "problemRule";
			const lines = [`**${node.ruleId}**`, "", `${node.count} finding(s)`];
			if (node.docUrl) {
				lines.push("", `[Rule documentation](${node.docUrl})`);
			}
			// Untrusted on purpose. `https` links render without it — only
			// `command:` links need trust, and enabling it here would extend that
			// to the linter's own messages, which are text this extension does
			// not author.
			item.tooltip = new vscode.MarkdownString(lines.join("\n"));
			return item;
		}

		if (node.kind === "file") {
			const item = new vscode.TreeItem(
				path.basename(node.uri.fsPath),
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.description = String(node.count);
			item.resourceUri = node.uri;
			item.iconPath = vscode.ThemeIcon.File;
			item.contextValue = "problemFile";
			item.tooltip = new vscode.MarkdownString(`\`${node.uri.fsPath}\``);
			return item;
		}

		if (node.kind === "finding") {
			const item = new vscode.TreeItem(
				node.message,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description =
				this.grouping === "rule"
					? `${path.basename(node.uri.fsPath)}:${node.range.start.line + 1}`
					: node.ruleId;
			item.iconPath = severityIcon(node.severity);
			item.contextValue = "problemFinding";
			item.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to finding",
				arguments: [node.uri, node.range],
			};
			item.tooltip = new vscode.MarkdownString(
				`${node.message}\n\n\`${node.ruleId}\``,
			);
			return item;
		}

		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description = node.detail;
		item.iconPath = new vscode.ThemeIcon(node.icon);
		return item;
	}

	getChildren(node?: ProblemNode): ProblemNode[] {
		const all = this.collect();
		if (all.length === 0) {
			return node
				? []
				: [
						{
							kind: "info",
							label: "No problems found",
							detail: "nothing linted yet, or nothing to report",
							icon: "check",
						},
					];
		}

		if (!node) {
			return this.grouping === "rule"
				? this.ruleNodes(all)
				: this.fileNodes(all);
		}

		if (node.kind === "rule") {
			return all
				.filter((entry) => ruleIdOf(entry.diagnostic) === node.ruleId)
				.map((entry) => this.finding(entry));
		}

		if (node.kind === "file") {
			return all
				.filter((entry) => entry.uri.toString() === node.uri.toString())
				.map((entry) => this.finding(entry));
		}

		return [];
	}

	private finding(entry: Located): ProblemNode {
		return {
			kind: "finding",
			uri: entry.uri,
			range: entry.diagnostic.range,
			message: entry.diagnostic.message,
			ruleId: ruleIdOf(entry.diagnostic),
			severity: entry.diagnostic.severity,
		};
	}

	/** Rule groups, loudest first — the one firing most is the one to act on. */
	private ruleNodes(all: readonly Located[]): ProblemNode[] {
		const byRule = new Map<string, Located[]>();
		for (const entry of all) {
			const id = ruleIdOf(entry.diagnostic);
			const bucket = byRule.get(id);
			if (bucket) {
				bucket.push(entry);
			} else {
				byRule.set(id, [entry]);
			}
		}
		return [...byRule.entries()]
			.map(([ruleId, entries]) => ({
				kind: "rule" as const,
				ruleId,
				count: entries.length,
				docUrl: docUrlOf(entries[0].diagnostic),
				severity: entries[0].diagnostic.severity,
			}))
			.sort((a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId));
	}

	private fileNodes(all: readonly Located[]): ProblemNode[] {
		const byFile = new Map<string, Located[]>();
		for (const entry of all) {
			const key = entry.uri.toString();
			const bucket = byFile.get(key);
			if (bucket) {
				bucket.push(entry);
			} else {
				byFile.set(key, [entry]);
			}
		}
		return [...byFile.values()]
			.map((entries) => ({
				kind: "file" as const,
				uri: entries[0].uri,
				count: entries.length,
			}))
			.sort(
				(a, b) => b.count - a.count || a.uri.fsPath.localeCompare(b.uri.fsPath),
			);
	}

	/** Every finding this extension published, flattened. */
	private collect(): Located[] {
		const out: Located[] = [];
		this.diagnostics.forEach((uri, diagnostics) => {
			for (const diagnostic of diagnostics) {
				if (diagnostic.source === DIAGNOSTIC_SOURCE) {
					out.push({ uri, diagnostic });
				}
			}
		});
		return out;
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
