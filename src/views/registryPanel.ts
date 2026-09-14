/**
 * The Proto Registry: a webview panel in the editor area.
 *
 * Browsing lives in a tab rather than the sidebar for the same reason VS Code
 * puts the Extensions marketplace there — a 300px rail can show what you
 * already have, but not a searchable catalogue with detail beside it.
 *
 * The panel is a singleton. Opening it twice should focus the existing tab, not
 * produce a second copy with its own divergent state.
 */

import * as vscode from "vscode";
import type { DependencyModel, PanelMessage } from "../shared/protocol";
import { addDependency, generate, updateDependencies } from "./bufActions";
import {
	handleCommonMessage,
	PanelChannel,
	panelOptions,
	renderPanelHtml,
} from "./webviewHost";

/** Panel type id, used by VS Code to restore the tab across reloads. */
const PANEL_TYPE = "googleApiLinter.registry";

/** Everything the panel needs from the rest of the extension. */
export interface RegistryPanelDeps {
	readonly extensionUri: vscode.Uri;
	/** Builds the dependency model from disk. */
	readonly loadModel: () => Promise<DependencyModel>;
	/** Rebuilds the model with registry update status filled in. */
	readonly checkUpdates: () => Promise<DependencyModel>;
	/** Called after any action that changed the workspace. */
	readonly onChanged: () => void;
	readonly log?: vscode.OutputChannel;
}

export class RegistryPanel {
	private static instance: RegistryPanel | undefined;

	private readonly channel: PanelChannel;
	private readonly disposables: vscode.Disposable[] = [];
	private model: DependencyModel | undefined;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly deps: RegistryPanelDeps,
	) {
		panel.webview.options = panelOptions(deps.extensionUri);
		panel.webview.html = renderPanelHtml(
			panel.webview,
			deps.extensionUri,
			"registry",
			"Proto Registry",
		);
		this.channel = new PanelChannel(panel.webview);

		this.disposables.push(
			this.channel.onMessage((message) => this.handle(message)),
		);

		panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	/** Open the panel, or focus it when it is already open. */
	static show(deps: RegistryPanelDeps): RegistryPanel {
		const column =
			vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		if (RegistryPanel.instance) {
			RegistryPanel.instance.panel.reveal(column);
			return RegistryPanel.instance;
		}
		const panel = vscode.window.createWebviewPanel(
			PANEL_TYPE,
			"Proto Registry",
			column,
			panelOptions(deps.extensionUri),
		);
		RegistryPanel.instance = new RegistryPanel(panel, deps);
		return RegistryPanel.instance;
	}

	/**
	 * Scope the panel to one registry host.
	 *
	 * Sent rather than stored: the panel owns its own selection, and a host
	 * that duplicated it would be a second source of truth to keep in step.
	 */
	focusRemote(remote: string | undefined): void {
		this.channel.post({ type: "registry/focus", remote: remote ?? null });
	}

	/** Push a freshly built model into an open panel. */
	push(model: DependencyModel): void {
		this.model = model;
		this.channel.post({ type: "registry/update", model });
	}

	private async handle(message: PanelMessage): Promise<void> {
		if (await handleCommonMessage(message)) {
			return;
		}

		switch (message.type) {
			case "ready":
				await this.sendModel();
				return;

			case "dep/checkUpdates":
				await this.task(message.taskId, "Checking the registry…", async () => {
					this.push(await this.deps.checkUpdates());
					return { ok: true };
				});
				return;

			case "dep/add":
				await this.task(message.taskId, `Adding ${message.name}…`, async () => {
					const edit = await addDependency(message.bufYaml, message.name);
					if (!edit.changed) {
						return { ok: false, detail: edit.reason };
					}
					// The lock file is what actually pins the commit; editing
					// buf.yaml alone leaves the workspace in a half-added state.
					const root = message.bufYaml.replace(/[/\\]buf\.yaml$/, "");
					const result = await updateDependencies(root, this.deps.log);
					if (!result.ok) {
						return { ok: false, detail: result.stderr.trim().split("\n")[0] };
					}
					return { ok: true };
				});
				return;

			case "dep/update":
				await this.task(message.taskId, "buf dep update…", async () => {
					const result = await updateDependencies(message.root, this.deps.log);
					return result.ok
						? { ok: true }
						: { ok: false, detail: result.stderr.trim().split("\n")[0] };
				});
				return;

			case "gen/run":
				await this.task(message.taskId, "buf generate…", async () => {
					const result = await generate(message.root, this.deps.log);
					return result.ok
						? { ok: true }
						: { ok: false, detail: result.stderr.trim().split("\n")[0] };
				});
				return;

			default:
				return;
		}
	}

	/**
	 * Run one panel-initiated action, reporting its lifecycle back.
	 *
	 * The panel disables the button that started a task until a terminal state
	 * arrives, so every path out of here — including a thrown error — must send
	 * one. Otherwise a failure leaves a permanently dead button.
	 */
	private async task(
		taskId: string,
		running: string,
		body: () => Promise<{ ok: boolean; detail?: string }>,
	): Promise<void> {
		this.channel.post({
			type: "task/progress",
			taskId,
			state: "running",
			message: running,
		});
		try {
			const outcome = await body();
			this.channel.post({
				type: "task/progress",
				taskId,
				state: outcome.ok ? "done" : "failed",
				message: outcome.detail,
			});
			if (outcome.ok) {
				this.deps.onChanged();
				await this.sendModel();
			}
		} catch (error) {
			this.channel.post({
				type: "task/progress",
				taskId,
				state: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async sendModel(): Promise<void> {
		try {
			this.model = await this.deps.loadModel();
			this.channel.post({ type: "registry/update", model: this.model });
		} catch (error) {
			this.channel.post({
				type: "registry/update",
				model: {
					modules: [],
					gen: [],
					undeclared: [],
					updatesChecked: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private dispose(): void {
		RegistryPanel.instance = undefined;
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}
}
