/**
 * Wiring for the Proto container's views.
 *
 * One function so `extension.ts` gains a call rather than eighty lines: the
 * four views share a diagnostic collection, a dependency model and a set of
 * commands, and keeping that graph in one place is what stops the activation
 * path from turning into a second copy of it.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
	buildDependencyModel,
	checkUpdates,
	invalidateDepCaches,
} from "../deps";
import type { ProtoIndex } from "../index/types";
import type { DependencyModel } from "../shared/protocol";
import { invalidateModuleGraphCache } from "../utils/moduleGraph";
import { buildApiReport } from "./apiReport";
import { generate, generatePlugin, updateDependencies } from "./bufActions";
import { captureErrors } from "./captureErrors";
import {
	DEPENDENCIES_VIEW_ID,
	DependenciesProvider,
	type DepNode,
} from "./dependenciesView";
import { DetailsPanel } from "./detailsPanel";
import { PROBLEMS_VIEW_ID, ProblemsProvider } from "./problemsView";
import {
	configuredRegistries,
	promptForRegistry,
	REGISTRIES_VIEW_ID,
	RegistriesProvider,
	type RegistryNode,
} from "./registriesView";
import { RegistryPanel } from "./registryPanel";
import { searchSymbols } from "./symbolSearch";

/** What the views need from the rest of the extension. */
export interface ViewWiring {
	readonly context: vscode.ExtensionContext;
	readonly diagnostics: vscode.DiagnosticCollection;
	readonly index: ProtoIndex | undefined;
	readonly log: vscode.OutputChannel;
	/** Commits of the vendored googleapis and protobuf checkouts. */
	readonly runtime?: {
		googleapis: () => Promise<string>;
		protobuf: () => Promise<string>;
	};
}

/** Handles the activation path keeps, to feed selection and refreshes in. */
export interface RegisteredViews {
	/** Show one symbol in the Details panel. */
	readonly showSymbol: (fqn: string | undefined) => void;
	/** Redraw the problem tree and the open detail payload. */
	readonly refreshProblems: () => void;
	/** Drop cached dependency state and redraw. */
	readonly refreshDependencies: () => void;
}

/**
 * The configured `buf` binary.
 *
 * Read here rather than inside `src/deps` so that module stays free of
 * `vscode` and remains unit-testable without the extension host.
 */
function bufPath(): string {
	return (
		vscode.workspace.getConfiguration("gapi").get<string>("bufPath") || "buf"
	);
}

/**
 * Every directory in the workspace that holds a `buf.gen.yaml`.
 *
 * A template does not have to sit beside a `buf.yaml`. Repositories routinely
 * keep one at the repository root while the modules live under `proto/`, or
 * several — `buf.gen.go.yaml`, `buf.gen.java.yaml` — in a `gen/` directory of
 * their own. Looking only where a module was found missed all of them, which
 * is why the Generate section came up empty in workspaces that plainly had
 * templates in them.
 *
 * `findFiles` covers every folder of a multi-root workspace, so "wherever I
 * open" is handled by the search itself rather than by iterating folders.
 *
 * @returns Absolute directories, deduplicated
 */
async function workspaceGenDirs(): Promise<string[]> {
	try {
		const uris = await vscode.workspace.findFiles(
			"**/buf.gen*.{yaml,yml}",
			"**/{node_modules,.git,out,dist,build,.vscode-test}/**",
			512,
		);
		return [...new Set(uris.map((uri) => path.dirname(uri.fsPath)))];
	} catch {
		// Discovery is an enhancement: a workspace that cannot be searched still
		// gets the templates sitting in its module roots.
		return [];
	}
}

/** The directory holding a file, for running a plugin where it was declared. */
function dirOf(filePath: string): string {
	return path.dirname(filePath);
}

/**
 * Creates the Problems, Details and Dependencies views and their commands.
 *
 * The Structure view is registered separately by `registerProtoView`, which
 * already owns the symbol tree.
 *
 * @param wiring - Shared collaborators
 * @returns Handles for the activation path to drive
 */
export function registerViews(wiring: ViewWiring): RegisteredViews {
	const { context, diagnostics, index, log, runtime } = wiring;

	/* ---------------------------------------------------------------- *
	 * Dependencies
	 * ---------------------------------------------------------------- */

	/** The last model built, reused when checking updates. */
	let lastModel: DependencyModel | undefined;

	/** The tree's current selection, so a panel opened later starts on it. */
	let lastSelected: string | undefined;

	const loadModel = async (): Promise<DependencyModel> => {
		lastModel = await buildDependencyModel({
			log,
			extraGenDirs: await workspaceGenDirs(),
		});
		// Drives the view's welcome content, which is the only signposted way
		// into the Registry for someone who has not found the toolbar.
		void vscode.commands.executeCommand(
			"setContext",
			"googleApiLinter.hasDeps",
			lastModel.modules.some((module) => module.deps.length > 0),
		);
		return lastModel;
	};

	const refreshUpdates = async (): Promise<DependencyModel> => {
		const base = lastModel ?? (await loadModel());
		lastModel = await checkUpdates(base, { bufPath: bufPath(), log });
		return lastModel;
	};

	const dependencies = new DependenciesProvider(loadModel, runtime);
	context.subscriptions.push(
		vscode.window.createTreeView(DEPENDENCIES_VIEW_ID, {
			treeDataProvider: dependencies,
		}),
		dependencies,
	);

	const refreshDependencies = (): void => {
		// The module graph caches for 15 s. Without dropping it, a rebuild that
		// follows `buf dep update` shows the deps from before the update.
		invalidateModuleGraphCache();
		invalidateDepCaches();
		lastModel = undefined;
		dependencies.refresh();
		registries.refresh();
	};

	const registries = new RegistriesProvider(() => lastModel);
	context.subscriptions.push(
		vscode.window.createTreeView(REGISTRIES_VIEW_ID, {
			treeDataProvider: registries,
		}),
		registries,
		// A host added or removed in settings changes the rows, and nothing
		// else would tell the view that.
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("gapi.registries")) {
				registries.refresh();
			}
		}),
	);

	/* ---------------------------------------------------------------- *
	 * Problems
	 * ---------------------------------------------------------------- */

	const problems = new ProblemsProvider(diagnostics);
	const problemsView = vscode.window.createTreeView(PROBLEMS_VIEW_ID, {
		treeDataProvider: problems,
	});
	context.subscriptions.push(problemsView, problems);

	/* ---------------------------------------------------------------- *
	 * Details
	 * ---------------------------------------------------------------- */

	const refreshProblems = (): void => {
		problems.refresh();
		// The finding counts in the open payload came from this collection, so
		// they are stale the moment it changes.
		void DetailsPanel.refresh();
		const total = problems.total();
		problemsView.badge =
			total > 0
				? { value: total, tooltip: `${total} lint finding(s)` }
				: undefined;
	};

	/**
	 * Runs one `buf` command in a module root, asking which when there are
	 * several.
	 *
	 * A monorepo has many `buf.yaml` files and running against the wrong one
	 * writes generated code into the wrong tree, so the choice is the user's
	 * whenever it is ambiguous.
	 */
	const runInModule = async (
		label: string,
		run: (root: string) => Promise<{ ok: boolean; stderr: string }>,
	): Promise<void> => {
		const model = dependencies.current() ?? (await loadModel());
		const roots = model.modules.map((module) => module.root);
		if (roots.length === 0) {
			void vscode.window.showWarningMessage(
				"No buf module found. `buf.yaml` is what defines one.",
			);
			return;
		}
		const root =
			roots.length === 1
				? roots[0]
				: await vscode.window.showQuickPick(roots, {
						title: `Run ${label} in which module?`,
					});
		if (!root) {
			return;
		}
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `${label}…` },
			async () => {
				const result = await run(root);
				if (result.ok) {
					refreshDependencies();
					return;
				}
				const detail =
					result.stderr.trim().split("\n")[0] || "see the output channel";
				const choice = await vscode.window.showErrorMessage(
					`${label} failed: ${detail}`,
					"Show Output",
				);
				if (choice === "Show Output") {
					log.show(true);
				}
			},
		);
	};

	/**
	 * Signs in to a registry through a terminal.
	 *
	 * `buf registry login` opens a browser and then waits on a TTY for the
	 * token, so it has to run somewhere the user can type. Capturing its output
	 * instead would hang forever on a prompt nobody can see.
	 */
	const signIn = async (host: string): Promise<void> => {
		const terminal = vscode.window.createTerminal({
			name: `buf login — ${host}`,
		});
		terminal.show();
		terminal.sendText(`${bufPath()} registry login ${host}`);
	};

	/* ---------------------------------------------------------------- *
	 * Commands
	 * ---------------------------------------------------------------- */

	const registry = (): RegistryPanel =>
		RegistryPanel.show({
			extensionUri: context.extensionUri,
			loadModel,
			checkUpdates: refreshUpdates,
			onChanged: refreshDependencies,
			log,
		});

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"googleApiLinter.openRegistry",
			(host?: string) => {
				registry().focusRemote(typeof host === "string" ? host : undefined);
			},
		),

		vscode.commands.registerCommand("googleApiLinter.addRegistry", async () => {
			const host = await promptForRegistry();
			if (!host) {
				return;
			}
			registries.refresh();
			const choice = await vscode.window.showInformationMessage(
				`Added ${host}. Sign in to browse private modules.`,
				"Sign in",
				"Browse",
			);
			if (choice === "Sign in") {
				await signIn(host);
			} else if (choice === "Browse") {
				registry().focusRemote(host);
			}
		}),

		vscode.commands.registerCommand(
			"googleApiLinter.removeRegistry",
			async (node?: RegistryNode) => {
				if (node?.kind !== "registry") {
					return;
				}
				const config = vscode.workspace.getConfiguration("gapi");
				const kept = config
					.get<string[]>("registries", [])
					.filter((entry) => entry.trim().toLowerCase() !== node.host);
				await config.update(
					"registries",
					kept,
					vscode.ConfigurationTarget.Global,
				);
				registries.refresh();
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.loginRegistry",
			async (node?: RegistryNode) => {
				const host =
					node?.kind === "registry"
						? node.host
						: await vscode.window.showQuickPick(configuredRegistries(), {
								title: "Sign in to which registry?",
							});
				if (host) {
					await signIn(host);
				}
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.problems.groupByRule",
			() => {
				const grouping = problems.toggleGrouping();
				problemsView.description = grouping === "rule" ? undefined : "by file";
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.dependencies.refresh",
			() => {
				refreshDependencies();
			},
		),

		vscode.commands.registerCommand("googleApiLinter.structure.search", () =>
			searchSymbols(index),
		),

		vscode.commands.registerCommand("googleApiLinter.captureErrors", () =>
			captureErrors(diagnostics),
		),

		vscode.commands.registerCommand(
			"googleApiLinter.openDetailsToSide",
			async () => {
				DetailsPanel.show(context.extensionUri, index, diagnostics);
				await DetailsPanel.show_symbol(lastSelected);
			},
		),

		vscode.commands.registerCommand("googleApiLinter.lockDetails", () => {
			const locked = DetailsPanel.toggleLock();
			if (locked === undefined) {
				void vscode.window.showInformationMessage(
					"Open the Proto Details tab first.",
				);
			}
		}),

		vscode.commands.registerCommand(
			"googleApiLinter.generateApiReport",
			async () => {
				if (!index || index.stats().tier === "onDemand") {
					void vscode.window.showWarningMessage(
						"The API report needs the workspace index, which is not available.",
					);
					return;
				}
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Building the API report…",
					},
					async (_progress, token) => {
						const folder = vscode.workspace.workspaceFolders?.[0];
						const report = buildApiReport(index, diagnostics, {
							title: folder ? `${folder.name} — Proto API` : undefined,
							isCancelled: () => token.isCancellationRequested,
						});
						if (token.isCancellationRequested) {
							return;
						}
						// Untitled, so nothing is written to the workspace until
						// the user decides where it belongs — or whether it does.
						const document = await vscode.workspace.openTextDocument({
							language: "markdown",
							content: report.markdown,
						});
						await vscode.window.showTextDocument(document, {
							preview: false,
						});
						// The preview is the point: it renders the Mermaid graphs.
						await vscode.commands.executeCommand("markdown.showPreviewToSide");
						log.appendLine(
							`[report] ${report.stats.services} service(s), ${report.stats.rpcs} rpc(s), ` +
								`${report.stats.messages} message(s), ${report.stats.problems} finding(s)`,
						);
					},
				);
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.dependencies.generatePlugin",
			async (node?: DepNode) => {
				if (node?.kind !== "plugin") {
					void vscode.window.showInformationMessage(
						"Pick a plugin under Generate in the Dependencies view.",
					);
					return;
				}
				// The plugin's own module root, not the workspace's first one:
				// `out:` paths are relative to the buf.gen.yaml that declared them.
				const root = dirOf(node.configPath);
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `buf generate — ${node.plugin.ref}`,
					},
					async () => {
						const result = await generatePlugin(
							node.configPath,
							node.plugin.ref,
							root,
							log,
						);
						if (result.ok) {
							void vscode.window.showInformationMessage(
								`Generated ${node.plugin.ref} into ${node.plugin.out}`,
							);
							return;
						}
						const detail =
							result.stderr.trim().split("\n")[0] || "see the output channel";
						const choice = await vscode.window.showErrorMessage(
							`buf generate failed: ${detail}`,
							"Show Output",
						);
						if (choice === "Show Output") {
							log.show(true);
						}
					},
				);
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.dependencies.update",
			async () => {
				await runInModule("buf dep update", (root) =>
					updateDependencies(root, log),
				);
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.dependencies.generate",
			async () => {
				await runInModule("buf generate", (root) => generate(root, log));
			},
		),

		vscode.commands.registerCommand(
			"googleApiLinter.dependencies.checkUpdates",
			async () => {
				await vscode.window.withProgress(
					{
						location: { viewId: DEPENDENCIES_VIEW_ID },
						title: "Checking the registry…",
					},
					async () => {
						try {
							await refreshUpdates();
							dependencies.refresh();
						} catch (error) {
							void vscode.window.showErrorMessage(
								`Could not check for updates: ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						}
					},
				);
			},
		),
	);

	return {
		showSymbol: (fqn) => {
			lastSelected = fqn ?? lastSelected;
			// The tab follows the tree whenever it is open and unlocked. When it
			// is closed this costs nothing: no payload is built for a panel that
			// is not there to render it.
			void DetailsPanel.show_symbol(fqn);
		},
		refreshProblems,
		refreshDependencies,
	};
}
