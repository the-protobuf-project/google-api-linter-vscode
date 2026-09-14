/**
 * The Details panel: a webview docked in the Proto container.
 *
 * It is the one pane in the sidebar that is not a tree, because it is the one
 * pane whose content a `TreeItem` cannot express — a table of fields, wrapped
 * prose, and links out to rule documentation. The trees around it stay native
 * so keyboard navigation, type-ahead find and theming keep working for free.
 */

import type * as vscode from "vscode";
import type { ProtoIndex } from "../index/types";
import type { SymbolDetail } from "../shared/protocol";
import { buildSymbolDetail } from "./symbolDetail";
import {
	handleCommonMessage,
	PanelChannel,
	panelOptions,
	renderPanelHtml,
} from "./webviewHost";

/** View id, matching `contributes.views` in package.json. */
export const DETAILS_VIEW_ID = "googleApiLinter.views.details";

/**
 * Milliseconds to coalesce selection changes over.
 *
 * Arrow-keying down a tree fires a selection event per row. Rebuilding the
 * payload for every one of them reads a file per keystroke, so the last
 * selection in a burst is the only one that does work.
 */
const SELECTION_DEBOUNCE_MS = 80;

export class DetailsViewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	private view: vscode.WebviewView | undefined;
	private channel: PanelChannel | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	/**
	 * The symbol to show once the panel mounts.
	 *
	 * A selection made while the view is collapsed must not be lost: the panel
	 * asks for its payload when it is ready, and this is what it gets.
	 */
	private pending: string | undefined;
	private current: SymbolDetail | null = null;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly index: ProtoIndex | undefined,
		private readonly diagnostics: vscode.DiagnosticCollection,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = panelOptions(this.extensionUri);
		view.webview.html = renderPanelHtml(
			view.webview,
			this.extensionUri,
			"details",
			"Proto Details",
		);

		const channel = new PanelChannel(view.webview);
		this.channel = channel;

		this.disposables.push(
			channel.onMessage(async (message) => {
				if (await handleCommonMessage(message)) {
					return;
				}
				if (message.type === "ready") {
					// The panel just mounted — or remounted after being hidden,
					// which tears the DOM down and loses whatever it held.
					if (this.pending) {
						await this.render(this.pending);
					} else {
						channel.post({ type: "details/update", detail: this.current });
					}
				}
			}),
		);

		view.onDidDispose(() => {
			this.view = undefined;
			this.channel = undefined;
		});
	}

	/**
	 * Show one symbol, debounced.
	 *
	 * @param fqn - Fully-qualified name, or `undefined` to clear the panel
	 */
	show(fqn: string | undefined): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		if (!fqn) {
			this.pending = undefined;
			this.current = null;
			this.channel?.post({ type: "details/update", detail: null });
			return;
		}
		this.pending = fqn;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.render(fqn);
		}, SELECTION_DEBOUNCE_MS);
	}

	/** Rebuild the current payload, e.g. after a lint run changed findings. */
	refresh(): void {
		if (this.pending) {
			void this.render(this.pending);
		}
	}

	private async render(fqn: string): Promise<void> {
		if (!this.index) {
			return;
		}
		const detail = await buildSymbolDetail(this.index, fqn, this.diagnostics);
		// A slower build for an older selection must not overwrite a newer one.
		if (this.pending !== fqn) {
			return;
		}
		this.current = detail;
		this.channel?.post({ type: "details/update", detail });

		// The container badge is the only part of this panel visible while it is
		// collapsed, so it carries the one number worth seeing from outside.
		if (this.view) {
			this.view.badge =
				detail && detail.problemTotal > 0
					? {
							value: detail.problemTotal,
							tooltip: `${detail.problemTotal} problem(s) on ${detail.name}`,
						}
					: undefined;
		}
	}

	/** Focus the panel, e.g. from a "Show details" command. */
	reveal(): void {
		this.view?.show?.(true);
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}
