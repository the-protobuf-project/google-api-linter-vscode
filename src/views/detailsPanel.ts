/**
 * The Details panel as an editor tab.
 *
 * The sidebar view and this are the same content at two sizes, which is the
 * arrangement the Markdown preview already established: the file stays where
 * you edit it and the preview opens beside it. A 300px rail is right for
 * glancing at a field list while navigating the tree; a full column is right
 * for reading a service's diagram and its findings together.
 *
 * Both are driven from the same selection, so opening this does not mean
 * choosing between them.
 */

import * as vscode from "vscode";
import type { ProtoIndex } from "../index/types";
import type { SymbolDetail } from "../shared/protocol";
import { buildSymbolDetail } from "./symbolDetail";
import {
	handleCommonMessage,
	PanelChannel,
	panelOptions,
	renderPanelHtml,
} from "./webviewHost";

/** Panel type id, used by VS Code to restore the tab across reloads. */
const PANEL_TYPE = "googleApiLinter.details";

export class DetailsPanel {
	private static instance: DetailsPanel | undefined;

	private readonly channel: PanelChannel;
	private readonly disposables: vscode.Disposable[] = [];
	private current: SymbolDetail | null = null;
	private fqn: string | undefined;

	/**
	 * When true the panel keeps showing whatever it has, ignoring the tree.
	 *
	 * The Markdown preview offers the same toggle for the same reason: a
	 * reader comparing two symbols needs one of them to stay put.
	 */
	private locked = false;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly index: ProtoIndex | undefined,
		private readonly diagnostics: vscode.DiagnosticCollection,
	) {
		panel.webview.options = panelOptions(extensionUri);
		panel.webview.html = renderPanelHtml(
			panel.webview,
			extensionUri,
			"details",
			"Proto Details",
		);
		this.channel = new PanelChannel(panel.webview);

		this.disposables.push(
			this.channel.onMessage(async (message) => {
				if (await handleCommonMessage(message)) {
					return;
				}
				if (message.type === "ready") {
					this.channel.post({
						type: "details/update",
						detail: this.current,
					});
				}
			}),
		);

		panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	/** Open beside the active editor, or focus the tab when already open. */
	static show(
		extensionUri: vscode.Uri,
		index: ProtoIndex | undefined,
		diagnostics: vscode.DiagnosticCollection,
	): DetailsPanel {
		if (DetailsPanel.instance) {
			DetailsPanel.instance.panel.reveal(undefined, true);
			return DetailsPanel.instance;
		}
		const panel = vscode.window.createWebviewPanel(
			PANEL_TYPE,
			"Proto Details",
			// `preserveFocus` keeps the caret in the tree, so arrowing through
			// symbols keeps working after the panel opens.
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			panelOptions(extensionUri),
		);
		panel.iconPath = new vscode.ThemeIcon("symbol-class");
		DetailsPanel.instance = new DetailsPanel(
			panel,
			extensionUri,
			index,
			diagnostics,
		);
		return DetailsPanel.instance;
	}

	/** True when a tab is open, so the caller can skip building a payload. */
	static isOpen(): boolean {
		return DetailsPanel.instance !== undefined;
	}

	/** Stop following the tree, or start again. */
	static toggleLock(): boolean | undefined {
		const instance = DetailsPanel.instance;
		if (!instance) {
			return undefined;
		}
		instance.locked = !instance.locked;
		instance.panel.title = instance.locked
			? "Proto Details (locked)"
			: "Proto Details";
		return instance.locked;
	}

	/** Show one symbol, unless the panel is locked. */
	static async show_symbol(fqn: string | undefined): Promise<void> {
		const instance = DetailsPanel.instance;
		if (!instance || instance.locked || !fqn) {
			return;
		}
		await instance.render(fqn);
	}

	/** Rebuild the current payload, e.g. after a lint run changed findings. */
	static async refresh(): Promise<void> {
		const instance = DetailsPanel.instance;
		if (instance?.fqn) {
			await instance.render(instance.fqn);
		}
	}

	private async render(fqn: string): Promise<void> {
		if (!this.index) {
			return;
		}
		this.fqn = fqn;
		const detail = await buildSymbolDetail(this.index, fqn, this.diagnostics);
		// A slower build for an older selection must not overwrite a newer one.
		if (this.fqn !== fqn) {
			return;
		}
		this.current = detail;
		this.channel.post({ type: "details/update", detail });
	}

	private dispose(): void {
		DetailsPanel.instance = undefined;
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}
