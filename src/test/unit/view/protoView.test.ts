/**
 * Tests for `ProtoTreeDataProvider` — the Proto view itself.
 *
 * The view is the one place the rewrite is directly visible to a user, and two
 * of its rules are easy to break by accident.
 *
 * **Nothing is computed until it is expanded.** Building the root must cost a
 * config lookup and `index.stats()`, nothing more. The fake index below counts
 * every `files()` and `symbolsInFile()` call, so a root that starts walking the
 * index again fails here rather than being noticed as a slow sidebar.
 *
 * **Above the ceiling the sections group rather than refuse.** The old view
 * replaced every symbol section with an "exceeds the view limit" notice, which
 * on a 9,280-file workspace meant the sidebar showed no symbols at all. The
 * ceiling now only decides when to group, so the tests assert the sections are
 * still there, that the levels stay narrow, and that expanding the groups
 * reaches every symbol the flat list would have shown.
 *
 * Around those, the mechanical contract a tree provider has with VS Code:
 * labels, icons, collapsible state, `command` wiring, `contextValue`, and which
 * edits fire `onDidChangeTreeData`. `contextValue` and the command ids are load
 * bearing — they are what package.json's menus and the click targets key off,
 * so a silent change there breaks the UI without breaking anything else.
 *
 * `protoScanner.test.ts` covers the collectors underneath; nothing here
 * re-asserts grouping arithmetic that already lives there. The fake index is
 * deliberately a local copy rather than an import: test files cannot import one
 * another without re-registering each other's tests.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	Command,
	DiagnosticCollection,
	ExtensionContext,
	Location,
	TreeItem,
} from "vscode";
import type {
	AnnotationDescriptor,
	AnnotationRegistry,
	AnnotationTarget,
	IndexedFile,
	IndexedReference,
	IndexedSymbol,
	IndexStats,
	IndexTier,
	ProtoIndex,
	SymbolKind,
} from "../../../index/types";
import {
	MAX_SECTION_SYMBOLS,
	SECTION_GROUPING_THRESHOLD,
} from "../../../protoScanner";
import {
	type ProtoSectionId,
	ProtoTreeDataProvider,
	type ProtoTreeNode,
	registerProtoView,
} from "../../../protoView";
import {
	hasReferenceCorpus,
	listProtos,
	REFERENCE_PROTO_ROOT,
} from "../support/fixtures";
import {
	commands,
	Diagnostic,
	FileSystemWatcher,
	languages,
	Range,
	DiagnosticCollection as StubDiagnosticCollection,
	ThemeIcon,
	TreeItemCollapsibleState,
	Uri,
	window,
	workspace,
} from "../support/vscode";

const DIAGNOSTIC_SOURCE = "protobuf-aip-linter";

/* ------------------------------------------------------------------ *
 * A fake index
 * ------------------------------------------------------------------ */

/** One declaration in a fake file. `parent` names the enclosing declaration. */
interface SymbolSpec {
	name: string;
	kind: SymbolKind;
	parent?: string;
	detail?: string;
	doc?: string;
	line?: number;
	startCol?: number;
}

/** One file in a fake index. */
interface FileSpec {
	path: string;
	packageName: string;
	imports?: readonly string[];
	symbols?: readonly SymbolSpec[];
}

interface FakeOptions {
	tier?: IndexTier;
	annotations?: readonly AnnotationDescriptor[];
	degradeReason?: string;
}

/** Joins a package and a name the way the real index qualifies a symbol. */
function qualify(packageName: string, name: string): string {
	return packageName ? `${packageName}.${name}` : name;
}

/** An `AnnotationRegistry` over a fixed descriptor list. */
function fakeRegistry(
	descriptors: readonly AnnotationDescriptor[],
): AnnotationRegistry {
	return {
		all: () => descriptors,
		get: (fqn) => descriptors.find((descriptor) => descriptor.fqn === fqn),
		byTarget: (target) =>
			descriptors.filter((descriptor) => descriptor.target === target),
		body: () => undefined,
		collisions: () => [],
	};
}

/**
 * An in-memory `ProtoIndex` holding exactly what the view reads. `reads` counts
 * index traffic, so a test can prove the root never walked the index.
 */
class FakeIndex implements ProtoIndex {
	readonly reads = { files: 0, symbolsInFile: 0 };
	private fileList: IndexedFile[] = [];
	private byId = new Map<number, IndexedFile>();
	private symbolsById = new Map<number, IndexedSymbol[]>();
	private readonly listeners = new Set<() => void>();
	private registry: AnnotationRegistry;
	private readonly tier: IndexTier;
	private readonly degradeReason?: string;

	constructor(specs: readonly FileSpec[], options: FakeOptions = {}) {
		this.tier = options.tier ?? "full";
		this.degradeReason = options.degradeReason;
		this.registry = fakeRegistry(options.annotations ?? []);
		this.load(specs);
	}

	/** Replaces every file, as a rebuild does, then notifies subscribers. */
	rebuild(
		specs: readonly FileSpec[],
		annotations?: readonly AnnotationDescriptor[],
	): void {
		this.load(specs);
		if (annotations) {
			this.registry = fakeRegistry(annotations);
		}
		this.emitChange();
	}

	/** Pretends a rebuild happened, so subscribers see the change. */
	emitChange(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	/** How many listeners are still attached; proves `dispose` unsubscribed. */
	get listenerCount(): number {
		return this.listeners.size;
	}

	private load(specs: readonly FileSpec[]): void {
		this.fileList = [];
		this.byId = new Map();
		this.symbolsById = new Map();
		specs.forEach((spec, id) => {
			const file: IndexedFile = {
				id,
				path: spec.path,
				packageName: spec.packageName,
				imports: spec.imports ?? [],
				mtimeMs: 0,
			};
			this.fileList.push(file);
			this.byId.set(id, file);
			this.symbolsById.set(
				id,
				(spec.symbols ?? []).map((symbol, position) => {
					const parentFqn = symbol.parent
						? qualify(spec.packageName, symbol.parent)
						: undefined;
					const owner = parentFqn ?? spec.packageName;
					return {
						fqn: qualify(owner, symbol.name),
						name: symbol.name,
						kind: symbol.kind,
						fileId: id,
						line: symbol.line ?? position,
						startCol: symbol.startCol ?? 0,
						endCol: (symbol.startCol ?? 0) + symbol.name.length,
						parentFqn,
						detail: symbol.detail,
						doc: symbol.doc,
					};
				}),
			);
		});
	}

	build(): Promise<IndexStats> {
		return Promise.resolve(this.stats());
	}
	update(): Promise<void> {
		return Promise.resolve();
	}
	remove(): void {}

	stats(): IndexStats {
		let symbolCount = 0;
		for (const symbols of this.symbolsById.values()) {
			symbolCount += symbols.length;
		}
		return {
			tier: this.tier,
			fileCount: this.fileList.length,
			symbolCount,
			annotationCount: this.registry.all().length,
			bytesRead: 0,
			buildMs: 0,
			approxHeapMB: 0,
			degradeReason: this.degradeReason,
		};
	}

	files(): readonly IndexedFile[] {
		this.reads.files++;
		return this.fileList;
	}
	file(id: number): IndexedFile | undefined {
		return this.byId.get(id);
	}
	fileByPath(absolutePath: string): IndexedFile | undefined {
		return this.fileList.find((file) => file.path === absolutePath);
	}

	symbol(fqn: string): IndexedSymbol | undefined {
		for (const symbols of this.symbolsById.values()) {
			const found = symbols.find((entry) => entry.fqn === fqn);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
	searchSymbols(): readonly IndexedSymbol[] {
		return [];
	}
	symbolsInFile(fileId: number): readonly IndexedSymbol[] {
		this.reads.symbolsInFile++;
		return this.symbolsById.get(fileId) ?? [];
	}

	/**
	 * Deliberately does not record a read: the real index answers this from a
	 * tally kept during ingest, so a caller asking for it has not walked
	 * anything. Counting it here would break the assertions that the view's
	 * root costs no traversal.
	 */
	countOfKind(kind: SymbolKind): number {
		let total = 0;
		for (const symbols of this.symbolsById.values()) {
			for (const symbol of symbols) {
				if (symbol.kind === kind) {
					total++;
				}
			}
		}
		return total;
	}
	referencesTo(): readonly IndexedReference[] {
		return [];
	}

	annotations(): AnnotationRegistry {
		return this.registry;
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.listeners.delete(listener);
			},
		};
	}
	dispose(): void {
		this.listeners.clear();
	}
}

/** An annotation descriptor with the fqn split into namespace and name. */
function annotation(
	fqn: string,
	target: AnnotationTarget,
	extra: Partial<AnnotationDescriptor> = {},
): AnnotationDescriptor {
	const dot = fqn.lastIndexOf(".");
	return {
		fqn,
		name: dot >= 0 ? fqn.slice(dot + 1) : fqn,
		namespace: dot >= 0 ? fqn.slice(0, dot) : "",
		target,
		type: "string",
		number: 1,
		repeated: false,
		importPath: "x/v1/annotations.proto",
		fileId: 0,
		line: 7,
		...extra,
	};
}

/* ------------------------------------------------------------------ *
 * Provider harness
 * ------------------------------------------------------------------ */

interface ProviderOptions {
	index?: ProtoIndex;
	fileCeiling?: number;
	/** Uris the workspace glob should hand back for `**\/*.proto`. */
	protos?: readonly string[];
	/** False to leave the workspace uninitialised (no workspace.protobuf.yaml). */
	initialised?: boolean;
	binaryVersion?: () => Promise<string>;
	googleapisCommit?: string;
	protobufCommit?: string;
	/** Type resolution for rpc detail nodes; null stands for "not resolved". */
	resolveType?: (typeName: string) => { uri: Uri; range: Range } | null;
	/** Records every type name the view asked the resolver about. */
	resolved?: string[];
}

interface Harness {
	provider: ProtoTreeDataProvider;
	collection: StubDiagnosticCollection;
	/** Every value `onDidChangeTreeData` has fired so far. */
	fired: (ProtoTreeNode | undefined)[];
}

const originalFindFiles = workspace.findFiles;
const originalAsRelativePath = workspace.asRelativePath;
const created: ProtoTreeDataProvider[] = [];

/**
 * A provider wired to a fake index, with the workspace glob answered from the
 * options rather than from disk.
 *
 * @param options - What the workspace and the index should contain
 * @returns The provider, its diagnostic collection and the fired events
 */
function harness(options: ProviderOptions = {}): Harness {
	const configUris =
		options.initialised === false
			? []
			: [Uri.file("/ws/workspace.protobuf.yaml")];
	const protoUris = (options.protos ?? []).map((file) => Uri.file(file));
	workspace.findFiles = async (include: string): Promise<Uri[]> =>
		include.includes("workspace.protobuf.yaml") ? configUris : protoUris;

	const collection = new StubDiagnosticCollection("test");
	const resolve = options.resolveType;
	const provider = new ProtoTreeDataProvider(
		collection as unknown as DiagnosticCollection,
		resolve
			? (typeName: string) => {
					options.resolved?.push(typeName);
					return Promise.resolve(
						resolve(typeName) as unknown as Location | null,
					);
				}
			: undefined,
		options.index,
		options.fileCeiling,
	);
	created.push(provider);

	const fired: (ProtoTreeNode | undefined)[] = [];
	provider.onDidChangeTreeData((node) => fired.push(node));
	return { provider, collection, fired };
}

afterEach(() => {
	workspace.findFiles = originalFindFiles;
	workspace.asRelativePath = originalAsRelativePath;
	for (const provider of created.splice(0)) {
		provider.dispose();
	}
});

/* ------------------------------------------------------------------ *
 * Node helpers
 * ------------------------------------------------------------------ */

/** The kinds of every node in order, for asserting tree shape compactly. */
function kinds(nodes: readonly ProtoTreeNode[]): string[] {
	return nodes.map((node) => node.kind);
}

/** Ids of the section nodes present, in order. */
function sectionIds(nodes: readonly ProtoTreeNode[]): ProtoSectionId[] {
	return nodes
		.filter(
			(node): node is Extract<ProtoTreeNode, { kind: "section" }> =>
				node.kind === "section",
		)
		.map((node) => node.id);
}

/** The section node with the given id, which the test then expands. */
function section(
	nodes: readonly ProtoTreeNode[],
	id: ProtoSectionId,
): ProtoTreeNode {
	const found = nodes.find((node) => node.kind === "section" && node.id === id);
	if (!found) {
		throw new Error(`no ${id} section at the root`);
	}
	return found;
}

/** Labels of location-bearing nodes, for order assertions. */
function labels(nodes: readonly ProtoTreeNode[]): string[] {
	return nodes.map((node) => {
		switch (node.kind) {
			case "location":
				return node.item.label;
			case "service":
				return node.service.name;
			case "rpc":
				return node.rpc.name;
			case "symbolGroup":
				return node.label;
			case "annotationNamespace":
				return node.namespace;
			case "messageField":
			case "messageEnum":
			case "info":
			case "status":
			case "init":
			case "action":
				return node.label;
			case "file":
				return node.uri.fsPath;
			case "diagnostic":
				return node.message;
			default:
				return node.kind;
		}
	});
}

/** The codicon id of a tree item's icon, or undefined when it has none. */
function iconId(item: TreeItem): string | undefined {
	const icon = item.iconPath;
	return icon instanceof ThemeIcon ? icon.id : undefined;
}

/** The theme colour id of a tree item's icon, when it carries one. */
function iconColor(item: TreeItem): string | undefined {
	const icon = item.iconPath;
	return icon instanceof ThemeIcon ? icon.color?.id : undefined;
}

/** Tooltip text, whether the item used a plain string or a MarkdownString. */
function tooltip(item: TreeItem): string {
	const value = item.tooltip;
	if (value === undefined) {
		return "";
	}
	return typeof value === "string" ? value : value.value;
}

/** The command an item invokes on click, or undefined when it is not clickable. */
function command(item: TreeItem): Command | undefined {
	return item.command;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A two-file workspace: one service with two RPCs, two messages, one enum. */
function smallWorkspace(): FileSpec[] {
	return [
		{
			path: "/ws/api/v1/library.proto",
			packageName: "acme.library.v1",
			symbols: [
				{ name: "LibraryService", kind: "service", line: 10 },
				{
					name: "GetBook",
					kind: "rpc",
					parent: "LibraryService",
					detail: "(GetBookRequest) returns (Book)",
					doc: "Returns one book.",
					line: 11,
					startCol: 4,
				},
				{
					name: "ListBooks",
					kind: "rpc",
					parent: "LibraryService",
					detail: "(ListBooksRequest) returns (ListBooksResponse)",
					line: 15,
					startCol: 4,
				},
				{ name: "Book", kind: "message", line: 20 },
				{
					name: "title",
					kind: "field",
					parent: "Book",
					detail: "string",
					line: 21,
					startCol: 9,
				},
				{
					name: "Format",
					kind: "enum",
					parent: "Book",
					line: 23,
					startCol: 7,
				},
				{ name: "Shelf", kind: "message", line: 30 },
			],
		},
		{
			path: "/ws/api/v1/common.proto",
			packageName: "acme.common.v1",
			symbols: [
				{ name: "Status", kind: "enum", line: 4 },
				{ name: "Empty", kind: "message", line: 8 },
			],
		},
	];
}

describe("root", () => {
	test("offers only the init action when the workspace has no config", async () => {
		const { provider } = harness({ initialised: false });
		const roots = await provider.getChildren();
		expect(kinds(roots)).toEqual(["init"]);

		const item = provider.getTreeItem(roots[0]);
		expect(item.label).toBe("Proto workspace not initialized");
		expect(item.description).toBe("Create workspace.protobuf.yaml");
		expect(command(item)?.command).toBe("googleApiLinter.initWorkspace");
		// No folder uri at the root, so the command takes no arguments.
		expect(command(item)?.arguments).toBeUndefined();
		expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
	});

	test("lists the action bar, every section and the linter status", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();

		// Lint, Format and Restart used to be three fake rows at the top of this
		// tree. They are a `view/title` toolbar now, which is where the debugger
		// has always put them, and dependencies moved to their own view.
		// Files duplicated the Explorer and the linter version is a property of
		// the install, not of the workspace's structure; it lives in the status
		// bar now. What is left is only what this tree is for.
		expect(kinds(roots)).toEqual([
			"section",
			"section",
			"section",
			"section",
			"section",
		]);
		expect(sectionIds(roots)).toEqual([
			"services",
			"rpcs",
			"resources",
			"messages",
			"enums",
		]);
	});

	test("costs one stats call and never walks the index", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		await provider.getChildren();
		// The whole point of the rewrite: the root is derived from stats alone.
		expect(index.reads.files).toBe(0);
		expect(index.reads.symbolsInFile).toBe(0);
	});

	test("adds an Annotations section only when the index found some", async () => {
		const without = new FakeIndex(smallWorkspace());
		expect(
			sectionIds(await harness({ index: without }).provider.getChildren()),
		).not.toContain("annotations");

		const with_ = new FakeIndex(smallWorkspace(), {
			annotations: [annotation("mcp.v1.tool", "Method")],
		});
		const roots = await harness({ index: with_ }).provider.getChildren();
		expect(sectionIds(roots)).toContain("annotations");
		const node = section(roots, "annotations");
		expect(node.kind === "section" && node.count).toBe(1);
	});

	test("replaces the symbol sections with a notice when there is no index", async () => {
		const { provider } = harness();
		const roots = await provider.getChildren();
		expect(sectionIds(roots)).toEqual([]);

		const info = roots.find((node) => node.kind === "info");
		expect(info?.kind === "info" && info.label).toBe(
			"Workspace index unavailable",
		);
		const item = provider.getTreeItem(info as ProtoTreeNode);
		expect(item.description).toBe("symbol sections disabled");
		expect(iconId(item)).toBe("circle-slash");
	});

	test("names the degrade reason when the index runs on demand", async () => {
		const index = new FakeIndex(smallWorkspace(), {
			tier: "onDemand",
			degradeReason: "workspace exceeds 200 MB",
		});
		const { provider } = harness({ index });
		const roots = await provider.getChildren();

		// An onDemand index is treated as no index at all by every symbol section.
		expect(sectionIds(roots)).toEqual([]);
		const info = roots.find((node) => node.kind === "info");
		expect(info?.kind === "info" && info.label).toBe(
			"Workspace index is running on demand",
		);
		expect(provider.getTreeItem(info as ProtoTreeNode).description).toBe(
			"workspace exceeds 200 MB",
		);
		expect(tooltip(provider.getTreeItem(info as ProtoTreeNode))).toContain(
			"workspace exceeds 200 MB",
		);
	});

	test("keeps every section above the file ceiling and explains the grouping", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();

		// The regression this guards: the ceiling used to delete these sections.
		expect(sectionIds(roots)).toEqual([
			"services",
			"rpcs",
			"resources",
			"messages",
			"enums",
		]);
		const info = roots.find((node) => node.kind === "info");
		expect(info?.kind === "info" && info.label).toBe(
			"2 proto files · symbols grouped by version",
		);
		const item = provider.getTreeItem(info as ProtoTreeNode);
		expect(item.description).toBe("large workspace");
		expect(iconId(item)).toBe("versions");
		expect(tooltip(item)).toContain("Above 1 files");
	});

	test("no longer reports the linter version", async () => {
		// The version is a property of the install, not of the workspace's
		// structure. The status bar carries it now.
		const { provider } = harness();
		const roots = await provider.getChildren();
		expect(roots.some((node) => node.kind === "status")).toBe(false);
	});
});

describe("getTreeItem", () => {
	test("puts no command rows in the tree", async () => {
		// Lint, Format and Restart are contributed as a `view/title` toolbar in
		// package.json. A tree that also renders them as rows shows every action
		// twice and pushes the actual content down.
		const { provider } = harness();
		const roots = await provider.getChildren();
		expect(roots.some((node) => node.kind === "action")).toBe(false);
	});

	test("renders a section collapsed, coloured and described", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();

		const services = provider.getTreeItem(section(roots, "services"));
		expect(services.label).toBe("Services");
		expect(services.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
		expect(iconId(services)).toBe("symbol-interface");
		expect(iconColor(services)).toBe("symbolIcon.interfaceForeground");
		expect(tooltip(services)).toBe(
			"Services with RPCs (expand to see Request/Response)",
		);
		// The count is known before expanding: the index tallies symbols per
		// kind as it ingests, so the root does not have to walk anything to
		// label its sections.
		expect(services.description).toBe("1");

		const enums = provider.getTreeItem(section(roots, "enums"));
		expect(iconColor(enums)).toBe("symbolIcon.enumForeground");
		expect(tooltip(enums)).toBe("Enum definitions");
	});

	test("badges a section before it has ever been expanded", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const before = await provider.getChildren();
		expect(provider.getTreeItem(section(before, "messages")).description).toBe(
			"3",
		);

		await provider.getChildren(section(before, "messages"));

		const after = await provider.getChildren();
		const messages = section(after, "messages");
		expect(messages.kind === "section" && messages.count).toBe(3);
		expect(provider.getTreeItem(messages).description).toBe("3");
	});
});

describe("deps section", () => {
	test("is gone — dependencies have their own view now", async () => {
		// This section reported a hardcoded `count: 2` and listed the two
		// vendored download commits, while the workspace's real buf
		// dependencies were parsed by the module graph and discarded.
		const { provider } = harness({
			googleapisCommit: "1234567890abcdef",
			protobufCommit: "fedcba0987654321",
		});
		const roots = await provider.getChildren();
		expect(sectionIds(roots)).not.toContain("deps");
	});
});

describe("services section", () => {
	test("lists services, then their RPCs, then request and response", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();

		const services = await provider.getChildren(section(roots, "services"));
		expect(labels(services)).toEqual(["LibraryService"]);
		const serviceItem = provider.getTreeItem(services[0]);
		expect(serviceItem.description).toBe("2 RPC(s)");
		expect(serviceItem.collapsibleState).toBe(
			TreeItemCollapsibleState.Collapsed,
		);
		expect(iconId(serviceItem)).toBe("symbol-interface");
		expect(command(serviceItem)?.command).toBe(
			"googleApiLinter.revealLocation",
		);
		const target = command(serviceItem)?.arguments as [Uri, Range];
		expect(target[0].fsPath).toBe("/ws/api/v1/library.proto");
		expect(target[1].start.line).toBe(10);

		// RPCs come back name-sorted, not in declaration order.
		const rpcs = await provider.getChildren(services[0]);
		expect(labels(rpcs)).toEqual(["GetBook", "ListBooks"]);
		const rpcItem = provider.getTreeItem(rpcs[0]);
		expect(rpcItem.description).toBe("(GetBookRequest) returns (Book)");
		expect(iconId(rpcItem)).toBe("symbol-method");
		expect(iconColor(rpcItem)).toBe("terminal.ansiMagenta");
		expect(tooltip(rpcItem)).toContain("Returns one book.");

		// An RPC without a doc comment falls back to naming itself.
		expect(tooltip(provider.getTreeItem(rpcs[1]))).toContain(
			"RPC **ListBooks**",
		);

		const details = await provider.getChildren(rpcs[0]);
		expect(kinds(details)).toEqual(["rpcDetail", "rpcDetail"]);
		expect(details[0].kind === "rpcDetail" && details[0].type).toBe("request");
		expect(details[1].kind === "rpcDetail" && details[1].type).toBe("response");
		expect(provider.getTreeItem(details[0]).label).toBe(
			"Request: GetBookRequest",
		);
		expect(provider.getTreeItem(details[1]).label).toBe("Response: Book");
		expect(iconColor(provider.getTreeItem(details[0]))).toBe(
			"symbolIcon.functionForeground",
		);
		expect(iconColor(provider.getTreeItem(details[1]))).toBe(
			"symbolIcon.methodForeground",
		);
	});

	test("falls back to the RPC line when a type does not resolve", async () => {
		const index = new FakeIndex(smallWorkspace());
		// No resolver at all: the common case when the view is built without one.
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const services = await provider.getChildren(section(roots, "services"));
		const rpcs = await provider.getChildren(services[0]);
		const details = await provider.getChildren(rpcs[0]);

		const request = details[0];
		expect(request.kind === "rpcDetail" && request.uri).toBeUndefined();
		const item = provider.getTreeItem(request);
		expect(tooltip(item)).toContain("Type definition not found");
		const args = command(item)?.arguments as [Uri, Range];
		expect(command(item)?.title).toBe("Go to RPC");
		expect(args[1].start.line).toBe(11);
	});

	test("points a resolved type at its definition", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({
			index,
			resolveType: (typeName) =>
				typeName === "Book"
					? {
							uri: Uri.file("/ws/api/v1/book.proto"),
							range: new Range(4, 8, 4, 12),
						}
					: null,
		});
		const roots = await provider.getChildren();
		const services = await provider.getChildren(section(roots, "services"));
		const rpcs = await provider.getChildren(services[0]);
		const details = await provider.getChildren(rpcs[0]);

		const response = provider.getTreeItem(details[1]);
		expect(command(response)?.title).toBe("Go to type definition");
		const args = command(response)?.arguments as [Uri, Range];
		expect(args[0].fsPath).toBe("/ws/api/v1/book.proto");
		expect(args[1].start.line).toBe(4);
		expect(tooltip(response)).toContain("Response message type: **Book**");

		// The unresolved sibling still falls back to the RPC.
		expect(command(provider.getTreeItem(details[0]))?.title).toBe("Go to RPC");
	});

	test("passes a leading-dot type name through unchanged", async () => {
		const index = new FakeIndex([
			{
				path: "/ws/api/v1/rooted.proto",
				packageName: "acme.rooted.v1",
				symbols: [
					{ name: "RootedService", kind: "service", line: 3 },
					{
						name: "Ping",
						kind: "rpc",
						parent: "RootedService",
						// Fully qualified from the root namespace, the form that has
						// been mishandled in four other parsers in this extension.
						detail:
							"(.acme.rooted.v1.PingRequest) returns (.google.protobuf.Empty)",
						line: 4,
					},
				],
			},
		]);
		const resolved: string[] = [];
		const { provider } = harness({ index, resolved, resolveType: () => null });
		const roots = await provider.getChildren();
		const services = await provider.getChildren(section(roots, "services"));
		const rpcs = await provider.getChildren(services[0]);
		const details = await provider.getChildren(rpcs[0]);

		expect(resolved).toEqual([
			".acme.rooted.v1.PingRequest",
			".google.protobuf.Empty",
		]);
		expect(provider.getTreeItem(details[0]).label).toBe(
			"Request: .acme.rooted.v1.PingRequest",
		);
		expect(provider.getTreeItem(details[1]).label).toBe(
			"Response: .google.protobuf.Empty",
		);
	});

	test("shows the no-index notice inside a symbol section", async () => {
		// The root hides symbol sections when there is no index, but VS Code can
		// still ask for the children of a node it cached before the index went
		// away, and that must not come back as an unexplained empty list.
		const { provider } = harness();
		const children = await provider.getChildren({
			kind: "section",
			id: "services",
			label: "Services",
			icon: "symbol-interface",
		});
		expect(kinds(children)).toEqual(["info"]);
		expect(labels(children)).toEqual(["Workspace index unavailable"]);
	});
});

describe("rpcs section", () => {
	test("labels each RPC with its owning service", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const rpcs = await provider.getChildren(section(roots, "rpcs"));

		expect(labels(rpcs)).toEqual([
			"LibraryService.GetBook",
			"LibraryService.ListBooks",
		]);
		const item = provider.getTreeItem(rpcs[0]);
		expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
		expect(iconId(item)).toBe("symbol-method");
		expect(item.description).toBe("(GetBookRequest) returns (Book)");
		expect(command(item)?.command).toBe("googleApiLinter.revealLocation");
	});
});

describe("messages and enums sections", () => {
	test("lists messages name-sorted and expands one into its members", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const messages = await provider.getChildren(section(roots, "messages"));

		expect(labels(messages)).toEqual(["Book", "Empty", "Shelf"]);
		const book = provider.getTreeItem(messages[0]);
		expect(book.description).toBe("message");
		expect(book.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
		expect(iconId(book)).toBe("symbol-class");
		expect(iconColor(book)).toBe("symbolIcon.classForeground");

		// Fields first, then nested enums — both straight from the index.
		const members = await provider.getChildren(messages[0]);
		expect(kinds(members)).toEqual(["messageField", "messageEnum"]);
		const field = provider.getTreeItem(members[0]);
		expect(field.label).toBe("title");
		expect(field.description).toBe("string");
		expect(iconId(field)).toBe("symbol-field");
		const fieldRange = command(field)?.arguments as [Uri, Range];
		expect(fieldRange[1].start.line).toBe(21);
		expect(fieldRange[1].start.character).toBe(9);
		expect(fieldRange[1].end.character).toBe(14);

		const nested = provider.getTreeItem(members[1]);
		expect(nested.label).toBe("Format");
		expect(nested.description).toBe("enum");
		expect(iconId(nested)).toBe("symbol-enum");
		expect(command(nested)?.title).toBe("Go to enum");
	});

	test("gives a message with no members an empty child list", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const messages = await provider.getChildren(section(roots, "messages"));
		const shelf = messages.find(
			(node) => node.kind === "location" && node.item.label === "Shelf",
		);
		expect(await provider.getChildren(shelf as ProtoTreeNode)).toEqual([]);
	});

	test("lists enums as leaves that cannot be expanded", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const enums = await provider.getChildren(section(roots, "enums"));

		expect(labels(enums)).toEqual(["Format", "Status"]);
		const item = provider.getTreeItem(enums[0]);
		expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
		expect(item.description).toBe("enum");
		expect(iconId(item)).toBe("symbol-enum");
		// Not expandable, so asking for children yields nothing.
		expect(await provider.getChildren(enums[0])).toEqual([]);
	});

	test("keeps same-named messages from different packages apart", async () => {
		// The shape the FHIR tree is full of: `Attachment` in a dozen packages.
		const index = new FakeIndex([
			{
				path: "/ws/a/v6/types.proto",
				packageName: "fhir.base.entities.v6.types",
				symbols: [{ name: "Attachment", kind: "message", line: 5 }],
			},
			{
				path: "/ws/b/v6/types.proto",
				packageName: "fhir.clinical.summary.v6.types",
				symbols: [{ name: "Attachment", kind: "message", line: 9 }],
			},
		]);
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const messages = await provider.getChildren(section(roots, "messages"));

		expect(labels(messages)).toEqual(["Attachment", "Attachment"]);
		const fqns = messages.map((node) =>
			node.kind === "location" ? node.item.fqn : undefined,
		);
		expect(fqns).toEqual([
			"fhir.base.entities.v6.types.Attachment",
			"fhir.clinical.summary.v6.types.Attachment",
		]);
		// Two labels that read the same must still reveal different files.
		const first = command(provider.getTreeItem(messages[0]))?.arguments as [
			Uri,
			Range,
		];
		const second = command(provider.getTreeItem(messages[1]))?.arguments as [
			Uri,
			Range,
		];
		expect(first[0].fsPath).not.toBe(second[0].fsPath);
	});

	test("drops a symbol whose file id no longer resolves", async () => {
		// A symbol left behind by a file the index has since dropped. Rendering
		// it would give the user a node whose click target is undefined, so the
		// view skips it; the section count must not include it either.
		const index = new FakeIndex([
			{
				path: "/ws/live.proto",
				packageName: "acme.v1",
				symbols: [{ name: "Kept", kind: "message", line: 1 }],
			},
			{
				path: "/ws/gone.proto",
				packageName: "acme.v1",
				symbols: [{ name: "Dangling", kind: "message", line: 2 }],
			},
		]);
		const resolvable = index.file.bind(index);
		index.file = (id: number) => (id === 0 ? resolvable(id) : undefined);

		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const messages = await provider.getChildren(section(roots, "messages"));
		expect(labels(messages)).toEqual(["Kept"]);
	});
});

/* ------------------------------------------------------------------ *
 * Version grouping (phase 1b)
 * ------------------------------------------------------------------ */

/** One message per package, across three releases plus an unversioned file. */
function versionedWorkspace(): FileSpec[] {
	const specs: FileSpec[] = [];
	for (const version of ["v4", "v5", "v6"]) {
		for (const stem of ["fhir.base.entities", "fhir.clinical.summary"]) {
			specs.push({
				path: `/ws/${stem.replace(/\./g, "/")}/${version}/types.proto`,
				packageName: `${stem}.${version}.types`,
				symbols: [
					{ name: "Attachment", kind: "message", line: 5 },
					{ name: `Only${version}`, kind: "message", line: 9 },
				],
			});
		}
	}
	specs.push({
		path: "/ws/legacy/shared.proto",
		packageName: "fhir.legacy",
		symbols: [{ name: "Shared", kind: "message", line: 2 }],
	});
	return specs;
}

describe("version grouping", () => {
	test("groups by version newest first, unversioned last", async () => {
		const index = new FakeIndex(versionedWorkspace());
		// Seven files against a ceiling of one: grouping, not refusal.
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();
		const groups = await provider.getChildren(section(roots, "messages"));

		expect(kinds(groups)).toEqual([
			"symbolGroup",
			"symbolGroup",
			"symbolGroup",
			"symbolGroup",
		]);
		expect(labels(groups)).toEqual(["v6", "v5", "v4", "unversioned"]);

		const v6 = provider.getTreeItem(groups[0]);
		expect(v6.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
		expect(v6.description).toBe("4");
		expect(iconId(v6)).toBe("versions");
		// package.json menus key off contextValue; changing it breaks the UI.
		expect(v6.contextValue).toBe("symbolGroup");
		expect(tooltip(v6)).toBe("4 in package version v6");
	});

	test("expands a version into packages and a package into symbols", async () => {
		const index = new FakeIndex(versionedWorkspace());
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();
		const groups = await provider.getChildren(section(roots, "messages"));

		const packages = await provider.getChildren(groups[0]);
		expect(labels(packages)).toEqual([
			"fhir.base.entities",
			"fhir.clinical.summary",
		]);
		const item = provider.getTreeItem(packages[0]);
		expect(iconId(item)).toBe("package");
		expect(item.description).toBe("2");
		expect(tooltip(item)).toBe("2 in fhir.base.entities.v6");

		const symbols = await provider.getChildren(packages[0]);
		expect(kinds(symbols)).toEqual(["location", "location"]);
		expect(labels(symbols)).toEqual(["Attachment", "Onlyv6"]);
	});

	test("skips the version level when there is only one release", async () => {
		const index = new FakeIndex(
			versionedWorkspace().filter((spec) => spec.packageName.includes(".v6.")),
		);
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();
		const groups = await provider.getChildren(section(roots, "messages"));

		// One version group wrapping everything would be a level with one node.
		expect(labels(groups)).toEqual([
			"fhir.base.entities",
			"fhir.clinical.summary",
		]);
		expect(
			groups.every(
				(node) => node.kind === "symbolGroup" && node.packageKey !== undefined,
			),
		).toBe(true);
	});

	test("groups a file with no package statement under (no package)", async () => {
		const index = new FakeIndex([
			{
				path: "/ws/v6/typed.proto",
				packageName: "acme.v6",
				symbols: [{ name: "Typed", kind: "message", line: 1 }],
			},
			{
				path: "/ws/loose.proto",
				packageName: "",
				symbols: [{ name: "Loose", kind: "message", line: 1 }],
			},
		]);
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();
		const groups = await provider.getChildren(section(roots, "messages"));
		expect(labels(groups)).toEqual(["v6", "unversioned"]);

		const packages = await provider.getChildren(groups[1]);
		expect(labels(packages)).toEqual(["(no package)"]);
		expect(labels(await provider.getChildren(packages[0]))).toEqual(["Loose"]);
	});

	test("loses nothing: the groups hold exactly the flat list", async () => {
		const specs = versionedWorkspace();
		const flat = harness({ index: new FakeIndex(specs) });
		const flatRoots = await flat.provider.getChildren();
		const flatNodes = await flat.provider.getChildren(
			section(flatRoots, "messages"),
		);
		expect(kinds(flatNodes).every((kind) => kind === "location")).toBe(true);

		const grouped = harness({ index: new FakeIndex(specs), fileCeiling: 1 });
		const roots = await grouped.provider.getChildren();
		const versions = await grouped.provider.getChildren(
			section(roots, "messages"),
		);
		const reached: string[] = [];
		for (const version of versions) {
			for (const pkg of await grouped.provider.getChildren(version)) {
				for (const symbol of await grouped.provider.getChildren(pkg)) {
					if (symbol.kind === "location") {
						reached.push(symbol.item.fqn ?? symbol.item.label);
					}
				}
			}
		}
		const expected = flatNodes.map((node) =>
			node.kind === "location" ? (node.item.fqn ?? node.item.label) : "",
		);
		expect(reached.sort()).toEqual(expected.sort());
	});

	test("groups on symbol count alone once past the threshold", async () => {
		const symbols = Array.from(
			{ length: SECTION_GROUPING_THRESHOLD + 1 },
			(_, at) => ({
				name: `Message${String(at).padStart(4, "0")}`,
				kind: "message" as SymbolKind,
				line: at,
			}),
		);
		const index = new FakeIndex([
			{ path: "/ws/wide.proto", packageName: "acme.wide.v1", symbols },
		]);
		// One file, far below the ceiling: the width of the list is the trigger.
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const groups = await provider.getChildren(section(roots, "messages"));
		expect(kinds(groups)).toEqual(["symbolGroup"]);
		expect(labels(groups)).toEqual(["acme.wide"]);
	});

	test("stays flat at exactly the threshold", async () => {
		const symbols = Array.from(
			{ length: SECTION_GROUPING_THRESHOLD },
			(_, at) => ({
				name: `Message${String(at).padStart(4, "0")}`,
				kind: "message" as SymbolKind,
				line: at,
			}),
		);
		const index = new FakeIndex([
			{ path: "/ws/wide.proto", packageName: "acme.wide.v1", symbols },
		]);
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const nodes = await provider.getChildren(section(roots, "messages"));
		expect(nodes).toHaveLength(SECTION_GROUPING_THRESHOLD);
		expect(nodes[0].kind).toBe("location");
	});

	test("returns nothing for a group node whose section was never built", async () => {
		// VS Code can hand back a node it cached before a refresh dropped the
		// derived groups. An empty list is the honest answer; the refresh has
		// already asked the tree to rebuild from the root.
		const index = new FakeIndex(versionedWorkspace());
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();
		const groups = await provider.getChildren(section(roots, "messages"));

		provider.refreshStructure();
		expect(await provider.getChildren(groups[0])).toEqual([]);
	});

	test("returns nothing for a version or package it does not know", async () => {
		const index = new FakeIndex(versionedWorkspace());
		const { provider } = harness({ index, fileCeiling: 1 });
		const roots = await provider.getChildren();
		await provider.getChildren(section(roots, "messages"));

		expect(
			await provider.getChildren({
				kind: "symbolGroup",
				section: "messages",
				version: "v99",
				label: "v99",
				count: 0,
				icon: "versions",
			}),
		).toEqual([]);
		expect(
			await provider.getChildren({
				kind: "symbolGroup",
				section: "messages",
				version: "v6",
				packageKey: "not.a.package",
				label: "not.a.package",
				count: 0,
				icon: "package",
			}),
		).toEqual([]);
	});
});

describe("annotations section", () => {
	const annotations = [
		annotation("mcp.v1.tool", "Method", { fileId: 0, line: 11 }),
		annotation("mcp.v1.resource", "Message", { fileId: 0, line: 21 }),
		annotation("cache.v1.ttl", "Field", { fileId: 1, line: 7 }),
	];

	function annotatedIndex(): FakeIndex {
		return new FakeIndex(
			[
				{ path: "/ws/mcp/v1/annotations.proto", packageName: "mcp.v1" },
				{ path: "/ws/cache/v1/annotations.proto", packageName: "cache.v1" },
			],
			{ annotations },
		);
	}

	test("lists namespaces alphabetically with their counts", async () => {
		const { provider } = harness({ index: annotatedIndex() });
		const roots = await provider.getChildren();
		const namespaces = await provider.getChildren(
			section(roots, "annotations"),
		);

		expect(labels(namespaces)).toEqual(["cache.v1", "mcp.v1"]);
		const item = provider.getTreeItem(namespaces[1]);
		expect(item.label).toBe("mcp.v1");
		expect(item.description).toBe("2");
		expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
		expect(iconId(item)).toBe("symbol-namespace");
		expect(iconColor(item)).toBe("symbolIcon.keywordForeground");
		expect(tooltip(item)).toContain("extend google.protobuf.*Options");
	});

	test("expands a namespace into its annotations, name-sorted", async () => {
		const { provider } = harness({ index: annotatedIndex() });
		const roots = await provider.getChildren();
		const namespaces = await provider.getChildren(
			section(roots, "annotations"),
		);
		const items = await provider.getChildren(namespaces[1]);

		expect(labels(items)).toEqual(["resource", "tool"]);
		const tool = provider.getTreeItem(items[1]);
		expect(tool.description).toBe("Method · string");
		expect(iconId(tool)).toBe("symbol-method");
		const target = command(tool)?.arguments as [Uri, Range];
		expect(target[0].fsPath).toBe("/ws/mcp/v1/annotations.proto");
		expect(target[1].start.line).toBe(11);
	});

	test("explains an empty registry rather than showing nothing", async () => {
		const { provider } = harness({ index: new FakeIndex(smallWorkspace()) });
		const children = await provider.getChildren({
			kind: "section",
			id: "annotations",
			label: "Annotations",
			icon: "symbol-keyword",
		});
		expect(labels(children)).toEqual(["No custom annotations found"]);
		expect(provider.getTreeItem(children[0]).description).toBe(
			"no extend blocks indexed",
		);
	});

	test("explains a namespace it cannot expand without an index", async () => {
		const { provider } = harness();
		const children = await provider.getChildren({
			kind: "annotationNamespace",
			namespace: "mcp.v1",
			count: 2,
		});
		expect(labels(children)).toEqual(["Workspace index unavailable"]);
	});
});

/* ------------------------------------------------------------------ *
 * Files and diagnostics
 * ------------------------------------------------------------------ */

/** A diagnostic this extension published, as the collection would hold it. */
function _ours(line: number, message: string, severity: number): Diagnostic {
	const diagnostic = new Diagnostic(
		new Range(line, 0, line, 4),
		message,
		severity,
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	return diagnostic;
}

describe("files section", () => {
	test("is gone — the Explorer already lists files", async () => {
		// This section enumerated every .proto in the workspace and could not
		// filter, open or reveal them any better than the Explorer does.
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		expect(sectionIds(roots)).not.toContain("files");
	});
});

/* ------------------------------------------------------------------ *
 * Folder nodes
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

/** A throwaway directory, removed when the file finishes. */
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proto-view-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempRoots.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("folder nodes", () => {
	test("offers to initialise a folder that has no config", async () => {
		const dir = tempDir();
		const { provider } = harness({
			protos: [path.join(dir, "a.proto"), path.join(dir, "b.proto")],
		});
		const folder: ProtoTreeNode = {
			kind: "folder",
			name: path.basename(dir),
			uri: Uri.file(dir),
		};

		const item = provider.getTreeItem(folder);
		expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
		expect(iconId(item)).toBe("folder");

		const children = await provider.getChildren(folder);
		// The init prompt is all that remains: listing the folder's protos
		// was the Files section's job, and that is gone.
		expect(kinds(children)).toEqual(["init"]);
		const init = provider.getTreeItem(children[0]);
		const args = command(init)?.arguments as [Uri];
		expect(args[0].fsPath).toBe(dir);
	});

	test("drops the init row once the folder has a config", async () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "workspace.protobuf.yaml"), "linter: {}\n");
		const { provider } = harness({ protos: [path.join(dir, "a.proto")] });
		const children = await provider.getChildren({
			kind: "folder",
			name: path.basename(dir),
			uri: Uri.file(dir),
		});
		// A configured folder has nothing left to enumerate: the Files
		// section that listed its protos is gone.
		expect(kinds(children)).toEqual([]);
	});
});

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

describe("resources section", () => {
	test("lists only messages that really carry the option", async () => {
		const dir = tempDir();
		const annotated = path.join(dir, "annotated.proto");
		fs.writeFileSync(
			annotated,
			[
				'syntax = "proto3";',
				"package acme.book.v1;",
				'import "google/api/resource.proto";',
				"",
				"message Book {",
				"  option (google.api.resource) = {",
				'    type: "library.googleapis.com/Book"',
				"  };",
				"}",
				"",
				"message Draft {",
				'  // option (google.api.resource) = { type: "x" };',
				"}",
				"",
			].join("\n"),
		);
		const plain = path.join(dir, "plain.proto");
		fs.writeFileSync(
			plain,
			'syntax = "proto3";\npackage acme.plain.v1;\nmessage Plain {\n}\n',
		);

		const index = new FakeIndex([
			{
				path: annotated,
				packageName: "acme.book.v1",
				imports: ["google/api/resource.proto"],
				symbols: [
					{ name: "Book", kind: "message", line: 4 },
					{ name: "Draft", kind: "message", line: 10 },
				],
			},
			{
				path: plain,
				packageName: "acme.plain.v1",
				symbols: [{ name: "Plain", kind: "message", line: 2 }],
			},
		]);
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const resources = await provider.getChildren(section(roots, "resources"));

		// `Draft`'s option is commented out, and `Plain` never imports the file.
		expect(labels(resources)).toEqual(["Book"]);
		const item = provider.getTreeItem(resources[0]);
		expect(item.description).toBe("google.api.resource");
		expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
		expect(iconId(item)).toBe("symbol-struct");
	});

	test("says the scan stopped rather than implying the list is complete", async () => {
		// More candidates than the resource scan will read. None hold a message,
		// so nothing is read from disk and only the notice is produced.
		const specs = Array.from({ length: 501 }, (_, at) => ({
			path: `/ws/importer${at}.proto`,
			packageName: "acme.v1",
			imports: ["google/api/resource.proto"],
		}));
		const { provider } = harness({ index: new FakeIndex(specs) });
		const roots = await provider.getChildren();
		const resources = await provider.getChildren(section(roots, "resources"));

		expect(kinds(resources)).toEqual(["info"]);
		const item = provider.getTreeItem(resources[0]);
		expect(item.label).toBe("Resource scan stopped at its file limit");
		expect(item.description).toBe("list incomplete");
		expect(tooltip(item)).toContain("google/api/resource.proto");

		// A section holding nothing but a notice badges as empty, not as one.
		const after = await provider.getChildren();
		const node = section(after, "resources");
		expect(node.kind === "section" && node.count).toBe(0);
	});
});

/* ------------------------------------------------------------------ *
 * Refresh and invalidation
 * ------------------------------------------------------------------ */

/** Waits out a debounce window. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirrors `STRUCTURE_REFRESH_DEBOUNCE_MS`, which the view keeps private. If
 * that constant moves, these tests go red rather than quietly waiting too
 * little and asserting on a refresh that had not happened yet.
 */
const STRUCTURE_DEBOUNCE_MS = 400;

describe("refresh", () => {
	test("fires once for the whole tree and drops every derived section", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider, fired } = harness({ index });
		const roots = await provider.getChildren();
		await provider.getChildren(section(roots, "messages"));
		expect(fired).toHaveLength(0);

		provider.refreshStructure();
		expect(fired).toEqual([undefined]);

		// The derived children are gone, but the badge survives: it comes from
		// the index's tally rather than from having expanded the section.
		const after = await provider.getChildren();
		const messages = section(after, "messages");
		expect(messages.kind === "section" && messages.count).toBe(3);
	});

	test("serves an expanded section from cache until something changes", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();

		await provider.getChildren(section(roots, "messages"));
		const walked = index.reads.symbolsInFile;
		expect(walked).toBeGreaterThan(0);

		await provider.getChildren(section(roots, "messages"));
		expect(index.reads.symbolsInFile).toBe(walked);

		provider.refreshStructure();
		await provider.getChildren(section(roots, "messages"));
		expect(index.reads.symbolsInFile).toBeGreaterThan(walked);
	});

	test("yields the new tree and drops the old nodes after a file changes", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider, fired } = harness({ index });
		const roots = await provider.getChildren();
		expect(
			labels(await provider.getChildren(section(roots, "messages"))),
		).toEqual(["Book", "Empty", "Shelf"]);

		index.rebuild([
			{
				path: "/ws/api/v1/library.proto",
				packageName: "acme.library.v1",
				symbols: [
					{ name: "Book", kind: "message", line: 20 },
					{ name: "Author", kind: "message", line: 40 },
				],
			},
		]);
		await sleep(STRUCTURE_DEBOUNCE_MS + 120);
		expect(fired).toEqual([undefined]);

		const refreshed = await provider.getChildren();
		const messages = await provider.getChildren(section(refreshed, "messages"));
		// `Shelf` and `Empty` are gone; `Author` has arrived.
		expect(labels(messages)).toEqual(["Author", "Book"]);
	});

	test("coalesces a burst of index changes into one refresh", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider, fired } = harness({ index });

		index.emitChange();
		index.emitChange();
		index.emitChange();
		await sleep(STRUCTURE_DEBOUNCE_MS - 250);
		// Still inside the debounce window: a `buf.lock` write used to trigger a
		// full rescan per watcher event.
		expect(fired).toEqual([]);

		await sleep(300);
		expect(fired).toEqual([undefined]);
		// One coalesced refresh, and the tree is rebuildable straight after.
		expect(sectionIds(await provider.getChildren())).toContain("messages");
	});

	test("refreshes labels without discarding derived sections", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider, fired } = harness({ index });
		const roots = await provider.getChildren();
		await provider.getChildren(section(roots, "messages"));
		const walked = index.reads.symbolsInFile;

		provider.refreshPresentation();
		expect(fired).toEqual([undefined]);

		// Diagnostic counts changed, not structure: the section stays cached.
		await provider.getChildren(section(roots, "messages"));
		expect(index.reads.symbolsInFile).toBe(walked);
		const after = await provider.getChildren();
		const messages = section(after, "messages");
		expect(messages.kind === "section" && messages.count).toBe(3);
	});

	test("dispose cancels a pending refresh and unsubscribes from the index", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider, fired } = harness({ index });
		expect(index.listenerCount).toBe(1);

		provider.refreshStructureSoon();
		provider.dispose();
		expect(index.listenerCount).toBe(0);

		await sleep(STRUCTURE_DEBOUNCE_MS + 120);
		expect(fired).toEqual([]);
	});

	test("attaches no index subscription when there is no index", () => {
		const { provider, fired } = harness();
		provider.refreshStructure();
		expect(fired).toEqual([undefined]);
		// Disposing twice is what the extension does when the view outlives it.
		provider.dispose();
		provider.dispose();
	});
});

/* ------------------------------------------------------------------ *
 * Edge cases and scale
 * ------------------------------------------------------------------ */

describe("edge cases", () => {
	test("renders an empty workspace without pretending anything is wrong", async () => {
		const index = new FakeIndex([]);
		const { provider } = harness({ index });
		const roots = await provider.getChildren();

		// An empty index is still a usable one: the sections are listed, empty.
		expect(sectionIds(roots)).toEqual([
			"services",
			"rpcs",
			"resources",
			"messages",
			"enums",
		]);
		expect(roots.some((node) => node.kind === "info")).toBe(false);
		for (const id of ["services", "rpcs", "messages", "enums"] as const) {
			expect(await provider.getChildren(section(roots, id))).toEqual([]);
		}
	});

	test("returns nothing for a leaf that cannot have children", async () => {
		const index = new FakeIndex(smallWorkspace());
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		// The last root is a section; sections do have children, so a genuine
		// leaf is needed for this assertion to mean anything.
		// A field inside a message is a leaf: nothing nests below it.
		const messages = await provider.getChildren(section(roots, "messages"));
		const members = await provider.getChildren(messages[0]);
		const field = members.find((node) => node.kind === "messageField");
		expect(field).toBeDefined();
		expect(await provider.getChildren(field as ProtoTreeNode)).toEqual([]);
	});

	test("walks a deeply nested message without leaking inner members", async () => {
		const index = new FakeIndex([
			{
				path: "/ws/nested.proto",
				packageName: "acme.nested.v1",
				symbols: [
					{ name: "Outer", kind: "message", line: 1 },
					{
						name: "outer_field",
						kind: "field",
						parent: "Outer",
						detail: "string",
						line: 2,
					},
					{ name: "Middle", kind: "message", parent: "Outer", line: 3 },
					{
						name: "middle_field",
						kind: "field",
						parent: "Outer.Middle",
						detail: "int32",
						line: 4,
					},
					{ name: "Inner", kind: "message", parent: "Outer.Middle", line: 5 },
				],
			},
		]);
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const messages = await provider.getChildren(section(roots, "messages"));

		// Every level is listed in the flat section, innermost included.
		expect(labels(messages)).toEqual(["Inner", "Middle", "Outer"]);

		const outer = messages.find(
			(node) => node.kind === "location" && node.item.label === "Outer",
		);
		const members = await provider.getChildren(outer as ProtoTreeNode);
		// Only direct members: `middle_field` belongs to `Middle`, not `Outer`.
		expect(labels(members)).toEqual(["outer_field"]);

		const middle = messages.find(
			(node) => node.kind === "location" && node.item.label === "Middle",
		);
		expect(labels(await provider.getChildren(middle as ProtoTreeNode))).toEqual(
			["middle_field"],
		);
	});

	test("caps a section and says so without inflating its badge", async () => {
		const symbols = Array.from(
			{ length: MAX_SECTION_SYMBOLS + 1 },
			(_, at) => ({
				name: `Message${String(at).padStart(6, "0")}`,
				kind: "message" as SymbolKind,
				line: at,
			}),
		);
		const index = new FakeIndex([
			{ path: "/ws/huge.proto", packageName: "acme.huge.v1", symbols },
		]);
		const { provider } = harness({ index });
		const roots = await provider.getChildren();
		const nodes = await provider.getChildren(section(roots, "messages"));

		const notice = nodes[nodes.length - 1];
		expect(notice.kind).toBe("info");
		const item = provider.getTreeItem(notice);
		expect(item.label).toBe(
			`Showing first ${MAX_SECTION_SYMBOLS} of more messages`,
		);
		expect(item.description).toBe(`capped at ${MAX_SECTION_SYMBOLS}`);

		// The badge reports what the workspace has, not what the list shows:
		// "20001" beside a section that displays 20000 rows is the honest
		// pairing, and the notice explains the difference.
		const after = await provider.getChildren();
		const messages = section(after, "messages");
		expect(messages.kind === "section" && messages.count).toBe(
			MAX_SECTION_SYMBOLS + 1,
		);
	});

	test("keeps every level of a 9,000-file workspace narrow", async () => {
		const specs: FileSpec[] = [];
		for (let at = 0; at < 9000; at++) {
			// Stem and version vary independently, so all 36 pairs are populated.
			const version = `v${4 + (Math.floor(at / 12) % 3)}`;
			const stem = `fhir.domain${at % 12}`;
			specs.push({
				path: `/ws/${stem}/${version}/file${at}.proto`,
				packageName: `${stem}.${version}.types`,
				symbols: [
					{ name: `Message${String(at).padStart(5, "0")}`, kind: "message" },
				],
			});
		}
		const index = new FakeIndex(specs);
		const { provider } = harness({ index });

		const roots = await provider.getChildren();
		// The root of a workspace this size still reads nothing but stats.
		expect(index.reads.files).toBe(0);
		expect(index.reads.symbolsInFile).toBe(0);
		expect(sectionIds(roots)).toContain("messages");

		const versions = await provider.getChildren(section(roots, "messages"));
		expect(labels(versions)).toEqual(["v6", "v5", "v4"]);
		let widest = versions.length;
		let reached = 0;
		for (const version of versions) {
			const packages = await provider.getChildren(version);
			widest = Math.max(widest, packages.length);
			for (const pkg of packages) {
				const symbols = await provider.getChildren(pkg);
				widest = Math.max(widest, symbols.length);
				reached += symbols.length;
			}
		}
		expect(reached).toBe(9000);
		// 9,000 siblings in one level is what the old ceiling refused outright.
		expect(widest).toBeLessThan(300);
	});
});

/* ------------------------------------------------------------------ *
 * Registration and wiring
 * ------------------------------------------------------------------ */

/**
 * Mirrors `DIAGNOSTIC_REFRESH_DEBOUNCE_MS`, which the module keeps private.
 */
const DIAGNOSTIC_DEBOUNCE_MS = 350;

type CommandHandler = (...args: never[]) => unknown;

/** The stub's command registry, widened so a test can capture handlers. */
interface CommandRegistry {
	registerCommand: (id: string, handler: CommandHandler) => { dispose(): void };
	executeCommand: (id: string) => Promise<unknown>;
}

/** Everything `registerProtoView` handed to the extension host. */
interface Wiring {
	provider: ProtoTreeDataProvider;
	viewId: string;
	showCollapseAll: boolean | undefined;
	handlers: Map<string, CommandHandler>;
	watchers: FileSystemWatcher[];
	diagnosticListeners: (() => void)[];
	executed: string[];
	subscriptions: { dispose(): void }[];
	fired: (ProtoTreeNode | undefined)[];
}

const registry = commands as unknown as CommandRegistry;
const originalRegisterCommand = registry.registerCommand;
const originalExecuteCommand = registry.executeCommand;
const originalCreateTreeView = window.createTreeView;
const originalCreateWatcher = workspace.createFileSystemWatcher;
const originalOnDidChangeDiagnostics = languages.onDidChangeDiagnostics;

/**
 * Runs `registerProtoView` against captured host APIs.
 *
 * @param executeCommand - Stands in for the built-in collapseAll command
 * @param index - Workspace index to hand the view
 * @returns What was registered, and the events the provider has fired
 */
function register(
	executeCommand: (id: string) => Promise<unknown> = () =>
		Promise.resolve(undefined),
	index?: ProtoIndex,
): Wiring {
	const handlers = new Map<string, CommandHandler>();
	const watchers: FileSystemWatcher[] = [];
	const diagnosticListeners: (() => void)[] = [];
	const executed: string[] = [];
	const subscriptions: { dispose(): void }[] = [];
	let captured: ProtoTreeDataProvider | undefined;
	let viewId = "";
	let showCollapseAll: boolean | undefined;

	registry.registerCommand = (id, handler) => {
		handlers.set(id, handler);
		return { dispose() {} };
	};
	registry.executeCommand = (id) => {
		executed.push(id);
		return executeCommand(id);
	};
	window.createTreeView = (id, options) => {
		viewId = id;
		showCollapseAll = options.showCollapseAll;
		captured = options.treeDataProvider as ProtoTreeDataProvider;
		return { dispose() {} };
	};
	workspace.createFileSystemWatcher = (pattern) => {
		const watcher = new FileSystemWatcher(pattern);
		watchers.push(watcher);
		return watcher;
	};
	languages.onDidChangeDiagnostics = (listener) => {
		diagnosticListeners.push(listener);
		return { dispose() {} };
	};

	workspace.findFiles = async (include: string): Promise<Uri[]> =>
		include.includes("workspace.protobuf.yaml")
			? [Uri.file("/ws/workspace.protobuf.yaml")]
			: [];

	registerProtoView(
		{ subscriptions } as unknown as ExtensionContext,
		new StubDiagnosticCollection("test") as unknown as DiagnosticCollection,
		undefined,
		index,
	);

	const provider = captured as ProtoTreeDataProvider;
	created.push(provider);
	const fired: (ProtoTreeNode | undefined)[] = [];
	provider.onDidChangeTreeData((node) => fired.push(node));
	return {
		provider,
		viewId,
		showCollapseAll,
		handlers,
		watchers,
		diagnosticListeners,
		executed,
		subscriptions,
		fired,
	};
}

afterEach(() => {
	registry.registerCommand = originalRegisterCommand;
	registry.executeCommand = originalExecuteCommand;
	window.createTreeView = originalCreateTreeView;
	workspace.createFileSystemWatcher = originalCreateWatcher;
	languages.onDidChangeDiagnostics = originalOnDidChangeDiagnostics;
});

describe("registerProtoView", () => {
	test("creates the view, its commands and its watchers", () => {
		const wiring = register();

		expect(wiring.viewId).toBe("googleApiLinter.views.structure");
		// The view contributes its own collapse button in package.json.
		expect(wiring.showCollapseAll).toBe(false);
		expect([...wiring.handlers.keys()]).toEqual([
			"googleApiLinter.refreshProtoView",
			"googleApiLinter.collapseAll",
			"googleApiLinter.revealLocation",
		]);
		expect(wiring.watchers.map((watcher) => watcher.pattern)).toEqual([
			"**/workspace.protobuf.yaml",
			"**/{buf.yaml,buf.lock}",
		]);
		// The view is torn down before the provider's emitter and subscription.
		expect(wiring.subscriptions[1]).toBe(wiring.provider);
		expect(wiring.subscriptions).toHaveLength(9);
	});

	test("refreshProtoView rebuilds the tree at once", async () => {
		const wiring = register();
		await wiring.handlers.get("googleApiLinter.refreshProtoView")?.();
		expect(wiring.fired).toEqual([undefined]);
	});

	test("collapseAll delegates to the view's built-in command", async () => {
		const wiring = register();
		await wiring.handlers.get("googleApiLinter.collapseAll")?.();

		expect(wiring.executed).toEqual([
			"workbench.actions.treeView.googleApiLinter.views.structure.collapseAll",
		]);
		// Delegation succeeded, so there is nothing for the view to redraw.
		expect(wiring.fired).toEqual([]);
	});

	test("collapseAll redraws when the built-in command is missing", async () => {
		const wiring = register(() => Promise.reject(new Error("no such command")));
		await wiring.handlers.get("googleApiLinter.collapseAll")?.();
		expect(wiring.fired).toEqual([undefined]);
	});

	test("coalesces a burst of buf.lock writes into one refresh", async () => {
		const wiring = register();
		const buf = wiring.watchers[1];
		// A `buf.lock` rewrite lands as create, change and delete events.
		buf.fireAll();
		buf.fireAll();
		expect(wiring.fired).toEqual([]);

		await sleep(STRUCTURE_DEBOUNCE_MS + 120);
		expect(wiring.fired).toEqual([undefined]);
	});

	test("refreshes when the workspace config is written", async () => {
		const wiring = register();
		wiring.watchers[0].fireAll();
		await sleep(STRUCTURE_DEBOUNCE_MS + 120);
		expect(wiring.fired).toEqual([undefined]);
	});

	test("redraws labels on a diagnostic change, debounced", async () => {
		const wiring = register();
		expect(wiring.diagnosticListeners).toHaveLength(1);
		for (let at = 0; at < 5; at++) {
			wiring.diagnosticListeners[0]();
		}
		await sleep(DIAGNOSTIC_DEBOUNCE_MS - 200);
		expect(wiring.fired).toEqual([]);

		await sleep(250);
		expect(wiring.fired).toEqual([undefined]);
	});

	test("cancels a pending label refresh when the extension deactivates", async () => {
		const wiring = register();
		wiring.diagnosticListeners[0]();
		// The last subscription exists only to clear that timer.
		wiring.subscriptions[wiring.subscriptions.length - 1].dispose();

		await sleep(DIAGNOSTIC_DEBOUNCE_MS + 120);
		expect(wiring.fired).toEqual([]);
	});
});

/* ------------------------------------------------------------------ *
 * The real corpus
 * ------------------------------------------------------------------ */

const RE_PACKAGE = /^package\s+([A-Za-z_][\w.]*)\s*;/;
const RE_TOP = /^(message|enum|service)\s+([A-Za-z_]\w*)\s*\{/;

/**
 * One proto read into a file spec: its package and its top-level declarations.
 * Brace depth is tracked so a nested message never passes for a top-level one,
 * which is what the version grouping counts.
 *
 * @param file - Absolute path to a proto
 * @returns The spec the fake index takes
 */
function scanProto(file: string): FileSpec {
	const text = fs.readFileSync(file, "utf8");
	const symbols: SymbolSpec[] = [];
	let packageName = "";
	let depth = 0;
	let line = 0;

	for (const raw of text.split("\n")) {
		const source = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (depth === 0) {
			const declared = RE_PACKAGE.exec(source);
			if (declared && !packageName) {
				packageName = declared[1];
			}
			const top = RE_TOP.exec(source);
			if (top) {
				symbols.push({
					name: top[2],
					kind: top[1] as SymbolKind,
					line,
					startCol: source.indexOf(top[2]),
				});
			}
		}
		for (const character of source) {
			if (character === "{") {
				depth++;
			} else if (character === "}") {
				depth--;
			}
		}
		line++;
	}
	return { path: file, packageName, symbols };
}

const corpus = hasReferenceCorpus() ? describe : describe.skip;

corpus("the protobuf-fhir tree", () => {
	test("groups the whole tree by release and reaches every message", async () => {
		const specs = listProtos(REFERENCE_PROTO_ROOT as string).map(scanProto);
		const index = new FakeIndex(specs);
		const { provider } = harness({ index });

		const roots = await provider.getChildren();
		// Nothing is walked to draw the root, whatever the workspace size.
		expect(index.reads.files).toBe(0);
		expect(index.reads.symbolsInFile).toBe(0);

		const versions = await provider.getChildren(section(roots, "messages"));
		expect(versions.length).toBeGreaterThan(1);
		expect(kinds(versions).every((kind) => kind === "symbolGroup")).toBe(true);
		// Newest release first, which is the one an author is working in.
		expect(labels(versions)[0]).toBe("v6");

		let reached = 0;
		let widest = versions.length;
		for (const version of versions) {
			const packages = await provider.getChildren(version);
			expect(packages.length).toBeGreaterThan(0);
			widest = Math.max(widest, packages.length);
			for (const pkg of packages) {
				const symbols = await provider.getChildren(pkg);
				widest = Math.max(widest, symbols.length);
				reached += symbols.length;
			}
		}

		const declared = specs.reduce(
			(total, spec) =>
				total +
				(spec.symbols ?? []).filter((symbol) => symbol.kind === "message")
					.length,
			0,
		);
		expect(reached).toBe(declared);
		expect(reached).toBeGreaterThan(1000);
		// The claim the grouping exists to make: no level is a flat wall.
		expect(widest).toBeLessThan(2000);
	});
});
