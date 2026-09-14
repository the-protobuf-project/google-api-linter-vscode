import * as vscode from "vscode";
import { getSymbolAtPosition, parseProtoDocument } from "./utils/protoParser";

/**
 * Hover for proto symbols: show message/service/enum/rpc signature and doc preview.
 * Complements the linter hover (which shows rule docs on diagnostics).
 */
export class ProtoSymbolHoverProvider implements vscode.HoverProvider {
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.Hover> {
		const symbols = parseProtoDocument(document);
		const symbol = getSymbolAtPosition(symbols, position);
		if (!symbol) {
			return null;
		}

		// Untrusted: this hover renders symbol names and doc comments taken from
		// the workspace, and trusted markdown would make a `command:` link
		// written into a proto comment clickable. No link here needs it.
		const md = new vscode.MarkdownString();

		switch (symbol.kind) {
			case "message":
				md.appendMarkdown(`**message** \`${symbol.name}\`\n\n`);
				md.appendMarkdown("Message type definition.");
				if (symbol.children?.length) {
					md.appendMarkdown(
						`\n\n*Contains ${symbol.children.length} nested definition(s).*`,
					);
				}
				break;
			case "service":
				md.appendMarkdown(`**service** \`${symbol.name}\`\n\n`);
				md.appendMarkdown("RPC service.");
				if (symbol.children?.length) {
					md.appendMarkdown(
						`\n\n*${symbol.children.length} rpc(s):* ${symbol.children.map((c) => `\`${c.name}\``).join(", ")}`,
					);
				}
				break;
			case "enum":
				md.appendMarkdown(`**enum** \`${symbol.name}\`\n\n`);
				md.appendMarkdown("Enumeration type.");
				break;
			case "rpc":
				md.appendMarkdown(`**rpc** \`${symbol.name}\`\n\n`);
				if (symbol.detail) {
					md.appendMarkdown(`\`\`\`\n${symbol.detail}\n\`\`\`\n\n`);
				}
				md.appendMarkdown("RPC method.");
				break;
			default:
				return null;
		}

		return new vscode.Hover(md, symbol.selectionRange);
	}
}
