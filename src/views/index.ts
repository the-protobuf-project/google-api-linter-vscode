/**
 * Wiring for the Proto container's views.
 *
 * One function so `extension.ts` gains a call rather than eighty lines: the
 * four views share a diagnostic collection, a dependency model and a set of
 * commands, and keeping that graph in one place is what stops the activation
 * path from turning into a second copy of it.
 */

import * as vscode from "vscode";
import {
	buildDependencyModel,
	checkUpdates,
	invalidateDepCaches,
} from "../deps";
import type { ProtoIndex } from "../index/types";
import type { DependencyModel } from "../shared/protocol";
import { invalidateModuleGraphCache } from "../utils/moduleGraph";
import { DEPENDENCIES_VIEW_ID, DependenciesProvider } from "./dependenciesView";
import { DETAILS_VIEW_ID, DetailsViewProvider } from "./detailsView";
import { PROBLEMS_VIEW_ID, ProblemsProvider } from "./problemsView";
import { RegistryPanel } from "./registryPanel";

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

	const loadModel = async (): Promise<DependencyModel> => {
		lastModel = await buildDependencyModel({ log });
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
	};

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

	const details = new DetailsViewProvider(
		context.extensionUri,
		index,
		diagnostics,
	);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(DETAILS_VIEW_ID, details),
		details,
	);

	const refreshProblems = (): void => {
		problems.refresh();
		// The finding counts in the open payload came from this collection, so
		// they are stale the moment it changes.
		details.refresh();
		const total = problems.total();
		problemsView.badge =
			total > 0
				? { value: total, tooltip: `${total} lint finding(s)` }
				: undefined;
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
		vscode.commands.registerCommand("googleApiLinter.openRegistry", () => {
			registry();
		}),

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
		showSymbol: (fqn) => details.show(fqn),
		refreshProblems,
		refreshDependencies,
	};
}
