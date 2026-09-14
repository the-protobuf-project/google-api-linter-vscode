/**
 * The Registries view: which schema registries this workspace browses.
 *
 * Small on purpose. It is a launcher and a settings surface, not a third place
 * to read dependency state — clicking a row opens the Registry tab scoped to
 * that host, and everything else about a module is read there.
 *
 * Custom registries are first-class rather than a special case. `buf` addresses
 * every module as `<remote>/<owner>/<module>` and caches it under that same
 * three-level path, so a self-hosted BSR differs from `buf.build` only in the
 * first segment.
 */

import * as vscode from "vscode";
import type { DependencyModel } from "../shared/protocol";

/** View id, matching `contributes.views` in package.json. */
export const REGISTRIES_VIEW_ID = "googleApiLinter.views.registries";

/** The registry every buf install talks to unless told otherwise. */
export const DEFAULT_REGISTRY = "buf.build";

/** A node in the Registries tree. */
export type RegistryNode =
	| {
			kind: "registry";
			host: string;
			/** Modules in the model that come from this host. */
			modules: number;
			/** True when it is the built-in default rather than user-added. */
			builtIn: boolean;
	  }
	| { kind: "add" };

/**
 * The configured registry hosts, always including the default.
 *
 * Deduplicated and normalised: a user typing `https://buf.example.com/` means
 * the same host as `buf.example.com`, and two rows for one registry would
 * produce two identical panels.
 */
export function configuredRegistries(): string[] {
	const configured = vscode.workspace
		.getConfiguration("gapi")
		.get<string[]>("registries", []);
	const seen = new Set<string>([DEFAULT_REGISTRY]);
	const out = [DEFAULT_REGISTRY];
	for (const entry of configured) {
		const host = normaliseHost(entry);
		if (host && !seen.has(host)) {
			seen.add(host);
			out.push(host);
		}
	}
	return out;
}

/**
 * A bare host, or `undefined` when the input is not one.
 *
 * @param value - What the user typed
 * @returns The host without scheme, path or trailing slash
 */
export function normaliseHost(value: string): string | undefined {
	const trimmed = value
		.trim()
		.replace(/^[a-z]+:\/\//i, "")
		.replace(/\/.*$/, "");
	if (trimmed.length === 0 || trimmed.includes(" ")) {
		return undefined;
	}
	// A registry is a host, so it must at least look like one. Rejecting here
	// beats letting `buf` fail later with a network error that says nothing
	// about the typo that caused it.
	return /^[\w.-]+\.[\w-]+$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export class RegistriesProvider
	implements vscode.TreeDataProvider<RegistryNode>, vscode.Disposable
{
	private readonly emitter = new vscode.EventEmitter<
		RegistryNode | undefined
	>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly model: () => DependencyModel | undefined) {}

	refresh(): void {
		this.emitter.fire(undefined);
	}

	getTreeItem(node: RegistryNode): vscode.TreeItem {
		if (node.kind === "add") {
			const item = new vscode.TreeItem(
				"Add a registry…",
				vscode.TreeItemCollapsibleState.None,
			);
			item.iconPath = new vscode.ThemeIcon("add");
			item.contextValue = "addRegistry";
			item.command = {
				command: "googleApiLinter.addRegistry",
				title: "Add a registry",
			};
			item.tooltip = new vscode.MarkdownString(
				"Point at a self-hosted Buf Schema Registry. Stored in `gapi.registries`.",
			);
			return item;
		}

		const item = new vscode.TreeItem(
			node.host,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description =
			node.modules > 0
				? `${node.modules} module${node.modules === 1 ? "" : "s"}`
				: undefined;
		item.iconPath = new vscode.ThemeIcon(
			"cloud",
			node.modules > 0
				? new vscode.ThemeColor("symbolIcon.classForeground")
				: new vscode.ThemeColor("descriptionForeground"),
		);
		item.contextValue = node.builtIn ? "registry:builtin" : "registry:custom";
		item.command = {
			command: "googleApiLinter.openRegistry",
			title: "Browse this registry",
			arguments: [node.host],
		};
		item.tooltip = new vscode.MarkdownString(
			[
				`**${node.host}**`,
				"",
				node.builtIn
					? "The default Buf Schema Registry."
					: "A custom registry from `gapi.registries`.",
				"",
				`Sign in with \`buf registry login ${node.host}\`.`,
			].join("\n"),
		);
		return item;
	}

	getChildren(node?: RegistryNode): RegistryNode[] {
		if (node) {
			return [];
		}
		const model = this.model();
		const counts = new Map<string, number>();
		if (model) {
			const every = [
				...model.modules.flatMap((module) => module.deps),
				...model.undeclared,
			];
			for (const dep of every) {
				if (dep.remote) {
					counts.set(dep.remote, (counts.get(dep.remote) ?? 0) + 1);
				}
			}
		}

		const rows: RegistryNode[] = configuredRegistries().map((host) => ({
			kind: "registry" as const,
			host,
			modules: counts.get(host) ?? 0,
			builtIn: host === DEFAULT_REGISTRY,
		}));

		// A host this workspace actually depends on but nobody configured is
		// still real; listing it beats pretending the dependency came from
		// somewhere else.
		for (const [host, modules] of counts) {
			if (!rows.some((row) => row.kind === "registry" && row.host === host)) {
				rows.push({ kind: "registry", host, modules, builtIn: false });
			}
		}

		rows.push({ kind: "add" });
		return rows;
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

/**
 * Asks for a registry host and stores it.
 *
 * @returns The host that was added, or `undefined` when cancelled
 */
export async function promptForRegistry(): Promise<string | undefined> {
	const entered = await vscode.window.showInputBox({
		title: "Add a schema registry",
		prompt: "Host of a Buf Schema Registry",
		placeHolder: "buf.example.com",
		validateInput: (value) =>
			value.trim().length === 0 || normaliseHost(value)
				? undefined
				: "That does not look like a host, e.g. buf.example.com",
	});
	if (!entered) {
		return undefined;
	}
	const host = normaliseHost(entered);
	if (!host) {
		return undefined;
	}

	const config = vscode.workspace.getConfiguration("gapi");
	const existing = config.get<string[]>("registries", []);
	if (!existing.some((entry) => normaliseHost(entry) === host)) {
		// Global rather than workspace: a registry is an account-level fact, and
		// storing it per-workspace would make the user re-add it in every repo.
		await config.update(
			"registries",
			[...existing, host],
			vscode.ConfigurationTarget.Global,
		);
	}
	return host;
}
