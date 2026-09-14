/**
 * Tests for `protoScanner` — the collection, grouping and item-building layer
 * the Proto view sits on.
 *
 * Two properties matter more than anything else here.
 *
 * **Nothing is lost by grouping.** `groupSymbolsOfKind` exists because a flat
 * list of 9,502 messages is what the old file ceiling refused to render, and the
 * refusal left a 9,280-file workspace showing no symbols at all. The replacement
 * is only safe if the sum over every version and package group equals the flat
 * total, so that is asserted on synthetic indexes and again on the real v4/v5/v6
 * tree.
 *
 * **No document is opened.** Every collector here reads the in-memory index or,
 * for the resource scan, `fs.readFile`. The `vscode` stub deliberately has no
 * `workspace.openTextDocument`, so a test that completes is a test that never
 * reached for one.
 *
 * The fake `ProtoIndex` below is deliberately local rather than shared: test
 * files cannot import one another without re-registering each other's tests.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import type { GroupedSymbols, LocationItem } from "../../../protoScanner";
import {
	annotationLocationItem,
	buildRpcItems,
	buildServiceItem,
	collectAnnotationNamespaces,
	collectAnnotationsIn,
	collectMessageMembers,
	collectResources,
	collectSymbolsOfKind,
	DEFAULT_PROTO_VIEW_FILE_CEILING,
	groupSymbolsOfKind,
	MAX_RESOURCE_SCAN_FILES,
	MAX_SECTION_SYMBOLS,
	packageStem,
	packageVersion,
	SECTION_GROUPING_THRESHOLD,
	scanWorkspaceProto,
	splitRpcDetail,
	toLocationItem,
	toRpcLocationItem,
	UNVERSIONED_GROUP,
} from "../../../protoScanner";
import {
	hasReferenceCorpus,
	listProtos,
	REFERENCE_PROTO_ROOT,
} from "../support/fixtures";

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
 * An in-memory `ProtoIndex` holding exactly what the scanner and the view read.
 * `reads` counts index traffic, so a test can prove a section was not walked.
 */
class FakeIndex implements ProtoIndex {
	readonly reads = { files: 0, symbolsInFile: 0 };
	private readonly fileList: IndexedFile[] = [];
	private readonly byId = new Map<number, IndexedFile>();
	private readonly symbolsById = new Map<number, IndexedSymbol[]>();
	private readonly listeners = new Set<() => void>();
	private readonly registry: AnnotationRegistry;
	private readonly tier: IndexTier;
	private readonly degradeReason?: string;

	constructor(specs: readonly FileSpec[], options: FakeOptions = {}) {
		this.tier = options.tier ?? "full";
		this.degradeReason = options.degradeReason;
		this.registry = fakeRegistry(options.annotations ?? []);
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

/** Builds a fake index from file specs. */
function fakeIndex(
	specs: readonly FileSpec[],
	options: FakeOptions = {},
): FakeIndex {
	return new FakeIndex(specs, options);
}

/**
 * An index whose reads are answered by the given functions, for the shapes a
 * real index can produce but a spec cannot: a stale file id, a symbol with no
 * recorded parent.
 */
function readingIndex(reads: {
	files: () => readonly IndexedFile[];
	file: (id: number) => IndexedFile | undefined;
	symbolsInFile: (id: number) => readonly IndexedSymbol[];
}): ProtoIndex {
	return {
		...reads,
		annotations: () => fakeRegistry([]),
	} as unknown as ProtoIndex;
}

/** Unwraps a collector result the rest of the test depends on. */
function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) {
		throw new Error(`expected ${what}`);
	}
	return value;
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
		line: 3,
		...extra,
	};
}

/* ------------------------------------------------------------------ *
 * The real corpus, read the way the index reads it
 * ------------------------------------------------------------------ */

const RE_PACKAGE = /^package\s+([A-Za-z_][\w.]*)\s*;/;
const RE_IMPORT = /^import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/;
const RE_TOP = /^(message|enum|service)\s+([A-Za-z_]\w*)\s*\{/;
const RE_RPC =
	/^\s+rpc\s+([A-Za-z_]\w*)\s*\(\s*(?:stream\s+)?([.\w]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([.\w]+)\s*\)/;
const RE_FIELD =
	/^\s+(?:repeated\s+|optional\s+)?([.\w]+)\s+([a-z_]\w*)\s*=\s*\d+/;

/**
 * One proto read into a file spec: package, imports, top-level declarations and
 * one level of members. Brace depth is tracked so a nested declaration never
 * passes for a top-level one, which is what the version grouping counts.
 */
function scanProto(file: string): FileSpec {
	const text = fs.readFileSync(file, "utf8");
	const imports: string[] = [];
	const symbols: SymbolSpec[] = [];
	let packageName = "";
	let depth = 0;
	let owner: { name: string; kind: SymbolKind } | undefined;
	let line = 0;

	for (const raw of text.split("\n")) {
		const source = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (depth === 0) {
			const declared = RE_PACKAGE.exec(source);
			if (declared && !packageName) {
				packageName = declared[1];
			}
			const imported = RE_IMPORT.exec(source);
			if (imported) {
				imports.push(imported[1]);
			}
			const top = RE_TOP.exec(source);
			if (top) {
				owner = { name: top[2], kind: top[1] as SymbolKind };
				symbols.push({
					name: top[2],
					kind: owner.kind,
					line,
					startCol: source.indexOf(top[2]),
				});
			}
		} else if (depth === 1 && owner?.kind === "service") {
			const rpc = RE_RPC.exec(source);
			if (rpc) {
				symbols.push({
					name: rpc[1],
					kind: "rpc",
					parent: owner.name,
					detail: `(${rpc[2]}) returns (${rpc[3]})`,
					line,
					startCol: source.indexOf(rpc[1]),
				});
			}
		} else if (depth === 1 && owner?.kind === "message") {
			const field = RE_FIELD.exec(source);
			if (field) {
				symbols.push({
					name: field[2],
					kind: "field",
					parent: owner.name,
					detail: field[1],
					line,
					startCol: source.indexOf(field[2]),
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
		if (depth === 0) {
			owner = undefined;
		}
		line++;
	}
	return { path: file, packageName, imports, symbols };
}

let cachedReference: FakeIndex | undefined;

/** The whole protobuf-fhir tree as a fake index, scanned once per process. */
function referenceIndex(): FakeIndex {
	cachedReference ??= fakeIndex(
		listProtos(REFERENCE_PROTO_ROOT as string).map(scanProto),
	);
	return cachedReference;
}

/* ------------------------------------------------------------------ *
 * Package version parsing
 * ------------------------------------------------------------------ */

describe("packageVersion", () => {
	test("finds the version segment wherever it sits", () => {
		expect(packageVersion("a.b.v6.c")).toBe("v6");
		expect(packageVersion("mcp.v1")).toBe("v1");
		expect(packageVersion("v1")).toBe("v1");
		expect(packageVersion("v1.foo")).toBe("v1");
	});

	test("accepts the prerelease spellings", () => {
		expect(packageVersion("foo.v2beta1.bar")).toBe("v2beta1");
		expect(packageVersion("foo.v1alpha.bar")).toBe("v1alpha");
		expect(packageVersion("foo.v1alpha3.bar")).toBe("v1alpha3");
		expect(packageVersion("foo.v1beta.bar")).toBe("v1beta");
	});

	test("accepts a multi-digit major", () => {
		expect(packageVersion("a.v10.b")).toBe("v10");
		expect(packageVersion("a.v123beta45.b")).toBe("v123beta45");
	});

	test("reports nothing for an unversioned package", () => {
		expect(packageVersion("google.api")).toBeUndefined();
		expect(packageVersion("")).toBeUndefined();
		expect(packageVersion("a.version1.b")).toBeUndefined();
		expect(packageVersion("a.v.b")).toBeUndefined();
		expect(packageVersion("a.v1x.b")).toBeUndefined();
		expect(packageVersion("a.vone.b")).toBeUndefined();
	});

	test("is case sensitive, as proto package names are", () => {
		expect(packageVersion("a.V1.b")).toBeUndefined();
	});

	test("takes the first version segment when a package has two", () => {
		expect(packageVersion("a.v6.b.v5.c")).toBe("v6");
	});
});

describe("packageStem", () => {
	test("drops the version segment and everything after it", () => {
		expect(packageStem("a.b.v6.c")).toBe("a.b");
		expect(packageStem("protobuf.fhir.clinical.diagnostics.v6.types")).toBe(
			"protobuf.fhir.clinical.diagnostics",
		);
		expect(packageStem("mcp.v1")).toBe("mcp");
	});

	test("collapses the sub-packages of one release onto one stem", () => {
		expect(packageStem("a.b.v6.types")).toBe(packageStem("a.b.v6.codes"));
	});

	test("returns the whole name when there is no version", () => {
		expect(packageStem("google.api")).toBe("google.api");
		expect(packageStem("")).toBe("");
	});

	test("yields an empty stem when the version is the first segment", () => {
		expect(packageStem("v1")).toBe("");
		expect(packageStem("v1.foo")).toBe("");
	});
});

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

/** Two files, one package each, with a mix of kinds. */
function mixedIndex(): FakeIndex {
	return fakeIndex([
		{
			path: "/w/a.proto",
			packageName: "x.v1",
			symbols: [
				{ name: "Beta", kind: "message" },
				{ name: "Alpha", kind: "message" },
				{ name: "Kind", kind: "enum" },
				{ name: "Svc", kind: "service" },
				{
					name: "Do",
					kind: "rpc",
					parent: "Svc",
					detail: "(Req) returns (Res)",
				},
			],
		},
		{
			path: "/w/b.proto",
			packageName: "y.v2",
			symbols: [
				{ name: "Alpha", kind: "message" },
				{ name: "Gamma", kind: "message" },
			],
		},
	]);
}

describe("collectSymbolsOfKind", () => {
	test("returns only the requested kind", () => {
		const collected = collectSymbolsOfKind(mixedIndex(), "message");
		expect(collected.symbols.map((symbol) => symbol.fqn)).toEqual([
			"x.v1.Alpha",
			"y.v2.Alpha",
			"x.v1.Beta",
			"y.v2.Gamma",
		]);
		expect(collected.truncated).toBe(false);
	});

	test("sorts by bare name first and by fqn to break the tie", () => {
		const collected = collectSymbolsOfKind(mixedIndex(), "message");
		// Both files declare `Alpha`; the package decides which comes first.
		expect(collected.symbols[0].fqn).toBe("x.v1.Alpha");
		expect(collected.symbols[1].fqn).toBe("y.v2.Alpha");
	});

	test("stops at the cap and says so", () => {
		const collected = collectSymbolsOfKind(mixedIndex(), "message", 2);
		expect(collected.symbols).toHaveLength(2);
		expect(collected.truncated).toBe(true);
	});

	test("does not flag truncation when the cap is exactly the total", () => {
		const collected = collectSymbolsOfKind(mixedIndex(), "message", 4);
		expect(collected.symbols).toHaveLength(4);
		expect(collected.truncated).toBe(false);
	});

	test("a zero cap yields nothing but flags the truncation", () => {
		const collected = collectSymbolsOfKind(mixedIndex(), "message", 0);
		expect(collected.symbols).toEqual([]);
		expect(collected.truncated).toBe(true);
	});

	test("an empty index truncates nothing", () => {
		const collected = collectSymbolsOfKind(fakeIndex([]), "message", 0);
		expect(collected.symbols).toEqual([]);
		expect(collected.truncated).toBe(false);
	});

	test("a kind absent from the index is empty, not truncated", () => {
		const collected = collectSymbolsOfKind(mixedIndex(), "extend", 1);
		expect(collected.symbols).toEqual([]);
		expect(collected.truncated).toBe(false);
	});

	test("the documented caps and thresholds are what the view relies on", () => {
		expect(MAX_SECTION_SYMBOLS).toBe(20000);
		expect(SECTION_GROUPING_THRESHOLD).toBe(500);
		expect(MAX_RESOURCE_SCAN_FILES).toBe(500);
		expect(DEFAULT_PROTO_VIEW_FILE_CEILING).toBe(5000);
		expect(UNVERSIONED_GROUP).toBe("unversioned");
	});
});

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

/** `n` messages spread over the given packages, one file per package. */
function packagedIndex(packages: readonly string[], perPackage: number) {
	return fakeIndex(
		packages.map((packageName, position) => ({
			path: `/w/${position}.proto`,
			packageName,
			symbols: Array.from({ length: perPackage }, (_, i) => ({
				name: `M${position}_${String(i).padStart(4, "0")}`,
				kind: "message" as SymbolKind,
			})),
		})),
	);
}

/** Total symbols reachable by walking every version and package group. */
function reachable(grouped: GroupedSymbols): number {
	let total = 0;
	for (const version of grouped.versions) {
		for (const pkg of version.packages) {
			total += pkg.symbols.length;
		}
	}
	return total;
}

describe("groupSymbolsOfKind", () => {
	test("orders versions newest first with unversioned last", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["a.v4.t", "a.v6.t", "google.api", "a.v5.t"], 1),
			"message",
		);
		expect(grouped.versions.map((version) => version.key)).toEqual([
			"v6",
			"v5",
			"v4",
			UNVERSIONED_GROUP,
		]);
	});

	test("compares major versions numerically, not as strings", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["a.v2.t", "a.v10.t", "a.v9.t"], 1),
			"message",
		);
		expect(grouped.versions.map((version) => version.key)).toEqual([
			"v10",
			"v9",
			"v2",
		]);
	});

	test("puts a stable release ahead of its own prereleases", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["a.v2beta1.t", "a.v2.t", "a.v2alpha1.t"], 1),
			"message",
		);
		expect(grouped.versions.map((version) => version.key)).toEqual([
			"v2",
			"v2alpha1",
			"v2beta1",
		]);
	});

	test("sorts packages within a version by label", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["z.pkg.v1.t", "a.pkg.v1.t", "m.pkg.v1.t"], 1),
			"message",
		);
		expect(grouped.versions[0].packages.map((pkg) => pkg.key)).toEqual([
			"a.pkg",
			"m.pkg",
			"z.pkg",
		]);
	});

	test("merges the sub-packages of one release into one group", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["a.b.v6.types", "a.b.v6.codes", "a.b.v6.resource"], 2),
			"message",
		);
		expect(grouped.versions).toHaveLength(1);
		expect(grouped.versions[0].packages).toHaveLength(1);
		expect(grouped.versions[0].packages[0].key).toBe("a.b");
		expect(grouped.versions[0].packages[0].symbols).toHaveLength(6);
	});

	test("loses nothing: every group total sums back to the flat total", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["a.v1.t", "b.v2.t", "c.v2.t", "plain"], 7),
			"message",
		);
		expect(grouped.total).toBe(28);
		expect(grouped.symbols).toHaveLength(28);
		expect(reachable(grouped)).toBe(28);
		const byVersion = grouped.versions.reduce(
			(sum, version) => sum + version.count,
			0,
		);
		expect(byVersion).toBe(28);
	});

	test("carries the flat sorted list alongside the groups", () => {
		const index = packagedIndex(["a.v1.t", "b.v2.t"], 3);
		const grouped = groupSymbolsOfKind(index, "message");
		expect(grouped.symbols).toEqual(
			collectSymbolsOfKind(index, "message").symbols,
		);
	});

	test("labels a file with no package as (no package) under unversioned", () => {
		const grouped = groupSymbolsOfKind(
			fakeIndex([
				{
					path: "/w/bare.proto",
					packageName: "",
					symbols: [{ name: "M", kind: "message" }],
				},
			]),
			"message",
		);
		expect(grouped.versions[0].key).toBe(UNVERSIONED_GROUP);
		expect(grouped.versions[0].label).toBe("unversioned");
		expect(grouped.versions[0].packages[0].key).toBe("");
		expect(grouped.versions[0].packages[0].label).toBe("(no package)");
	});

	test("propagates the cap's truncation flag", () => {
		const grouped = groupSymbolsOfKind(
			packagedIndex(["a.v1.t", "b.v1.t"], 5),
			"message",
			3,
		);
		expect(grouped.truncated).toBe(true);
		expect(grouped.total).toBe(3);
		expect(reachable(grouped)).toBe(3);
	});

	test("an empty index groups into nothing", () => {
		const grouped = groupSymbolsOfKind(fakeIndex([]), "message");
		expect(grouped.versions).toEqual([]);
		expect(grouped.symbols).toEqual([]);
		expect(grouped.total).toBe(0);
		expect(grouped.truncated).toBe(false);
	});

	test("groups a symbol whose file id is unknown as unversioned", () => {
		// `index.file()` answering undefined must not throw; the symbol still has
		// to appear somewhere or the group totals stop matching the flat list.
		const index = fakeIndex([
			{
				path: "/w/a.proto",
				packageName: "a.v1",
				symbols: [{ name: "M", kind: "message" }],
			},
		]);
		const orphan: IndexedSymbol = {
			fqn: "ghost.Gone",
			name: "Gone",
			kind: "message",
			fileId: 99,
			line: 0,
			startCol: 0,
			endCol: 4,
		};
		const grouped = groupSymbolsOfKind(
			readingIndex({
				files: () => index.files(),
				file: (id) => index.file(id),
				symbolsInFile: (id) => [...index.symbolsInFile(id), orphan],
			}),
			"message",
		);
		expect(grouped.total).toBe(2);
		expect(reachable(grouped)).toBe(2);
		expect(grouped.versions.map((version) => version.key)).toEqual([
			"v1",
			UNVERSIONED_GROUP,
		]);
	});
});

/* ------------------------------------------------------------------ *
 * Item building
 * ------------------------------------------------------------------ */

describe("splitRpcDetail", () => {
	test("splits the form the index records", () => {
		expect(splitRpcDetail("(Req) returns (Res)")).toEqual({
			requestType: "Req",
			responseType: "Res",
		});
	});

	test("tolerates extra whitespace around the types", () => {
		expect(splitRpcDetail("  (  Req  )   returns   (  Res  )  ")).toEqual({
			requestType: "Req",
			responseType: "Res",
		});
	});

	test("keeps fully-qualified type names intact", () => {
		expect(splitRpcDetail("(a.b.v1.Req) returns (.c.Res)")).toEqual({
			requestType: "a.b.v1.Req",
			responseType: ".c.Res",
		});
	});

	test("yields empty types for anything it cannot parse", () => {
		expect(splitRpcDetail(undefined)).toEqual({
			requestType: "",
			responseType: "",
		});
		expect(splitRpcDetail("")).toEqual({ requestType: "", responseType: "" });
		expect(splitRpcDetail("rpc")).toEqual({
			requestType: "",
			responseType: "",
		});
		expect(splitRpcDetail("(Req) returns Res")).toEqual({
			requestType: "",
			responseType: "",
		});
		expect(splitRpcDetail("(Req) returns (Res) {}")).toEqual({
			requestType: "",
			responseType: "",
		});
	});

	test("carries a stream modifier through unchanged", () => {
		// Out of contract rather than supported: the index's parser drops `stream`
		// before it writes `detail`, so this shape never reaches here from a real
		// index. Pinned so a parser change that starts emitting it is visible.
		expect(splitRpcDetail("(stream Req) returns (stream Res)")).toEqual({
			requestType: "stream Req",
			responseType: "stream Res",
		});
	});
});

describe("toLocationItem", () => {
	const index = fakeIndex([
		{
			path: "/w/a.proto",
			packageName: "x.v1",
			symbols: [
				{
					name: "M",
					kind: "message",
					line: 12,
					startCol: 8,
					doc: "A message.",
				},
			],
		},
	]);
	const symbol = index.symbolsInFile(0)[0];

	test("carries label, location and index identity", () => {
		const item = toLocationItem(index, symbol, "message", "symbol-class", true);
		expect(item).toBeDefined();
		expect(item?.label).toBe("M");
		expect(item?.detail).toBe("message");
		expect(item?.icon).toBe("symbol-class");
		expect(item?.documentation).toBe("A message.");
		expect(item?.fqn).toBe("x.v1.M");
		expect(item?.fileId).toBe(0);
		expect(item?.symbolKind).toBe("message");
		expect(item?.expandable).toBe(true);
		expect(item?.uri.fsPath).toBe("/w/a.proto");
		expect(item?.range.start.line).toBe(12);
		expect(item?.range.start.character).toBe(8);
		expect(item?.range.end.character).toBe(9);
	});

	test("defaults to a leaf", () => {
		expect(
			toLocationItem(index, symbol, "enum", "symbol-enum")?.expandable,
		).toBe(false);
	});

	test("returns nothing when the file id is stale", () => {
		const stale: IndexedSymbol = { ...symbol, fileId: 404 };
		expect(
			toLocationItem(index, stale, "message", "symbol-class"),
		).toBeUndefined();
	});
});

describe("toRpcLocationItem", () => {
	test("labels an rpc with its owning service", () => {
		const index = fakeIndex([
			{
				path: "/w/a.proto",
				packageName: "x.v1",
				symbols: [
					{ name: "Svc", kind: "service" },
					{
						name: "Get",
						kind: "rpc",
						parent: "Svc",
						detail: "(Req) returns (Res)",
					},
				],
			},
		]);
		const item = toRpcLocationItem(index, index.symbolsInFile(0)[1]);
		expect(item?.label).toBe("Svc.Get");
		expect(item?.rpcName).toBe("Svc.Get");
		expect(item?.detail).toBe("(Req) returns (Res)");
		expect(item?.icon).toBe("symbol-method");
	});

	test("falls back to the fqn when the parent was not recorded", () => {
		const index = fakeIndex([
			{ path: "/w/a.proto", packageName: "x.v1", symbols: [] },
		]);
		const orphan: IndexedSymbol = {
			fqn: "x.v1.Svc.Get",
			name: "Get",
			kind: "rpc",
			fileId: 0,
			line: 1,
			startCol: 2,
			endCol: 5,
		};
		expect(toRpcLocationItem(index, orphan)?.label).toBe("Svc.Get");
	});

	test("uses the bare name when there is no owner to name", () => {
		const index = fakeIndex([
			{ path: "/w/a.proto", packageName: "", symbols: [] },
		]);
		const lonely: IndexedSymbol = {
			fqn: "Get",
			name: "Get",
			kind: "rpc",
			fileId: 0,
			line: 1,
			startCol: 2,
			endCol: 5,
		};
		expect(toRpcLocationItem(index, lonely)?.label).toBe("Get");
	});

	test("describes an rpc with no recorded detail as an rpc", () => {
		const index = fakeIndex([
			{
				path: "/w/a.proto",
				packageName: "x.v1",
				symbols: [
					{ name: "Svc", kind: "service" },
					{ name: "Get", kind: "rpc", parent: "Svc" },
				],
			},
		]);
		expect(toRpcLocationItem(index, index.symbolsInFile(0)[1])?.detail).toBe(
			"rpc",
		);
	});
});

describe("buildServiceItem", () => {
	const index = fakeIndex([
		{
			path: "/w/a.proto",
			packageName: "x.v1",
			symbols: [
				{ name: "Alpha", kind: "service" },
				{
					name: "Zulu",
					kind: "rpc",
					parent: "Alpha",
					detail: "(ZReq) returns (ZRes)",
					doc: "Last alphabetically.",
				},
				{
					name: "Bravo",
					kind: "rpc",
					parent: "Alpha",
					detail: "(BReq) returns (BRes)",
				},
				{ name: "Other", kind: "service" },
				{
					name: "Charlie",
					kind: "rpc",
					parent: "Other",
					detail: "(CReq) returns (CRes)",
				},
			],
		},
	]);

	test("includes only the rpcs the service owns", () => {
		const service = buildServiceItem(index, index.symbolsInFile(0)[0]);
		expect(service?.name).toBe("Alpha");
		expect(service?.fqn).toBe("x.v1.Alpha");
		expect(service?.rpcs.map((rpc) => rpc.name)).toEqual(["Bravo", "Zulu"]);
	});

	test("splits each rpc's request and response and names it fully", () => {
		const service = buildServiceItem(index, index.symbolsInFile(0)[0]);
		const zulu = service?.rpcs.find((rpc) => rpc.name === "Zulu");
		expect(zulu?.fullName).toBe("Alpha.Zulu");
		expect(zulu?.requestType).toBe("ZReq");
		expect(zulu?.responseType).toBe("ZRes");
		expect(zulu?.documentation).toBe("Last alphabetically.");
		expect(zulu?.fqn).toBe("x.v1.Alpha.Zulu");
	});

	test("returns nothing when the service's file id is stale", () => {
		const stale: IndexedSymbol = {
			...index.symbolsInFile(0)[0],
			fileId: 404,
		};
		expect(buildServiceItem(index, stale)).toBeUndefined();
		expect(buildRpcItems(index, stale)).toEqual([]);
	});

	test("claims an rpc by fqn prefix when no parent was recorded", () => {
		const loose = fakeIndex([
			{ path: "/w/a.proto", packageName: "x.v1", symbols: [] },
		]);
		const service: IndexedSymbol = {
			fqn: "x.v1.Svc",
			name: "Svc",
			kind: "service",
			fileId: 0,
			line: 0,
			startCol: 0,
			endCol: 3,
		};
		const rpc: IndexedSymbol = {
			fqn: "x.v1.Svc.Get",
			name: "Get",
			kind: "rpc",
			fileId: 0,
			line: 1,
			startCol: 2,
			endCol: 5,
			detail: "(Req) returns (Res)",
		};
		const patched = readingIndex({
			files: () => loose.files(),
			file: (id) => loose.file(id),
			symbolsInFile: () => [service, rpc],
		});
		expect(buildRpcItems(patched, service).map((entry) => entry.name)).toEqual([
			"Get",
		]);
	});
});

describe("collectMessageMembers", () => {
	const index = fakeIndex([
		{
			path: "/w/a.proto",
			packageName: "x.v1",
			symbols: [
				{ name: "M", kind: "message" },
				{ name: "id", kind: "field", parent: "M", detail: "string" },
				{ name: "kind", kind: "field", parent: "M", detail: "Kind" },
				{ name: "Kind", kind: "enum", parent: "M" },
				{ name: "Other", kind: "message" },
				{ name: "other_id", kind: "field", parent: "Other", detail: "string" },
			],
		},
	]);

	/** The `M` message as the view would hand it to the collector. */
	function messageItem(): LocationItem {
		return required(
			toLocationItem(
				index,
				index.symbolsInFile(0)[0],
				"message",
				"symbol-class",
				true,
			),
			"location item for M",
		);
	}

	test("returns the message's own fields and nested enums", () => {
		const { fields, enums } = collectMessageMembers(index, messageItem());
		expect(fields.map((field) => field.name)).toEqual(["id", "kind"]);
		expect(fields.map((field) => field.detail)).toEqual(["string", "Kind"]);
		expect(enums.map((nested) => nested.name)).toEqual(["Kind"]);
	});

	test("does not reach into a sibling message", () => {
		const { fields } = collectMessageMembers(index, messageItem());
		expect(fields.map((field) => field.name)).not.toContain("other_id");
	});

	test("returns nothing when the item carries no index identity", () => {
		const empty = { fields: [], enums: [] };
		expect(
			collectMessageMembers(index, { ...messageItem(), fileId: undefined }),
		).toEqual(empty);
		expect(
			collectMessageMembers(index, { ...messageItem(), fqn: undefined }),
		).toEqual(empty);
	});

	test("claims a member by fqn prefix when no parent was recorded", () => {
		const loose: IndexedSymbol = {
			fqn: "x.v1.M.loose",
			name: "loose",
			kind: "field",
			fileId: 0,
			line: 9,
			startCol: 2,
			endCol: 7,
			detail: "string",
		};
		const patched = readingIndex({
			files: () => index.files(),
			file: (id) => index.file(id),
			symbolsInFile: () => [loose],
		});
		expect(
			collectMessageMembers(patched, messageItem()).fields.map((f) => f.name),
		).toEqual(["loose"]);
	});
});

/* ------------------------------------------------------------------ *
 * Annotations
 * ------------------------------------------------------------------ */

describe("annotation collection", () => {
	const descriptors = [
		annotation("mcp.v1.tool", "Method"),
		annotation("mcp.v1.resource", "Message"),
		annotation("cache.v1.cache", "Message", {
			type: "CacheOptions",
			doc: "Caches a resource.",
			example: "option (cache.v1.cache) = {};",
			line: 9,
		}),
		annotation("store.v1.table", "Message"),
	];
	const index = fakeIndex(
		[{ path: "/w/annotations.proto", packageName: "mcp.v1" }],
		{ annotations: descriptors },
	);

	test("counts every namespace it found, sorted by name", () => {
		expect(collectAnnotationNamespaces(index)).toEqual([
			{ namespace: "cache.v1", count: 1 },
			{ namespace: "mcp.v1", count: 2 },
			{ namespace: "store.v1", count: 1 },
		]);
	});

	test("an index with no extend blocks has no namespaces", () => {
		expect(collectAnnotationNamespaces(fakeIndex([]))).toEqual([]);
	});

	test("lists one namespace's annotations by name", () => {
		expect(
			collectAnnotationsIn(index, "mcp.v1").map((entry) => entry.name),
		).toEqual(["resource", "tool"]);
		expect(collectAnnotationsIn(index, "nope.v1")).toEqual([]);
	});

	test("turns a descriptor into a revealable item", () => {
		const item = annotationLocationItem(index, descriptors[2]);
		expect(item?.label).toBe("cache");
		expect(item?.detail).toBe("Message · CacheOptions");
		expect(item?.documentation).toBe(
			"Caches a resource.\n\noption (cache.v1.cache) = {};",
		);
		expect(item?.namespace).toBe("cache.v1");
		expect(item?.fqn).toBe("cache.v1.cache");
		expect(item?.range.start.line).toBe(9);
		expect(item?.range.start.character).toBe(0);
	});

	test("falls back to the fqn when an example has no prose beside it", () => {
		const item = annotationLocationItem(
			index,
			annotation("x.v1.thing", "File", {
				example: "option (x.v1.thing) = {};",
			}),
		);
		expect(item?.documentation).toBe("x.v1.thing\n\noption (x.v1.thing) = {};");
	});

	test("picks an icon from the target, never from the name", () => {
		const icons = new Map(
			(
				[
					"File",
					"Message",
					"Field",
					"Oneof",
					"Enum",
					"EnumValue",
					"Service",
					"Method",
				] as AnnotationTarget[]
			).map((target) => [
				target,
				annotationLocationItem(index, annotation("x.v1.a", target))?.icon,
			]),
		);
		expect(icons.get("File")).toBe("file-code");
		expect(icons.get("Message")).toBe("symbol-class");
		expect(icons.get("Field")).toBe("symbol-field");
		expect(icons.get("Oneof")).toBe("symbol-structure");
		expect(icons.get("Enum")).toBe("symbol-enum");
		expect(icons.get("EnumValue")).toBe("symbol-enum-member");
		expect(icons.get("Service")).toBe("symbol-interface");
		expect(icons.get("Method")).toBe("symbol-method");
		expect(new Set(icons.values()).size).toBe(8);
	});

	test("returns nothing when the descriptor's file id is stale", () => {
		expect(
			annotationLocationItem(
				index,
				annotation("x.v1.a", "File", { fileId: 7 }),
			),
		).toBeUndefined();
	});
});

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "proto-scanner-"));

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Writes a proto into the temp root and returns its absolute path. */
function writeProto(name: string, text: string): string {
	const target = path.join(tempRoot, name);
	fs.writeFileSync(target, text);
	return target;
}

describe("collectResources", () => {
	const RESOURCE_IMPORT = "google/api/resource.proto";

	test("finds the message carrying the option", async () => {
		const file = writeProto(
			"resource.proto",
			`syntax = "proto3";
package x.v1;
import "google/api/resource.proto";

message Book {
  option (google.api.resource) = {
    type: "example.com/Book"
  };
  string name = 1;
}
`,
		);
		const index = fakeIndex([
			{
				path: file,
				packageName: "x.v1",
				imports: [RESOURCE_IMPORT],
				symbols: [{ name: "Book", kind: "message", line: 4 }],
			},
		]);
		const collected = await collectResources(index);
		expect(collected.items.map((item) => item.label)).toEqual(["Book"]);
		expect(collected.items[0].detail).toBe("google.api.resource");
		// A resource carries its own glyph so it cannot be mistaken for a
		// plain message in the tree.
		expect(collected.items[0].icon).toBe("symbol-struct");
		expect(collected.items[0].expandable).toBe(true);
		expect(collected.truncated).toBe(false);
	});

	test("skips a file that does not import resource.proto", async () => {
		const file = writeProto(
			"no_import.proto",
			`package x.v1;
message Book {
  option (google.api.resource) = {};
}
`,
		);
		const index = fakeIndex([
			{
				path: file,
				packageName: "x.v1",
				imports: ["google/api/field_behavior.proto"],
				symbols: [{ name: "Book", kind: "message", line: 1 }],
			},
		]);
		expect((await collectResources(index)).items).toEqual([]);
	});

	test("accepts an import written with a longer prefix", async () => {
		const file = writeProto(
			"prefixed.proto",
			`package x.v1;
message Book {
  option (google.api.resource) = {};
}
`,
		);
		const index = fakeIndex([
			{
				path: file,
				packageName: "x.v1",
				imports: [`third_party/${RESOURCE_IMPORT}`],
				symbols: [{ name: "Book", kind: "message", line: 1 }],
			},
		]);
		expect((await collectResources(index)).items.map((i) => i.label)).toEqual([
			"Book",
		]);
	});

	test("ignores a commented-out option and a resource_reference", async () => {
		const file = writeProto(
			"commented.proto",
			`package x.v1;
import "google/api/resource.proto";
message Book {
  // option (google.api.resource) = {};
  /* option (google.api.resource) = {}; */
  string author = 1 [(google.api.resource_reference).type = "example.com/A"];
}
`,
		);
		const index = fakeIndex([
			{
				path: file,
				packageName: "x.v1",
				imports: [RESOURCE_IMPORT],
				symbols: [{ name: "Book", kind: "message", line: 2 }],
			},
		]);
		expect((await collectResources(index)).items).toEqual([]);
	});

	test("attributes the option to the message it sits inside", async () => {
		const file = writeProto(
			"two.proto",
			`package x.v1;
import "google/api/resource.proto";
message First {
  string a = 1;
}
message Second {
  option (google.api.resource) = {};
}
`,
		);
		const index = fakeIndex([
			{
				path: file,
				packageName: "x.v1",
				imports: [RESOURCE_IMPORT],
				symbols: [
					{ name: "Second", kind: "message", line: 5 },
					{ name: "First", kind: "message", line: 2 },
				],
			},
		]);
		expect((await collectResources(index)).items.map((i) => i.label)).toEqual([
			"Second",
		]);
	});

	test("lists a file's resources once each, sorted by name", async () => {
		const file = writeProto(
			"many.proto",
			`package x.v1;
import "google/api/resource.proto";
message Zebra {
  option (google.api.resource) = {};
  option (google.api.resource) = {};
}
message Apple {
  option (google.api.resource) = {};
}
`,
		);
		const index = fakeIndex([
			{
				path: file,
				packageName: "x.v1",
				imports: [RESOURCE_IMPORT],
				symbols: [
					{ name: "Zebra", kind: "message", line: 2 },
					{ name: "Apple", kind: "message", line: 6 },
				],
			},
		]);
		expect((await collectResources(index)).items.map((i) => i.label)).toEqual([
			"Apple",
			"Zebra",
		]);
	});

	test("survives a file that has gone missing since indexing", async () => {
		const index = fakeIndex([
			{
				path: path.join(tempRoot, "deleted.proto"),
				packageName: "x.v1",
				imports: [RESOURCE_IMPORT],
				symbols: [{ name: "Gone", kind: "message", line: 0 }],
			},
		]);
		const collected = await collectResources(index);
		expect(collected.items).toEqual([]);
		expect(collected.truncated).toBe(false);
	});

	test("reads nothing from a candidate that declares no message", async () => {
		const file = writeProto(
			"empty.proto",
			`package x.v1;
import "google/api/resource.proto";
`,
		);
		const index = fakeIndex([
			{ path: file, packageName: "x.v1", imports: [RESOURCE_IMPORT] },
		]);
		expect((await collectResources(index)).items).toEqual([]);
	});

	test("stops at the file limit and says the list is a prefix", async () => {
		const files = Array.from({ length: 4 }, (_, i) => {
			const file = writeProto(
				`capped_${i}.proto`,
				`package x.v1;
import "google/api/resource.proto";
message M${i} {
  option (google.api.resource) = {};
}
`,
			);
			return {
				path: file,
				packageName: "x.v1",
				imports: [RESOURCE_IMPORT],
				symbols: [{ name: `M${i}`, kind: "message" as SymbolKind, line: 2 }],
			};
		});
		const collected = await collectResources(fakeIndex(files), 2);
		expect(collected.truncated).toBe(true);
		expect(collected.items).toHaveLength(2);
		expect(collected.items.map((item) => item.label)).toEqual(["M0", "M1"]);
	});

	test("does not truncate when the candidates exactly fill the limit", async () => {
		const file = writeProto(
			"exact.proto",
			`package x.v1;
import "google/api/resource.proto";
message Exact {
  option (google.api.resource) = {};
}
`,
		);
		const collected = await collectResources(
			fakeIndex([
				{
					path: file,
					packageName: "x.v1",
					imports: [RESOURCE_IMPORT],
					symbols: [{ name: "Exact", kind: "message", line: 2 }],
				},
			]),
			1,
		);
		expect(collected.truncated).toBe(false);
		expect(collected.items).toHaveLength(1);
	});
});

/* ------------------------------------------------------------------ *
 * The eager compatibility surface
 * ------------------------------------------------------------------ */

describe("scanWorkspaceProto", () => {
	test("derives every section in one pass", async () => {
		const scan = await scanWorkspaceProto(
			fakeIndex(
				[
					{
						path: "/w/a.proto",
						packageName: "x.v1",
						symbols: [
							{ name: "M", kind: "message" },
							{ name: "Kind", kind: "enum" },
							{ name: "Svc", kind: "service" },
							{
								name: "Get",
								kind: "rpc",
								parent: "Svc",
								detail: "(Req) returns (Res)",
							},
						],
					},
				],
				{ annotations: [annotation("x.v1.thing", "File")] },
			),
		);
		expect(scan.messages.map((item) => item.label)).toEqual(["M"]);
		expect(scan.enums.map((item) => item.label)).toEqual(["Kind"]);
		expect(scan.services.map((item) => item.name)).toEqual(["Svc"]);
		expect(scan.rpcs.map((item) => item.label)).toEqual(["Svc.Get"]);
		expect(scan.annotations.map((item) => item.label)).toEqual(["thing"]);
		expect(scan.resources).toEqual([]);
		expect(scan.truncated).toBe(false);
	});

	test("reports truncation when any one section hit its cap", async () => {
		const scan = await scanWorkspaceProto(packagedIndex(["x.v1.t"], 5), 2);
		expect(scan.messages).toHaveLength(2);
		expect(scan.truncated).toBe(true);
	});

	test("returns empty sections for an empty index", async () => {
		const scan = await scanWorkspaceProto(fakeIndex([]));
		expect(scan).toMatchObject({
			services: [],
			rpcs: [],
			resources: [],
			messages: [],
			enums: [],
			annotations: [],
			truncated: false,
		});
	});
});

/* ------------------------------------------------------------------ *
 * The real v4/v5/v6 tree
 * ------------------------------------------------------------------ */

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"groups every top-level message without losing one",
		() => {
			const grouped = groupSymbolsOfKind(referenceIndex(), "message");
			expect(grouped.total).toBe(9502);
			expect(grouped.truncated).toBe(false);
			expect(grouped.symbols).toHaveLength(9502);
			expect(reachable(grouped)).toBe(9502);
			expect(
				grouped.versions.reduce((sum, version) => sum + version.count, 0),
			).toBe(9502);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"finds the three releases, newest first",
		() => {
			const grouped = groupSymbolsOfKind(referenceIndex(), "message");
			expect(grouped.versions.map((version) => version.key)).toEqual([
				"v6",
				"v5",
				"v4",
			]);
			expect(grouped.versions.map((version) => version.count)).toEqual([
				3163, 3400, 2939,
			]);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"keeps every level of the tree small enough to render",
		() => {
			const grouped = groupSymbolsOfKind(referenceIndex(), "message");
			for (const version of grouped.versions) {
				// The same 23 modules exist in each release, so the package level is
				// the same width whichever version a reader opens.
				expect(version.packages).toHaveLength(23);
			}
			const widest = Math.max(
				...grouped.versions.flatMap((version) =>
					version.packages.map((pkg) => pkg.symbols.length),
				),
			);
			expect(widest).toBe(246);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"strips the version out of every package label",
		() => {
			const grouped = groupSymbolsOfKind(referenceIndex(), "message");
			for (const version of grouped.versions) {
				for (const pkg of version.packages) {
					expect(packageVersion(pkg.key)).toBeUndefined();
					expect(pkg.label).toBe(pkg.key);
					expect(pkg.symbols.length).toBeGreaterThan(0);
				}
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"collects the other kinds at the same scale",
		() => {
			const index = referenceIndex();
			expect(collectSymbolsOfKind(index, "enum").symbols).toHaveLength(1933);
			expect(collectSymbolsOfKind(index, "service").symbols).toHaveLength(431);
			// Every section is well under the hard cap, so nothing is lost to it.
			expect(
				collectSymbolsOfKind(index, "message", MAX_SECTION_SYMBOLS).truncated,
			).toBe(false);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"builds a service with the rpcs it owns and nobody else's",
		() => {
			const index = referenceIndex();
			const services = collectSymbolsOfKind(index, "service").symbols;
			for (const symbol of services.slice(0, 20)) {
				const service = buildServiceItem(index, symbol);
				expect(service).toBeDefined();
				for (const rpc of service?.rpcs ?? []) {
					expect(rpc.fqn?.startsWith(`${symbol.fqn}.`)).toBe(true);
					expect(rpc.requestType.length).toBeGreaterThan(0);
					expect(rpc.responseType.length).toBeGreaterThan(0);
				}
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"confirms google.api.resource straight from disk",
		async () => {
			const index = referenceIndex();
			const candidates = index
				.files()
				.filter((file) => file.imports.includes("google/api/resource.proto"))
				.slice(0, 12);
			const subset = fakeIndex(
				candidates.map((file) => ({
					path: file.path,
					packageName: file.packageName,
					imports: [...file.imports],
					symbols: index.symbolsInFile(file.id).map((symbol) => ({
						name: symbol.name,
						kind: symbol.kind,
						parent: symbol.parentFqn
							? symbol.parentFqn.slice(symbol.parentFqn.lastIndexOf(".") + 1)
							: undefined,
						detail: symbol.detail,
						line: symbol.line,
						startCol: symbol.startCol,
					})),
				})),
			);
			const collected = await collectResources(subset);
			expect(collected.truncated).toBe(false);
			expect(collected.items.length).toBeGreaterThan(0);
			const owners = new Set(
				collected.items.map((item) => `${item.fileId}:${item.label}`),
			);
			expect(owners.size).toBe(collected.items.length);
			for (const item of collected.items) {
				expect(item.detail).toBe("google.api.resource");
				expect(item.symbolKind).toBe("message");
				expect(item.expandable).toBe(true);
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"crosses the grouping threshold on a workspace this size",
		() => {
			const grouped = groupSymbolsOfKind(referenceIndex(), "message");
			expect(grouped.total).toBeGreaterThan(SECTION_GROUPING_THRESHOLD);
			expect(referenceIndex().stats().fileCount).toBeGreaterThan(
				DEFAULT_PROTO_VIEW_FILE_CEILING,
			);
		},
	);
});
