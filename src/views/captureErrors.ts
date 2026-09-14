/**
 * Capturing every finding into something shareable.
 *
 * VS Code extensions cannot take screenshots: there is no API that renders the
 * editor to an image, and the extension host has no access to the window's
 * pixels. What a bug report actually needs from a screenshot is the text in it
 * — the rule, the message, the line, and enough of the source to see what
 * tripped it — and that can be captured exactly rather than photographed.
 *
 * So this produces a Markdown capture: findings grouped by rule, each with the
 * offending source line quoted, plus the environment a maintainer will ask for
 * anyway. It pastes into a GitHub issue, which is where it is going.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "../constants";

const execFileAsync = promisify(execFile);

/** Findings quoted in full before the capture switches to a summary. */
const MAX_QUOTED = 200;

/** Characters of a source line to quote. */
const MAX_LINE_LENGTH = 160;

/** One finding, flattened out of the collection. */
interface Finding {
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

/** `core::0192::has-comments` → `https://linter.aip.dev/192/has-comments`. */
function ruleUrl(ruleId: string): string | undefined {
	const parts = ruleId.split("::").slice(1);
	if (parts.length === 0) {
		return undefined;
	}
	// The rule id zero-pads the AIP number and the site does not.
	return `https://linter.aip.dev/${parts
		.map((part) => part.replace(/^0+(?=\d)/, ""))
		.join("/")}`;
}

/** Severity as a word, since a capture has no colour to carry it. */
function severityWord(severity: vscode.DiagnosticSeverity | undefined): string {
	if (severity === vscode.DiagnosticSeverity.Warning) {
		return "warning";
	}
	if (severity === vscode.DiagnosticSeverity.Information) {
		return "info";
	}
	if (severity === vscode.DiagnosticSeverity.Hint) {
		return "hint";
	}
	return "error";
}

/** Every finding this extension published. */
function collect(diagnostics: vscode.DiagnosticCollection): Finding[] {
	const out: Finding[] = [];
	diagnostics.forEach((uri, list) => {
		for (const diagnostic of list) {
			if (diagnostic.source === DIAGNOSTIC_SOURCE) {
				out.push({ uri, diagnostic });
			}
		}
	});
	return out;
}

/** The `api-linter` version, or a note saying it could not be read. */
async function linterVersion(): Promise<string> {
	const binary =
		vscode.workspace.getConfiguration("gapi").get<string>("binaryPath") ||
		"api-linter";
	try {
		const { stdout } = await execFileAsync(binary, ["--version"], {
			timeout: 5000,
		});
		return stdout.trim() || "unknown";
	} catch {
		return "not found on PATH";
	}
}

/**
 * Builds the capture.
 *
 * @param diagnostics - The collection to read
 * @param readLine - Returns one line of a file, for quoting the source
 * @returns Markdown, and how many findings it covers
 */
export async function buildCapture(
	diagnostics: vscode.DiagnosticCollection,
	readLine: (uri: vscode.Uri, line: number) => Promise<string | undefined>,
): Promise<{ markdown: string; total: number }> {
	const findings = collect(diagnostics);

	const byRule = new Map<string, Finding[]>();
	for (const finding of findings) {
		const id = ruleIdOf(finding.diagnostic);
		const bucket = byRule.get(id);
		if (bucket) {
			bucket.push(finding);
		} else {
			byRule.set(id, [finding]);
		}
	}
	const ranked = [...byRule.entries()].sort(
		(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
	);

	const files = new Set(findings.map((finding) => finding.uri.toString()));
	const out: string[] = [];

	out.push("## Proto lint capture", "");
	out.push(
		`**${findings.length}** finding(s) across **${files.size}** file(s), ` +
			`**${ranked.length}** rule(s).`,
		"",
	);

	if (ranked.length > 0) {
		out.push("| Rule | Count |", "| --- | ---: |");
		for (const [rule, list] of ranked) {
			const url = ruleUrl(rule);
			out.push(
				`| ${url ? `[\`${rule}\`](${url})` : `\`${rule}\``} | ${list.length} |`,
			);
		}
		out.push("");
	}

	let quoted = 0;
	for (const [rule, list] of ranked) {
		if (quoted >= MAX_QUOTED) {
			break;
		}
		out.push(`### ${rule}`, "");
		const url = ruleUrl(rule);
		if (url) {
			out.push(`<${url}>`, "");
		}
		for (const finding of list) {
			if (quoted >= MAX_QUOTED) {
				break;
			}
			quoted++;
			const line = finding.diagnostic.range.start.line;
			const where = `${path.basename(finding.uri.fsPath)}:${line + 1}`;
			out.push(
				`- **${where}** · ${severityWord(finding.diagnostic.severity)} — ${finding.diagnostic.message}`,
			);
			// The source line is the part of a screenshot that carries meaning;
			// quoting it is what makes this capture usable without the workspace.
			const text = await readLine(finding.uri, line);
			if (text !== undefined) {
				const trimmed = text.trim().slice(0, MAX_LINE_LENGTH);
				if (trimmed.length > 0) {
					out.push("", "  ```proto", `  ${trimmed}`, "  ```");
				}
			}
		}
		out.push("");
	}

	if (findings.length > quoted) {
		out.push(
			`_${findings.length - quoted} further finding(s) not quoted._`,
			"",
		);
	}

	out.push("<details><summary>Environment</summary>", "");
	out.push(`- VS Code \`${vscode.version}\``);
	out.push(`- Platform \`${process.platform}-${process.arch}\``);
	out.push(`- api-linter \`${await linterVersion()}\``);
	const extension = vscode.extensions.getExtension(
		"the-protobuf-project.protobuf-aip-linter",
	);
	if (extension) {
		out.push(`- Extension \`${extension.packageJSON.version}\``);
	}
	out.push("", "</details>");

	return { markdown: out.join("\n"), total: findings.length };
}

/**
 * Captures every finding and offers somewhere to put it.
 *
 * @param diagnostics - The collection to read
 */
export async function captureErrors(
	diagnostics: vscode.DiagnosticCollection,
): Promise<void> {
	const readLine = async (
		uri: vscode.Uri,
		line: number,
	): Promise<string | undefined> => {
		try {
			// Already-open documents come from memory; the rest are read once.
			const document = await vscode.workspace.openTextDocument(uri);
			return line < document.lineCount ? document.lineAt(line).text : undefined;
		} catch {
			return undefined;
		}
	};

	const { markdown, total } = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Capturing lint findings…",
		},
		() => buildCapture(diagnostics, readLine),
	);

	if (total === 0) {
		void vscode.window.showInformationMessage(
			"No lint findings to capture. Run a lint first.",
		);
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		`Captured ${total} finding(s).`,
		"Open",
		"Copy",
		"Report on GitHub",
	);

	if (choice === "Copy") {
		await vscode.env.clipboard.writeText(markdown);
		void vscode.window.showInformationMessage(
			"Capture copied to the clipboard.",
		);
		return;
	}

	if (choice === "Report on GitHub") {
		// The capture goes to the clipboard rather than into the URL: a query
		// string this size is refused by the browser long before GitHub sees it.
		await vscode.env.clipboard.writeText(markdown);
		void vscode.window.showInformationMessage(
			"Capture copied. Paste it into the issue body.",
		);
		await vscode.commands.executeCommand("googleApiLinter.reportIssue");
		return;
	}

	if (choice === "Open") {
		const document = await vscode.workspace.openTextDocument({
			language: "markdown",
			content: markdown,
		});
		await vscode.window.showTextDocument(document, { preview: false });
	}
}
