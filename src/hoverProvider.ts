import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "./constants";
import { parseRuleHtml } from "./utils/htmlParser";
import { fetchHtml } from "./utils/httpClient";

/**
 * Provides hover information for api-linter diagnostics.
 * Fetches and displays rule documentation when hovering over linter warnings.
 */
export class ApiLinterHoverProvider implements vscode.HoverProvider {
	private diagnosticCollection: vscode.DiagnosticCollection;
	private guidanceCache: Map<string, string> = new Map();

	/**
	 * Creates a new hover provider.
	 * @param diagnosticCollection - The diagnostic collection containing linter results
	 */
	constructor(diagnosticCollection: vscode.DiagnosticCollection) {
		this.diagnosticCollection = diagnosticCollection;
	}

	/**
	 * Provides hover information for a position in a document.
	 * @param document - The document being hovered over
	 * @param position - The position in the document
	 * @param token - Cancellation token
	 * @returns Hover information or null if no diagnostics at position
	 */
	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.Hover | null> {
		const matchingDiagnostics = this.getDiagnosticsAtPosition(
			document,
			position,
		);

		if (matchingDiagnostics.length === 0) {
			return null;
		}

		const markdown = await this.buildHoverMarkdown(matchingDiagnostics);
		return new vscode.Hover(markdown, matchingDiagnostics[0].range);
	}

	/**
	 * Gets all linter diagnostics at a specific position.
	 * @param document - The document to check
	 * @param position - The position to check
	 * @returns Array of diagnostics at the position
	 */
	private getDiagnosticsAtPosition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.Diagnostic[] {
		const diagnostics = this.diagnosticCollection.get(document.uri);
		if (!diagnostics || diagnostics.length === 0) {
			return [];
		}

		return diagnostics.filter(
			(d) => d.range.contains(position) && d.source === DIAGNOSTIC_SOURCE,
		);
	}

	/**
	 * Builds the markdown content for the hover popup.
	 * @param diagnostics - Array of diagnostics to display
	 * @returns Markdown string with formatted diagnostic information
	 */
	private async buildHoverMarkdown(
		diagnostics: vscode.Diagnostic[],
	): Promise<vscode.MarkdownString> {
		const markdown = new vscode.MarkdownString();
		// Neither trusted nor HTML-enabled. This hover appends guidance fetched
		// from `gapi.rulesDocumentationEndpoint`, a remote host the user can
		// repoint — so the content is not ours, and rendering it as trusted
		// markdown with raw HTML would turn a compromised or misconfigured
		// endpoint into script and `command:` execution inside the editor.
		// Every link it needs is `https`, which renders under both defaults.

		for (let index = 0; index < diagnostics.length; index++) {
			if (index > 0) {
				markdown.appendMarkdown(`\n\n---\n\n`);
			}

			await this.appendDiagnosticInfo(markdown, diagnostics[index]);
		}

		return markdown;
	}

	/**
	 * Appends information for a single diagnostic to the markdown.
	 * @param markdown - The markdown string to append to
	 * @param diagnostic - The diagnostic to format
	 */
	private async appendDiagnosticInfo(
		markdown: vscode.MarkdownString,
		diagnostic: vscode.Diagnostic,
	): Promise<void> {
		const code = diagnostic.code as { value: string; target: vscode.Uri };
		const ruleId = code?.value || "unknown";
		const ruleUri = code?.target?.toString() || "";

		this.appendRuleHeader(markdown, ruleId, ruleUri);
		this.appendSeverityAndMessage(markdown, diagnostic);

		if (ruleUri) {
			const guidance = await this.fetchRuleGuidance(ruleUri);
			markdown.appendMarkdown(guidance);
			markdown.appendMarkdown(`\n\n[View Full Documentation](${ruleUri})\n`);
		}
	}

	/**
	 * Appends the rule header with a link to documentation.
	 * @param markdown - The markdown string to append to
	 * @param ruleId - The rule identifier
	 * @param ruleUri - The URL to the rule documentation
	 */
	private appendRuleHeader(
		markdown: vscode.MarkdownString,
		ruleId: string,
		ruleUri: string,
	): void {
		if (ruleUri) {
			markdown.appendMarkdown(`### Rule: [\`${ruleId}\`](${ruleUri})\n\n`);
		} else {
			markdown.appendMarkdown(`### Rule: \`${ruleId}\`\n\n`);
		}
	}

	/**
	 * Appends the severity level and message to the markdown.
	 * @param markdown - The markdown string to append to
	 * @param diagnostic - The diagnostic containing severity and message
	 */
	private appendSeverityAndMessage(
		markdown: vscode.MarkdownString,
		diagnostic: vscode.Diagnostic,
	): void {
		const severityMap = {
			[vscode.DiagnosticSeverity.Error]: "ERROR",
			[vscode.DiagnosticSeverity.Warning]: "WARNING",
			[vscode.DiagnosticSeverity.Information]: "INFO",
			[vscode.DiagnosticSeverity.Hint]: "HINT",
		};

		const severityLabel = severityMap[diagnostic.severity] || "INFO";
		markdown.appendMarkdown(`**${severityLabel}:** ${diagnostic.message}\n\n`);
	}

	/**
	 * Fetches and caches rule guidance from the documentation URL.
	 * @param ruleUri - The URL to fetch guidance from
	 * @returns Markdown-formatted guidance text
	 */
	private async fetchRuleGuidance(ruleUri: string): Promise<string> {
		const cached = this.guidanceCache.get(ruleUri);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const html = await fetchHtml(ruleUri);
			const guidance = parseRuleHtml(html);
			this.guidanceCache.set(ruleUri, guidance);
			return guidance;
		} catch (error) {
			console.error(`Failed to fetch guidance from ${ruleUri}:`, error);
			return `**Documentation available at the link below.**`;
		}
	}
}
