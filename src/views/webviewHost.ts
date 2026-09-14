/**
 * Shared plumbing for the extension's webview panels.
 *
 * A webview is an iframe with no privileges: it cannot reach the `vscode` API,
 * cannot read the disk, and cannot load anything the Content-Security-Policy
 * does not name. Everything in this file exists to set that boundary up
 * correctly once, rather than three times with two of them subtly wrong.
 */

import * as vscode from "vscode";
import type { HostMessage, PanelMessage } from "../shared/protocol";

/** Directory inside the extension holding the built panel bundles. */
const BUNDLE_DIR = ["out", "webview"];

/**
 * A fresh nonce for one document load.
 *
 * The CSP admits exactly one inline script — the module tag this file writes —
 * by nonce. Reusing a nonce across loads would let a cached or injected script
 * carry a value the policy still trusts, so it is regenerated per render.
 */
function makeNonce(): string {
	const bytes = new Uint8Array(16);
	// `crypto` is global on every Node the extension host runs on (18+).
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The one directory a panel may load files from. */
export function bundleRoot(extensionUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, ...BUNDLE_DIR);
}

/** Webview options locking a panel down to its own bundle directory. */
export function panelOptions(
	extensionUri: vscode.Uri,
): vscode.WebviewOptions & vscode.WebviewPanelOptions {
	return {
		enableScripts: true,
		// Without this the panel could read any file in the extension, and with
		// `enableScripts` that is a script-execution primitive, not just a read.
		localResourceRoots: [bundleRoot(extensionUri)],
		retainContextWhenHidden: false,
	};
}

/**
 * The HTML document for one panel.
 *
 * @param webview - The target webview, used to mint `vscode-resource` URIs
 * @param extensionUri - Root of the installed extension
 * @param entry - Bundle basename, `details` or `registry`
 * @param title - Document title, shown by screen readers
 * @returns A complete HTML document
 */
export function renderPanelHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	entry: "details" | "registry",
	title: string,
): string {
	const root = bundleRoot(extensionUri);
	const script = webview.asWebviewUri(vscode.Uri.joinPath(root, `${entry}.js`));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "style.css"));
	const nonce = makeNonce();

	// `default-src 'none'` is the whole point: every capability below is then
	// granted back explicitly. Note there is no `connect-src` — these panels
	// never talk to the network, they talk to the host over postMessage.
	const csp = [
		"default-src 'none'",
		`style-src ${webview.cspSource}`,
		`img-src ${webview.cspSource} data:`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
	].join("; ");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>${title}</title>
</head>
<body>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/**
 * A typed channel to one webview.
 *
 * Wraps `postMessage` so the host cannot send a shape the panel does not
 * expect, and swallows the post when the view is gone — a panel closing while
 * an async handler is mid-flight is normal, not an error worth surfacing.
 */
export class PanelChannel {
	constructor(private readonly webview: vscode.Webview) {}

	post(message: HostMessage): void {
		void this.webview.postMessage(message);
	}

	/**
	 * Subscribe to messages from the panel.
	 *
	 * Panel messages are untrusted input: the document is sandboxed but its
	 * contents are still just a page, so the handler must validate rather than
	 * assume. The narrowing here is deliberately shallow — each command handler
	 * checks its own payload.
	 */
	onMessage(
		handler: (message: PanelMessage) => void | Promise<void>,
	): vscode.Disposable {
		return this.webview.onDidReceiveMessage((raw: unknown) => {
			if (!raw || typeof raw !== "object") {
				return;
			}
			const message = raw as PanelMessage;
			if (typeof message.type !== "string") {
				return;
			}
			void handler(message);
		});
	}
}

/**
 * Handles the two panel messages that mean the same thing everywhere.
 *
 * @param message - An incoming panel message
 * @returns True when the message was fully handled here
 */
export async function handleCommonMessage(
	message: PanelMessage,
): Promise<boolean> {
	if (message.type === "reveal") {
		const uri = vscode.Uri.file(message.loc.path);
		const position = new vscode.Position(
			Math.max(0, message.loc.line),
			Math.max(0, message.loc.character ?? 0),
		);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, {
			selection: new vscode.Range(position, position),
			preserveFocus: false,
		});
		return true;
	}

	if (message.type === "openExternal") {
		// Only ever http(s). A panel is sandboxed, but `openExternal` runs with
		// the user's privileges, so a `file:` or `command:` URI arriving from
		// page content must not be handed straight to the OS.
		let parsed: vscode.Uri;
		try {
			parsed = vscode.Uri.parse(message.url, true);
		} catch {
			return true;
		}
		if (parsed.scheme === "http" || parsed.scheme === "https") {
			await vscode.env.openExternal(parsed);
		}
		return true;
	}

	return false;
}
