/**
 * The Dependencies view.
 *
 * This replaces a section that reported a hardcoded `count: 2` — the googleapis
 * and protobuf download commits — while the workspace's actual buf dependencies
 * were parsed elsewhere and thrown away. Everything here comes from
 * `buf.yaml`, `buf.lock`, `buf.gen.yaml` and the buf module cache.
 *
 * The model is supplied rather than built: assembling it touches the filesystem
 * and, when update status is wanted, the network. A tree provider is the wrong
 * place to own either.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type {
	BufDep,
	DependencyModel,
	GenConfig,
	GenPlugin,
} from "../shared/protocol";

/** View id, matching `contributes.views` in package.json. */
export const DEPENDENCIES_VIEW_ID = "googleApiLinter.views.dependencies";

/** A node in the Dependencies tree. */
export type DepNode =
	| {
			kind: "section";
			id: "declared" | "generate" | "undeclared" | "runtime";
			label: string;
			count: number;
			icon: string;
	  }
	| { kind: "module"; root: string; name?: string; deps: readonly BufDep[] }
	| { kind: "dep"; dep: BufDep }
	| { kind: "gen"; config: GenConfig }
	| { kind: "runtime"; name: string; commit: string; detail: string }
	| { kind: "plugin"; plugin: GenPlugin; configPath: string }
	| {
			kind: "info";
			label: string;
			detail?: string;
			icon: string;
			tooltip?: string;
	  };

/** How each dependency state is presented. */
const STATE_PRESENTATION: Record<
	BufDep["state"],
	{ icon: string; color?: string; note: string }
> = {
	declared: { icon: "package", note: "declared in buf.yaml" },
	missing: {
		icon: "question",
		color: "editorWarning.foreground",
		note: "declared but not in the module cache — run buf dep update",
	},
	cached: {
		icon: "package",
		color: "descriptionForeground",
		note: "in the module cache, not declared",
	},
	orphaned: {
		icon: "warning",
		color: "editorError.foreground",
		note: "cached, but the registry says it no longer exists",
	},
};

/** `004180b77378443887d3b55cabc00384` → `004180b7`. */
function shortCommit(commit: string): string {
	return commit.slice(0, 8);
}

export class DependenciesProvider
	implements vscode.TreeDataProvider<DepNode>, vscode.Disposable
{
	private readonly emitter = new vscode.EventEmitter<DepNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;

	private model: DependencyModel | undefined;
	private loading = false;

	constructor(
		private readonly load: () => Promise<DependencyModel>,
		/**
		 * The vendored googleapis and protobuf checkouts under `~/.gapi`.
		 *
		 * Not buf modules, but dependencies all the same: they are what the
		 * linter resolves `import "google/api/..."` against, so a mismatch here
		 * produces errors that look like they come from the workspace.
		 */
		private readonly runtime?: {
			googleapis: () => Promise<string>;
			protobuf: () => Promise<string>;
		},
	) {}

	/** Drop the cached model and redraw. */
	refresh(): void {
		this.model = undefined;
		this.emitter.fire(undefined);
	}

	/** The model as last loaded, for commands that act on it. */
	current(): DependencyModel | undefined {
		return this.model;
	}

	getTreeItem(node: DepNode): vscode.TreeItem {
		if (node.kind === "section") {
			const item = new vscode.TreeItem(
				node.label,
				node.count > 0
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.None,
			);
			item.description = String(node.count);
			item.iconPath = new vscode.ThemeIcon(node.icon);
			item.contextValue = `depSection:${node.id}`;
			return item;
		}

		if (node.kind === "module") {
			const item = new vscode.TreeItem(
				node.name ?? path.basename(node.root),
				vscode.TreeItemCollapsibleState.Expanded,
			);
			item.description = `${node.deps.length} dep${node.deps.length === 1 ? "" : "s"}`;
			item.iconPath = new vscode.ThemeIcon("file-directory");
			item.resourceUri = vscode.Uri.file(node.root);
			item.contextValue = "depModule";
			item.tooltip = new vscode.MarkdownString(`\`${node.root}\``);
			return item;
		}

		if (node.kind === "dep") {
			const { dep } = node;
			const presentation = STATE_PRESENTATION[dep.state];
			const item = new vscode.TreeItem(
				`${dep.owner}/${dep.module}`,
				vscode.TreeItemCollapsibleState.None,
			);

			const parts: string[] = [];
			if (dep.commit) {
				parts.push(shortCommit(dep.commit));
			}
			if (dep.protoCount !== undefined) {
				parts.push(`${dep.protoCount} protos`);
			}
			// "8 behind" is the whole reason to look at this view, so it goes
			// last where the eye lands rather than being buried in a tooltip.
			if (dep.update?.behind) {
				parts.push(`↑${dep.update.behind}`);
			}
			item.description = parts.join(" · ");

			item.iconPath = new vscode.ThemeIcon(
				presentation.icon,
				presentation.color
					? new vscode.ThemeColor(presentation.color)
					: undefined,
			);
			item.contextValue = `dep:${dep.state}`;

			const lines = [`**${dep.name}**`, "", presentation.note];
			if (dep.commit) {
				lines.push("", `commit \`${dep.commit}\``);
			}
			if (dep.digest) {
				lines.push(`digest \`${dep.digest.slice(0, 23)}…\``);
			}
			if (dep.update?.error) {
				lines.push("", `⚠ ${dep.update.error}`);
			} else if (dep.update?.behind) {
				lines.push(
					"",
					`${dep.update.behind} commit(s) behind \`${shortCommit(dep.update.latestCommit)}\` (${dep.update.latestTime.slice(0, 10)})`,
				);
			}
			if (dep.cachePath) {
				lines.push("", `\`${dep.cachePath}\``);
			}
			item.tooltip = new vscode.MarkdownString(lines.join("\n"));

			if (dep.cachePath) {
				item.command = {
					command: "revealFileInOS",
					title: "Reveal in Finder",
					arguments: [vscode.Uri.file(dep.cachePath)],
				};
			}
			return item;
		}

		if (node.kind === "runtime") {
			const item = new vscode.TreeItem(
				node.name,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = node.commit ? shortCommit(node.commit) : node.detail;
			item.iconPath = new vscode.ThemeIcon(
				"library",
				new vscode.ThemeColor("descriptionForeground"),
			);
			item.contextValue = "runtimeDep";
			item.tooltip = new vscode.MarkdownString(
				[`**${node.name}**`, "", node.detail, "", `\`${node.commit}\``].join(
					"\n",
				),
			);
			return item;
		}

		if (node.kind === "gen") {
			const item = new vscode.TreeItem(
				path.basename(node.config.path),
				vscode.TreeItemCollapsibleState.Expanded,
			);
			const bits = [node.config.version];
			if (node.config.managed) {
				bits.push("managed");
			}
			bits.push(`${node.config.plugins.length} plugins`);
			item.description = bits.join(" · ");
			item.iconPath = new vscode.ThemeIcon("file-code");
			item.resourceUri = vscode.Uri.file(node.config.path);
			item.contextValue = "genConfig";
			item.command = {
				command: "vscode.open",
				title: "Open",
				arguments: [vscode.Uri.file(node.config.path)],
			};
			return item;
		}

		if (node.kind === "plugin") {
			const item = new vscode.TreeItem(
				node.plugin.ref,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = `→ ${node.plugin.out}`;
			item.iconPath = new vscode.ThemeIcon(
				"plug",
				new vscode.ThemeColor("symbolIcon.methodForeground"),
			);
			item.contextValue = `genPlugin:${node.plugin.kind}`;
			const lines = [
				`**${node.plugin.ref}**`,
				"",
				`kind \`${node.plugin.kind}\``,
				`out \`${node.plugin.out}\``,
			];
			if (node.plugin.opt.length > 0) {
				lines.push("", ...node.plugin.opt.map((o) => `- \`${o}\``));
			}
			item.tooltip = new vscode.MarkdownString(lines.join("\n"));
			return item;
		}

		const item = new vscode.TreeItem(
			node.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.description = node.detail;
		item.iconPath = new vscode.ThemeIcon(node.icon);
		if (node.tooltip) {
			item.tooltip = new vscode.MarkdownString(node.tooltip);
		}
		return item;
	}

	async getChildren(node?: DepNode): Promise<DepNode[]> {
		const model = await this.ensureModel();
		if (!model) {
			return [
				{
					kind: "info",
					label: "Could not read buf configuration",
					icon: "circle-slash",
					tooltip: "No `buf.yaml` was found, or it could not be parsed.",
				},
			];
		}

		if (!node) {
			return this.rootNodes(model);
		}

		if (node.kind === "section") {
			if (node.id === "declared") {
				// One module needs no grouping level; several do.
				return model.modules.length === 1
					? model.modules[0].deps.map((dep) => ({ kind: "dep" as const, dep }))
					: model.modules.map((m) => ({
							kind: "module" as const,
							root: m.root,
							name: m.name,
							deps: m.deps,
						}));
			}
			if (node.id === "generate") {
				return model.gen.map((config) => ({ kind: "gen" as const, config }));
			}
			if (node.id === "runtime") {
				return this.runtimeNodes();
			}
			return model.undeclared.map((dep) => ({ kind: "dep" as const, dep }));
		}

		if (node.kind === "module") {
			return node.deps.map((dep) => ({ kind: "dep" as const, dep }));
		}

		if (node.kind === "gen") {
			return node.config.plugins.map((plugin) => ({
				kind: "plugin" as const,
				plugin,
				configPath: node.config.path,
			}));
		}

		return [];
	}

	private rootNodes(model: DependencyModel): DepNode[] {
		const declared = model.modules.reduce((n, m) => n + m.deps.length, 0);
		const nodes: DepNode[] = [
			{
				kind: "section",
				id: "declared",
				label: "Declared",
				count: declared,
				icon: "package",
			},
		];

		if (model.gen.length > 0) {
			nodes.push({
				kind: "section",
				id: "generate",
				label: "Generate",
				count: model.gen.reduce((n, g) => n + g.plugins.length, 0),
				icon: "file-code",
			});
		}

		if (model.undeclared.length > 0) {
			nodes.push({
				kind: "section",
				id: "undeclared",
				label: "Cached, not declared",
				count: model.undeclared.length,
				icon: "archive",
			});
		}

		if (declared === 0 && model.undeclared.length === 0) {
			nodes.push({
				kind: "info",
				label: "No buf dependencies",
				detail: "buf.yaml declares none",
				icon: "info",
				tooltip:
					"Add a module to `deps:` in `buf.yaml`, or open the Proto Registry to browse what is available.",
			});
		}

		if (this.runtime) {
			nodes.push({
				kind: "section",
				id: "runtime",
				label: "Import roots",
				count: 2,
				icon: "library",
			});
		}

		if (!model.updatesChecked) {
			nodes.push({
				kind: "info",
				label: "Update status not checked",
				detail: "runs on demand",
				icon: "sync-ignored",
				tooltip:
					"Checking asks the registry for each module's newest commit, so it is never run on activation. Use **Check for Dependency Updates** in the view title.",
			});
		}

		return nodes;
	}

	/** The vendored checkouts, read from the download manager's metadata. */
	private async runtimeNodes(): Promise<DepNode[]> {
		if (!this.runtime) {
			return [];
		}
		const [googleapis, protobuf] = await Promise.all([
			this.runtime.googleapis().catch(() => ""),
			this.runtime.protobuf().catch(() => ""),
		]);
		return [
			{
				kind: "runtime",
				name: "googleapis",
				commit: googleapis,
				detail: googleapis ? "vendored in ~/.gapi" : "not installed",
			},
			{
				kind: "runtime",
				name: "protobuf",
				commit: protobuf,
				detail: protobuf ? "vendored in ~/.gapi" : "not installed",
			},
		];
	}

	/** Loads the model once and caches it until {@link refresh}. */
	private async ensureModel(): Promise<DependencyModel | undefined> {
		if (this.model) {
			return this.model;
		}
		if (this.loading) {
			return undefined;
		}
		this.loading = true;
		try {
			this.model = await this.load();
			return this.model;
		} catch {
			return undefined;
		} finally {
			this.loading = false;
		}
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
