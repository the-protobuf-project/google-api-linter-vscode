import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "./constants";
import type { ProtoIndex } from "./index/types";
import {
	annotationLocationItem,
	buildServiceItem,
	collectAnnotationNamespaces,
	collectAnnotationsIn,
	collectMessageMembers,
	collectResources,
	collectSymbolsOfKind,
	DEFAULT_PROTO_VIEW_FILE_CEILING,
	type LocationItem,
	MAX_SECTION_SYMBOLS,
	type RpcItem,
	type ServiceItem,
	toLocationItem,
	toRpcLocationItem,
} from "./protoScanner";
import {
	findGapiConfigFile,
	findGapiConfigFileInFolder,
} from "./utils/configReader";
import { findProtoFiles, findProtoFilesInFolder } from "./utils/fileUtils";
import { invalidateProtoImportRootsCache } from "./utils/protoImportRoots";

/** Milliseconds to coalesce structural refreshes over. */
const STRUCTURE_REFRESH_DEBOUNCE_MS = 400;

/** Milliseconds to coalesce diagnostic-driven label refreshes over. */
const DIAGNOSTIC_REFRESH_DEBOUNCE_MS = 350;

/** Top-level sections the view can offer. */
export type ProtoSectionId =
	| "services"
	| "rpcs"
	| "resources"
	| "messages"
	| "enums"
	| "annotations"
	| "files"
	| "deps";

/** Sections that enumerate symbols and are therefore subject to the ceiling. */
const SYMBOL_SECTIONS: ReadonlySet<ProtoSectionId> = new Set<ProtoSectionId>([
	"services",
	"rpcs",
	"resources",
	"messages",
	"enums",
	"annotations",
]);

export type ProtoTreeNode =
	| {
			kind: "status";
			label: string;
			version?: string;
			detail?: string;
			icon: string;
	  }
	| {
			kind: "init";
			label: string;
			detail: string;
			icon: string;
			folderUri?: vscode.Uri;
	  }
	| {
			/** Non-actionable explanation: a ceiling, a cap, or a disabled index. */
			kind: "info";
			label: string;
			detail?: string;
			icon: string;
			tooltip?: string;
	  }
	| {
			kind: "file";
			uri: vscode.Uri;
			errorCount: number;
			warningCount: number;
			folderName?: string;
	  }
	| {
			kind: "diagnostic";
			uri: vscode.Uri;
			range: vscode.Range;
			message: string;
			severity: vscode.DiagnosticSeverity;
			code?: string | number;
	  }
	| {
			kind: "section";
			id: ProtoSectionId;
			label: string;
			/** Undefined until the section has been expanded at least once. */
			count?: number;
			icon: string;
	  }
	| { kind: "dep"; name: string; commit: string }
	| { kind: "service"; service: ServiceItem }
	| { kind: "rpc"; rpc: RpcItem; serviceName: string }
	| {
			kind: "rpcDetail";
			type: "request" | "response";
			typeName: string;
			uri?: vscode.Uri;
			range?: vscode.Range;
			/** Fallback when type not resolved: go to RPC line */
			rpcUri?: vscode.Uri;
			rpcRange?: vscode.Range;
	  }
	| {
			/** One annotation namespace, e.g. `mcp.v1`. Derived, never hardcoded. */
			kind: "annotationNamespace";
			namespace: string;
			count: number;
	  }
	| { kind: "location"; item: LocationItem }
	| {
			kind: "messageField";
			label: string;
			type: string;
			uri: vscode.Uri;
			range: vscode.Range;
	  }
	| { kind: "messageEnum"; label: string; uri: vscode.Uri; range: vscode.Range }
	| { kind: "folder"; name: string; uri: vscode.Uri }
	| { kind: "action"; command: string; label: string; icon: string };

/** A leaf node explaining that a section refused to enumerate. */
function infoNode(
	label: string,
	detail?: string,
	icon = "info",
	tooltip?: string,
): ProtoTreeNode {
	return { kind: "info", label, detail, icon, tooltip };
}

/** A leaf node saying how much of a known total is actually shown. */
function truncatedNode(
	shown: number,
	total: number,
	noun: string,
): ProtoTreeNode {
	return infoNode(
		`Showing ${shown} of ${total} ${noun}`,
		"list truncated",
		"list-flat",
		`The Proto view lists at most ${shown} ${noun}. ${total - shown} more exist in this workspace.`,
	);
}

/** A leaf node saying a per-section cap cut the list short at an unknown total. */
function cappedNode(shown: number, cap: number, noun: string): ProtoTreeNode {
	return infoNode(
		`Showing first ${shown} of more ${noun}`,
		`capped at ${cap}`,
		"list-flat",
		`This section stops at ${cap} ${noun} so the tree cannot grow unbounded. Narrow the workspace to see the rest.`,
	);
}

/**
 * The Proto view.
 *
 * Two rules shape this class:
 *
 *   1. **Nothing is computed until it is expanded.** Building the root costs a
 *      config lookup and `index.stats()`; every symbol list is derived on the
 *      `getChildren` call for its section and cached until the index changes.
 *   2. **No document is ever opened in a loop.** All symbol data comes from the
 *      in-memory {@link ProtoIndex}. The old implementation opened one
 *      TextDocument per workspace proto, which VS Code never releases.
 */
export class ProtoTreeDataProvider
	implements vscode.TreeDataProvider<ProtoTreeNode>, vscode.Disposable
{
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		ProtoTreeNode | undefined | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** Children per expanded section, dropped whenever the index changes. */
	private readonly sectionCache = new Map<ProtoSectionId, ProtoTreeNode[]>();
	/** Counts learned by expanding a section, used to label it afterwards. */
	private readonly sectionCounts = new Map<ProtoSectionId, number>();
	private readonly indexSubscription: { dispose(): void } | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly diagnosticCollection: vscode.DiagnosticCollection,
		private getBinaryVersion: () => Promise<string>,
		private getGoogleapisCommit: () => Promise<string>,
		private getProtobufCommit: () => Promise<string>,
		private readonly resolveTypeToLocation?: (
			typeName: string,
			contextUri: vscode.Uri,
		) => Promise<vscode.Location | null>,
		private readonly index?: ProtoIndex,
		private readonly fileCeiling: number = DEFAULT_PROTO_VIEW_FILE_CEILING,
	) {
		this.indexSubscription = this.index?.onDidChange(() => {
			this.refreshStructureSoon();
		});
	}

	/** Full refresh (config / index / protos structure changed). */
	refreshStructure(): void {
		this.sectionCache.clear();
		this.sectionCounts.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * Debounced {@link refreshStructure}. Watchers fire in bursts — one
	 * `buf.lock` write used to trigger a full rescan per event.
	 */
	refreshStructureSoon(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.refreshStructure();
		}, STRUCTURE_REFRESH_DEBOUNCE_MS);
	}

	/** Tree labels only (e.g. diagnostic counts); keeps derived section data. */
	refreshPresentation(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Drops timers and the index subscription. */
	dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.indexSubscription?.dispose();
		this._onDidChangeTreeData.dispose();
	}

	/** The index, or undefined when there is no usable workspace index. */
	private usableIndex(): ProtoIndex | undefined {
		if (!this.index) {
			return undefined;
		}
		return this.index.stats().tier === "onDemand" ? undefined : this.index;
	}

	/** Indexed proto count, or undefined when the index is unusable. */
	private indexedFileCount(): number | undefined {
		return this.usableIndex()?.stats().fileCount;
	}

	/** True when the workspace is too large to enumerate symbols for. */
	private overCeiling(): boolean {
		const count = this.indexedFileCount();
		return count !== undefined && count > this.fileCeiling;
	}

	/** The single child a symbol section shows instead of hanging. */
	private ceilingNode(): ProtoTreeNode {
		const count = this.indexedFileCount() ?? 0;
		return infoNode(
			`${count} proto files exceeds the view limit of ${this.fileCeiling}`,
			"section not enumerated",
			"warning",
			`The Proto view stops enumerating symbols above ${this.fileCeiling} files so the tree cannot stall the extension host. Open a narrower folder, or raise the ceiling the view was constructed with.`,
		);
	}

	/** The single child every symbol section shows when there is no index. */
	private noIndexNode(): ProtoTreeNode {
		const reason = this.index?.stats().degradeReason;
		return infoNode(
			this.index
				? "Workspace index is running on demand"
				: "Workspace index unavailable",
			reason ?? "symbol sections disabled",
			"circle-slash",
			`Workspace symbol sections read the in-memory index; they never open documents. ${
				reason ?? "No index is attached to this view."
			}`,
		);
	}

	getTreeItem(element: ProtoTreeNode): vscode.TreeItem {
		if (element.kind === "status") {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = element.detail ?? element.version;
			item.iconPath = new vscode.ThemeIcon(element.icon);
			return item;
		}
		if (element.kind === "info") {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = element.detail;
			item.iconPath = new vscode.ThemeIcon(element.icon);
			item.tooltip = new vscode.MarkdownString(
				element.tooltip ?? element.label,
			);
			return item;
		}
		if (element.kind === "dep") {
			const item = new vscode.TreeItem(
				element.name,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = element.commit.slice(0, 7);
			item.iconPath = new vscode.ThemeIcon(
				"circle-filled",
				new vscode.ThemeColor("terminal.ansiCyan"),
			);
			return item;
		}
		if (element.kind === "init") {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = element.detail;
			item.iconPath = new vscode.ThemeIcon(element.icon);
			item.command = {
				command: "googleApiLinter.initWorkspace",
				title: "Initialize",
				arguments: element.folderUri ? [element.folderUri] : undefined,
			};
			return item;
		}
		if (element.kind === "file") {
			const { uri, errorCount, warningCount, folderName } = element;
			const label =
				folderName != null
					? vscode.workspace.asRelativePath(uri, false).replace(/^[^/]+?\//, "")
					: vscode.workspace.asRelativePath(uri);
			const hasDiag = errorCount > 0 || warningCount > 0;
			const item = new vscode.TreeItem(
				label,
				hasDiag
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None,
			);
			item.resourceUri = uri;
			item.description = hasDiag
				? `${errorCount} error(s), ${warningCount} warning(s)`
				: "OK";
			// Pastel colors: cyan = OK, magenta = warning, blue = error
			if (errorCount > 0) {
				item.iconPath = new vscode.ThemeIcon(
					"circle-filled",
					new vscode.ThemeColor("terminal.ansiBlue"),
				);
			} else if (warningCount > 0) {
				item.iconPath = new vscode.ThemeIcon(
					"circle-filled",
					new vscode.ThemeColor("terminal.ansiMagenta"),
				);
			} else {
				item.iconPath = new vscode.ThemeIcon(
					"circle-filled",
					new vscode.ThemeColor("terminal.ansiCyan"),
				);
			}
			item.command = {
				command: "vscode.open",
				title: "Open",
				arguments: [uri],
			};
			return item;
		}
		if (element.kind === "diagnostic") {
			const item = new vscode.TreeItem(
				element.message.slice(0, 60) + (element.message.length > 60 ? "…" : ""),
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = `L${element.range.start.line + 1}`;
			const isError = element.severity === vscode.DiagnosticSeverity.Error;
			item.iconPath = new vscode.ThemeIcon(
				isError ? "error" : "warning",
				new vscode.ThemeColor(
					isError ? "terminal.ansiBlue" : "terminal.ansiMagenta",
				),
			);
			item.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to",
				arguments: [element.uri, element.range],
			};
			return item;
		}
		if (element.kind === "folder") {
			const item = new vscode.TreeItem(
				element.name,
				vscode.TreeItemCollapsibleState.Expanded,
			);
			item.iconPath = vscode.ThemeIcon.Folder;
			return item;
		}
		if (element.kind === "section") {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			const count = element.count ?? this.sectionCounts.get(element.id);
			item.description = count === undefined ? undefined : `${count}`;
			const sectionColors: Record<string, string> = {
				services: "symbolIcon.interfaceForeground",
				resources: "symbolIcon.classForeground",
				annotations: "symbolIcon.keywordForeground",
				messages: "symbolIcon.classForeground",
				enums: "symbolIcon.enumForeground",
				deps: "terminal.ansiCyan",
				files: "symbolIcon.fileForeground",
				rpcs: "terminal.ansiMagenta",
			};
			const color = sectionColors[element.id];
			item.iconPath = new vscode.ThemeIcon(
				element.icon,
				color ? new vscode.ThemeColor(color) : undefined,
			);
			const sectionDescriptions: Record<string, string> = {
				services: "Services with RPCs (expand to see Request/Response)",
				resources: "Messages with google.api.resource",
				annotations:
					"Custom options, grouped by namespace — derived from their extend blocks",
				files: "Proto files (cyan=OK, magenta=warning, blue=error)",
				enums: "Enum definitions",
				deps: "Dependencies (googleapis, protobuf); cyan when downloaded",
				rpcs: "RPC methods in services",
				messages: "Proto messages (expand for fields and enums)",
			};
			item.tooltip = sectionDescriptions[element.id] ?? element.label;
			return item;
		}
		if (element.kind === "annotationNamespace") {
			const item = new vscode.TreeItem(
				element.namespace,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.description = `${element.count}`;
			item.iconPath = new vscode.ThemeIcon(
				"symbol-namespace",
				new vscode.ThemeColor("symbolIcon.keywordForeground"),
			);
			item.tooltip = new vscode.MarkdownString(
				`Annotation namespace **${element.namespace}** — ${element.count} custom option(s), discovered from \`extend google.protobuf.*Options\` blocks.`,
			);
			return item;
		}
		if (element.kind === "service") {
			const item = new vscode.TreeItem(
				element.service.name,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.description = `${element.service.rpcs.length} RPC(s)`;
			item.iconPath = new vscode.ThemeIcon(
				"symbol-interface",
				new vscode.ThemeColor("symbolIcon.interfaceForeground"),
			);
			item.tooltip = new vscode.MarkdownString(
				`Service **${element.service.name}**\n\nClick to go to definition in file.`,
			);
			item.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to definition",
				arguments: [element.service.uri, element.service.range],
			};
			return item;
		}
		if (element.kind === "rpc") {
			const item = new vscode.TreeItem(
				element.rpc.name,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.description = element.rpc.detail;
			item.iconPath = new vscode.ThemeIcon(
				"symbol-method",
				new vscode.ThemeColor("terminal.ansiMagenta"),
			);
			item.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to",
				arguments: [element.rpc.uri, element.rpc.range],
			};
			item.tooltip = new vscode.MarkdownString(
				element.rpc.documentation
					? `${element.rpc.documentation}\n\n\`${element.rpc.detail}\`\n\nClick to go to RPC in file.`
					: `RPC **${element.rpc.name}**\n\n\`${element.rpc.detail}\`\n\nClick to go to definition in file.`,
			);
			return item;
		}
		if (element.kind === "rpcDetail") {
			const label =
				element.type === "request"
					? `Request: ${element.typeName}`
					: `Response: ${element.typeName}`;
			const item = new vscode.TreeItem(
				label,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = element.typeName;
			const hasTypeLoc = element.uri && element.range;
			item.tooltip = new vscode.MarkdownString(
				hasTypeLoc
					? `${element.type === "request" ? "Request" : "Response"} message type: **${element.typeName}**\n\nClick to go to definition in file.`
					: `**${element.typeName}**\n\nType definition not found; click to go to RPC in file.`,
			);
			item.iconPath = new vscode.ThemeIcon(
				"symbol-class",
				new vscode.ThemeColor(
					element.type === "request"
						? "symbolIcon.functionForeground"
						: "symbolIcon.methodForeground",
				),
			);
			if (hasTypeLoc) {
				item.command = {
					command: "googleApiLinter.revealLocation",
					title: "Go to type definition",
					arguments: [element.uri, element.range],
				};
			} else if (element.rpcUri && element.rpcRange) {
				item.command = {
					command: "googleApiLinter.revealLocation",
					title: "Go to RPC",
					arguments: [element.rpcUri, element.rpcRange],
				};
			}
			return item;
		}
		if (element.kind === "location") {
			const { item: loc } = element;
			const expandable = loc.expandable === true;
			const treeItem = new vscode.TreeItem(
				loc.label,
				expandable
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None,
			);
			treeItem.description = loc.detail;
			treeItem.iconPath = new vscode.ThemeIcon(
				loc.icon,
				expandable
					? new vscode.ThemeColor("symbolIcon.classForeground")
					: undefined,
			);
			treeItem.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to",
				arguments: [loc.uri, loc.range],
			};
			if (loc.documentation || loc.detail) {
				treeItem.tooltip = new vscode.MarkdownString(
					(loc.documentation
						? `${loc.documentation}\n\n\`${loc.detail ?? ""}\``
						: (loc.detail ?? loc.label)) +
						"\n\nClick to go to definition in file.",
				);
			} else {
				treeItem.tooltip = new vscode.MarkdownString(
					`**${loc.label}**\n\nClick to go to definition in file.`,
				);
			}
			return treeItem;
		}
		if (element.kind === "messageField") {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = element.type;
			item.tooltip = new vscode.MarkdownString(
				`Field **${element.label}**: \`${element.type}\`\n\nClick to go to definition in file.`,
			);
			item.iconPath = new vscode.ThemeIcon(
				"symbol-field",
				new vscode.ThemeColor("symbolIcon.fieldForeground"),
			);
			item.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to field",
				arguments: [element.uri, element.range],
			};
			return item;
		}
		if (element.kind === "messageEnum") {
			const item = new vscode.TreeItem(
				element.label,
				vscode.TreeItemCollapsibleState.None,
			);
			item.description = "enum";
			item.tooltip = new vscode.MarkdownString(
				`Enum **${element.label}**\n\nClick to go to definition in file.`,
			);
			item.iconPath = new vscode.ThemeIcon(
				"symbol-enum",
				new vscode.ThemeColor("symbolIcon.enumForeground"),
			);
			item.command = {
				command: "googleApiLinter.revealLocation",
				title: "Go to enum",
				arguments: [element.uri, element.range],
			};
			return item;
		}
		const item = new vscode.TreeItem(
			element.label,
			vscode.TreeItemCollapsibleState.None,
		);
		item.iconPath = new vscode.ThemeIcon(element.icon);
		item.command = { command: element.command, title: element.label };
		return item;
	}

	/* -------------------------------------------------------------- *
	 * Section contents — built on expansion, never on activation
	 * -------------------------------------------------------------- */

	private async sectionChildren(id: ProtoSectionId): Promise<ProtoTreeNode[]> {
		const cached = this.sectionCache.get(id);
		if (cached) {
			return cached;
		}
		const children = await this.buildSection(id);
		this.sectionCache.set(id, children);
		// Only count real entries, so a ceiling/cap notice never inflates the badge.
		this.sectionCounts.set(
			id,
			children.filter((child) => child.kind !== "info").length,
		);
		return children;
	}

	private async buildSection(id: ProtoSectionId): Promise<ProtoTreeNode[]> {
		if (id === "deps") {
			const [googleapisCommit, protobufCommit] = await Promise.all([
				this.getGoogleapisCommit(),
				this.getProtobufCommit(),
			]);
			return [
				{ kind: "dep", name: "googleapis", commit: googleapisCommit },
				{ kind: "dep", name: "protobuf", commit: protobufCommit },
			];
		}
		if (id === "files") {
			return await this.buildFilesSection();
		}

		const index = this.usableIndex();
		if (SYMBOL_SECTIONS.has(id)) {
			if (!index) {
				return [this.noIndexNode()];
			}
			if (this.overCeiling()) {
				return [this.ceilingNode()];
			}
		}
		if (!index) {
			return [];
		}

		if (id === "services") {
			const collected = collectSymbolsOfKind(index, "service");
			const nodes: ProtoTreeNode[] = [];
			for (const symbol of collected.symbols) {
				const service = buildServiceItem(index, symbol);
				if (service) {
					nodes.push({ kind: "service", service });
				}
			}
			if (collected.truncated) {
				nodes.push(cappedNode(nodes.length, MAX_SECTION_SYMBOLS, "services"));
			}
			return nodes;
		}

		if (id === "rpcs") {
			const collected = collectSymbolsOfKind(index, "rpc");
			const nodes: ProtoTreeNode[] = [];
			for (const symbol of collected.symbols) {
				const item = toRpcLocationItem(index, symbol);
				if (item) {
					nodes.push({ kind: "location", item });
				}
			}
			if (collected.truncated) {
				nodes.push(cappedNode(nodes.length, MAX_SECTION_SYMBOLS, "RPCs"));
			}
			return nodes;
		}

		if (id === "messages") {
			const collected = collectSymbolsOfKind(index, "message");
			const nodes: ProtoTreeNode[] = [];
			for (const symbol of collected.symbols) {
				const item = toLocationItem(
					index,
					symbol,
					"message",
					"symbol-class",
					true,
				);
				if (item) {
					nodes.push({ kind: "location", item });
				}
			}
			if (collected.truncated) {
				nodes.push(cappedNode(nodes.length, MAX_SECTION_SYMBOLS, "messages"));
			}
			return nodes;
		}

		if (id === "enums") {
			const collected = collectSymbolsOfKind(index, "enum");
			const nodes: ProtoTreeNode[] = [];
			for (const symbol of collected.symbols) {
				const item = toLocationItem(index, symbol, "enum", "symbol-enum");
				if (item) {
					nodes.push({ kind: "location", item });
				}
			}
			if (collected.truncated) {
				nodes.push(cappedNode(nodes.length, MAX_SECTION_SYMBOLS, "enums"));
			}
			return nodes;
		}

		if (id === "resources") {
			const collected = await collectResources(index);
			const nodes: ProtoTreeNode[] = collected.items.map((item) => ({
				kind: "location" as const,
				item,
			}));
			if (collected.truncated) {
				nodes.push(
					infoNode(
						"Resource scan stopped at its file limit",
						"list incomplete",
						"list-flat",
						"Too many files import `google/api/resource.proto` to confirm every `option (google.api.resource)` cheaply. The list above is a prefix.",
					),
				);
			}
			return nodes;
		}

		if (id === "annotations") {
			const namespaces = collectAnnotationNamespaces(index);
			if (namespaces.length === 0) {
				return [
					infoNode(
						"No custom annotations found",
						"no extend blocks indexed",
						"info",
						"Annotations are discovered from `extend google.protobuf.*Options` blocks; none were indexed in this workspace.",
					),
				];
			}
			return namespaces.map((namespace) => ({
				kind: "annotationNamespace" as const,
				namespace: namespace.namespace,
				count: namespace.count,
			}));
		}

		return [];
	}

	/**
	 * Proto files with their diagnostic counts, bounded by the file ceiling.
	 * Prefers the index's file list so no workspace glob runs.
	 */
	private async buildFilesSection(): Promise<ProtoTreeNode[]> {
		const index = this.usableIndex();
		const paths = index
			? index
					.files()
					.map((file) => file.path)
					.sort((a, b) => a.localeCompare(b))
			: (await findProtoFiles())
					.map((uri) => uri.fsPath)
					.sort((a, b) => a.localeCompare(b));

		const total = paths.length;
		const shown = Math.min(total, this.fileCeiling);
		const nodes: ProtoTreeNode[] = [];
		for (let i = 0; i < shown; i++) {
			nodes.push(this.fileNode(vscode.Uri.file(paths[i])));
		}
		if (total > shown) {
			nodes.push(truncatedNode(shown, total, "files"));
		}
		return nodes;
	}

	/** One file node with its counts of diagnostics from this extension. */
	private fileNode(uri: vscode.Uri, folderName?: string): ProtoTreeNode {
		const diagnostics = this.diagnosticCollection.get(uri) ?? [];
		let errorCount = 0;
		let warningCount = 0;
		for (const diagnostic of diagnostics) {
			if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
				continue;
			}
			if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
				errorCount++;
			} else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
				warningCount++;
			}
		}
		return { kind: "file", uri, errorCount, warningCount, folderName };
	}

	async getChildren(element?: ProtoTreeNode): Promise<ProtoTreeNode[]> {
		if (element?.kind === "section") {
			return await this.sectionChildren(element.id);
		}

		if (element?.kind === "annotationNamespace") {
			const index = this.usableIndex();
			if (!index) {
				return [this.noIndexNode()];
			}
			const nodes: ProtoTreeNode[] = [];
			for (const descriptor of collectAnnotationsIn(index, element.namespace)) {
				const item = annotationLocationItem(index, descriptor);
				if (item) {
					nodes.push({ kind: "location", item });
				}
			}
			return nodes;
		}

		if (element?.kind === "service") {
			return element.service.rpcs.map((rpc) => ({
				kind: "rpc" as const,
				rpc,
				serviceName: element.service.name,
			}));
		}

		if (element?.kind === "rpc") {
			const reqType = element.rpc.requestType;
			const resType = element.rpc.responseType;
			const contextUri = element.rpc.uri;
			let reqLoc: vscode.Location | null = null;
			let resLoc: vscode.Location | null = null;
			if (this.resolveTypeToLocation) {
				[reqLoc, resLoc] = await Promise.all([
					this.resolveTypeToLocation(reqType, contextUri),
					this.resolveTypeToLocation(resType, contextUri),
				]);
			}
			const rpcUri = element.rpc.uri;
			const rpcRange = element.rpc.range;
			return [
				{
					kind: "rpcDetail" as const,
					type: "request" as const,
					typeName: reqType,
					uri: reqLoc?.uri,
					range: reqLoc?.range,
					rpcUri,
					rpcRange,
				},
				{
					kind: "rpcDetail" as const,
					type: "response" as const,
					typeName: resType,
					uri: resLoc?.uri,
					range: resLoc?.range,
					rpcUri,
					rpcRange,
				},
			];
		}

		if (element?.kind === "location" && element.item.expandable === true) {
			const index = this.usableIndex();
			if (!index) {
				return [];
			}
			// Straight from the index — the old path opened the document here.
			const { fields, enums } = collectMessageMembers(index, element.item);
			const nodes: ProtoTreeNode[] = [];
			for (const field of fields) {
				nodes.push({
					kind: "messageField",
					label: field.name,
					type: field.detail ?? "",
					uri: element.item.uri,
					range: new vscode.Range(
						field.line,
						field.startCol,
						field.line,
						field.endCol,
					),
				});
			}
			for (const nested of enums) {
				nodes.push({
					kind: "messageEnum",
					label: nested.name,
					uri: element.item.uri,
					range: new vscode.Range(
						nested.line,
						nested.startCol,
						nested.line,
						nested.endCol,
					),
				});
			}
			return nodes;
		}

		if (element?.kind === "file") {
			const diags = this.diagnosticCollection.get(element.uri) ?? [];
			const fromUs = diags.filter((d) => d.source === DIAGNOSTIC_SOURCE);
			return fromUs.map((d) => ({
				kind: "diagnostic" as const,
				uri: element.uri,
				range: d.range,
				message: d.message,
				severity: d.severity,
				code: d.code as string | number | undefined,
			}));
		}

		if (element?.kind === "folder") {
			const folderUri = element.uri;
			const hasConfig = (await findGapiConfigFileInFolder(folderUri)) !== null;
			const children: ProtoTreeNode[] = [];
			if (!hasConfig) {
				children.push({
					kind: "init",
					label: "Proto workspace not initialized",
					detail: "Create workspace.protobuf.yaml",
					icon: "folder-opened",
					folderUri,
				});
			}
			const protoUris = (await findProtoFilesInFolder(folderUri)).sort((a, b) =>
				a.fsPath.localeCompare(b.fsPath),
			);
			const shown = Math.min(protoUris.length, this.fileCeiling);
			for (let i = 0; i < shown; i++) {
				children.push(this.fileNode(protoUris[i], element.name));
			}
			if (protoUris.length > shown) {
				children.push(truncatedNode(shown, protoUris.length, "files"));
			}
			return children;
		}

		if (element !== undefined) {
			return [];
		}

		return await this.rootNodes();
	}

	/**
	 * The root. Costs one config lookup, one `index.stats()` and the linter
	 * version — no symbol enumeration, no workspace glob when an index exists.
	 */
	private async rootNodes(): Promise<ProtoTreeNode[]> {
		const hasWorkspaceConfig = (await findGapiConfigFile()) !== null;
		const roots: ProtoTreeNode[] = [];

		if (!hasWorkspaceConfig) {
			roots.push({
				kind: "init",
				label: "Proto workspace not initialized",
				detail: "Create workspace.protobuf.yaml",
				icon: "folder-opened",
			});
			return roots;
		}

		// Top-level button bar (debugger style): Lint, Format, Reload
		roots.push(
			{
				kind: "action",
				command: "googleApiLinter.lintWorkspace",
				label: "Lint",
				icon: "play",
			},
			{
				kind: "action",
				command: "googleApiLinter.formatAllProtos",
				label: "Format",
				icon: "prettier",
			},
			{
				kind: "action",
				command: "googleApiLinter.restart",
				label: "Reload",
				icon: "debug-restart",
			},
		);

		const index = this.usableIndex();
		if (!index) {
			roots.push(this.noIndexNode());
		} else if (this.overCeiling()) {
			roots.push(this.ceilingNode());
		} else {
			const stats = index.stats();
			roots.push(
				{
					kind: "section",
					id: "services",
					label: "Services",
					count: this.sectionCounts.get("services"),
					icon: "symbol-interface",
				},
				{
					kind: "section",
					id: "rpcs",
					label: "RPCs",
					count: this.sectionCounts.get("rpcs"),
					icon: "symbol-method",
				},
				{
					kind: "section",
					id: "resources",
					label: "Resources",
					count: this.sectionCounts.get("resources"),
					icon: "symbol-class",
				},
				{
					kind: "section",
					id: "messages",
					label: "Messages",
					count: this.sectionCounts.get("messages"),
					icon: "symbol-class",
				},
				{
					kind: "section",
					id: "enums",
					label: "Enums",
					count: this.sectionCounts.get("enums"),
					icon: "symbol-enum",
				},
			);
			if (stats.annotationCount > 0) {
				roots.push({
					kind: "section",
					id: "annotations",
					label: "Annotations",
					count: stats.annotationCount,
					icon: "symbol-keyword",
				});
			}
		}

		roots.push({
			kind: "section",
			id: "deps",
			label: "Deps",
			count: 2,
			icon: "package",
		});
		roots.push({
			kind: "section",
			id: "files",
			label: "Files",
			count: index?.stats().fileCount ?? this.sectionCounts.get("files"),
			icon: "symbol-file",
		});

		try {
			const version = await this.getBinaryVersion();
			const versionStr = version.startsWith("v") ? version : `v${version}`;
			roots.push({
				kind: "status",
				label: "API Linter",
				version: versionStr,
				detail: undefined,
				icon: "symbol-misc",
			});
		} catch {
			roots.push({
				kind: "status",
				label: "API Linter",
				detail: "Not installed or error",
				icon: "warning",
			});
		}

		return roots;
	}
}

/**
 * Creates the Proto view and its commands.
 *
 * `index` is optional: without it (or on the `onDemand` tier) the view degrades
 * to a placeholder tree rather than scanning the workspace itself.
 */
export function registerProtoView(
	context: vscode.ExtensionContext,
	diagnosticCollection: vscode.DiagnosticCollection,
	getBinaryVersion: () => Promise<string>,
	getGoogleapisCommit: () => Promise<string>,
	getProtobufCommit: () => Promise<string>,
	resolveTypeToLocation?: (
		typeName: string,
		contextUri: vscode.Uri,
	) => Promise<vscode.Location | null>,
	index?: ProtoIndex,
	fileCeiling: number = DEFAULT_PROTO_VIEW_FILE_CEILING,
): void {
	const treeDataProvider = new ProtoTreeDataProvider(
		diagnosticCollection,
		getBinaryVersion,
		getGoogleapisCommit,
		getProtobufCommit,
		resolveTypeToLocation,
		index,
		fileCeiling,
	);
	// createTreeView registers the built-in collapseAll command (workbench.actions.treeView.<id>.collapseAll)
	context.subscriptions.push(
		vscode.window.createTreeView("googleApiLinter.views.proto", {
			treeDataProvider,
			showCollapseAll: false, // we contribute our own icon button
		}),
	);
	// Pushed after the view so the view is torn down before the provider's
	// emitter and index subscription go away.
	context.subscriptions.push(treeDataProvider);

	context.subscriptions.push(
		vscode.commands.registerCommand("googleApiLinter.refreshProtoView", () => {
			treeDataProvider.refreshStructure();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("googleApiLinter.collapseAll", async () => {
			try {
				await vscode.commands.executeCommand(
					"workbench.actions.treeView.googleApiLinter.views.proto.collapseAll",
				);
			} catch {
				// Built-in command only exists when view is created with createTreeView; fallback refresh
				treeDataProvider.refreshPresentation();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"googleApiLinter.revealLocation",
			async (uri: vscode.Uri, range: vscode.Range) => {
				// One document, for the one node the user clicked. Never in a loop.
				const doc = await vscode.workspace.openTextDocument(uri);
				const editor = await vscode.window.showTextDocument(doc, {
					selection: range,
					preview: false,
				});
				editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
			},
		),
	);

	let diagRefreshTimer: NodeJS.Timeout | undefined;
	const scheduleDiagRefresh = () => {
		if (diagRefreshTimer) {
			clearTimeout(diagRefreshTimer);
		}
		diagRefreshTimer = setTimeout(() => {
			diagRefreshTimer = undefined;
			treeDataProvider.refreshPresentation();
		}, DIAGNOSTIC_REFRESH_DEBOUNCE_MS);
	};
	context.subscriptions.push(
		vscode.languages.onDidChangeDiagnostics(() => scheduleDiagRefresh()),
	);

	const gapiWatcher = vscode.workspace.createFileSystemWatcher(
		"**/workspace.protobuf.yaml",
	);
	gapiWatcher.onDidCreate(() => treeDataProvider.refreshStructureSoon());
	gapiWatcher.onDidChange(() => treeDataProvider.refreshStructureSoon());
	gapiWatcher.onDidDelete(() => treeDataProvider.refreshStructureSoon());
	context.subscriptions.push(gapiWatcher);

	const bufWatcher = vscode.workspace.createFileSystemWatcher(
		"**/{buf.yaml,buf.lock}",
	);
	const onBufChange = () => {
		invalidateProtoImportRootsCache();
		treeDataProvider.refreshStructureSoon();
	};
	bufWatcher.onDidCreate(onBufChange);
	bufWatcher.onDidChange(onBufChange);
	bufWatcher.onDidDelete(onBufChange);
	context.subscriptions.push(bufWatcher);

	context.subscriptions.push(
		new vscode.Disposable(() => {
			if (diagRefreshTimer !== undefined) {
				clearTimeout(diagRefreshTimer);
			}
		}),
	);
}
