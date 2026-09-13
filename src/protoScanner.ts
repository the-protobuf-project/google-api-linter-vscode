import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type {
	AnnotationDescriptor,
	AnnotationTarget,
	IndexedSymbol,
	ProtoIndex,
	SymbolKind,
} from "./index/types";

/**
 * Default ceiling on workspace proto files before the Proto view stops
 * enumerating symbols. The integrator should wire a setting to this.
 */
export const DEFAULT_PROTO_VIEW_FILE_CEILING = 5000;

/**
 * Hard cap on how many symbols a single section will materialise, whatever the
 * file ceiling allows. Guards against a tree with 200k children.
 */
export const MAX_SECTION_SYMBOLS = 20000;

/** Hard cap on how many files the resource scan will read from disk. */
export const MAX_RESOURCE_SCAN_FILES = 500;

/**
 * Symbol count above which a section groups its children by package version
 * instead of listing them flat.
 *
 * The number is about what a tree can render, not what the index can hold. A
 * section below this lists fine; above it, VS Code is being handed thousands of
 * siblings it will lay out in one pass, which is what the old file ceiling
 * refused outright. Grouping makes the refusal unnecessary: each level stays
 * small, and the levels below are built only when one is expanded.
 */
export const SECTION_GROUPING_THRESHOLD = 500;

/** Key used for a package that carries no `vN` segment at all. */
export const UNVERSIONED_GROUP = "unversioned";

/**
 * The version segment of a proto package.
 * @param packageName - e.g. `protobuf.fhir.clinical.diagnostics.v6.types`
 * @returns `v6`, or undefined when no segment matches `vN`/`vNalphaM`/`vNbetaM`
 */
export function packageVersion(packageName: string): string | undefined {
	for (const part of packageName.split(".")) {
		if (/^v\d+(?:(?:alpha|beta)\d*)?$/.test(part)) {
			return part;
		}
	}
	return undefined;
}

/**
 * A package name with its version segment and everything after it removed, so
 * the three releases of one module collapse to a single group label.
 * @param packageName - e.g. `protobuf.fhir.clinical.diagnostics.v6.types`
 * @returns e.g. `protobuf.fhir.clinical.diagnostics`
 */
export function packageStem(packageName: string): string {
	const parts = packageName.split(".");
	for (let i = 0; i < parts.length; i++) {
		if (/^v\d+(?:(?:alpha|beta)\d*)?$/.test(parts[i])) {
			return parts.slice(0, i).join(".");
		}
	}
	return packageName;
}

/** One package's symbols within one version group. */
export interface SymbolPackageGroup {
	/** Package stem, version removed. Empty string when the file declares none. */
	readonly key: string;
	readonly label: string;
	readonly symbols: readonly IndexedSymbol[];
}

/** One version's packages. */
export interface SymbolVersionGroup {
	/** `v6`, or {@link UNVERSIONED_GROUP}. */
	readonly key: string;
	readonly label: string;
	readonly count: number;
	readonly packages: readonly SymbolPackageGroup[];
}

/** Symbols of one kind, grouped version-first. */
export interface GroupedSymbols {
	readonly versions: readonly SymbolVersionGroup[];
	/**
	 * The same symbols, flat and name-sorted, so a section small enough to list
	 * flat does not pay for a second walk of the index.
	 */
	readonly symbols: readonly IndexedSymbol[];
	readonly total: number;
	readonly truncated: boolean;
}

/**
 * Every symbol of one kind, grouped by the version segment of its package and
 * then by the package stem.
 *
 * Version first because that is the axis a reader navigates by: an author works
 * in one release at a time, and a flat list interleaves `v4`, `v5` and `v6`
 * spellings of the same name with nothing to tell them apart. The same walk and
 * the same cap as {@link collectSymbolsOfKind} — this only changes the shape.
 *
 * @param index - The workspace index
 * @param kind - Symbol kind to collect
 * @param max - Cap on symbols materialised
 * @returns Version groups, sorted newest version first, packages by name
 */
export function groupSymbolsOfKind(
	index: ProtoIndex,
	kind: SymbolKind,
	max: number = MAX_SECTION_SYMBOLS,
): GroupedSymbols {
	const collected = collectSymbolsOfKind(index, kind, max);
	const byVersion = new Map<string, Map<string, IndexedSymbol[]>>();

	for (const symbol of collected.symbols) {
		const file = index.file(symbol.fileId);
		const packageName = file?.packageName ?? "";
		const version = packageVersion(packageName) ?? UNVERSIONED_GROUP;
		const stem = packageStem(packageName);
		let packages = byVersion.get(version);
		if (!packages) {
			packages = new Map();
			byVersion.set(version, packages);
		}
		const bucket = packages.get(stem);
		if (bucket) {
			bucket.push(symbol);
		} else {
			packages.set(stem, [symbol]);
		}
	}

	const versions: SymbolVersionGroup[] = [];
	for (const [key, packages] of byVersion) {
		const groups: SymbolPackageGroup[] = [];
		let count = 0;
		for (const [stem, symbols] of packages) {
			count += symbols.length;
			groups.push({
				key: stem,
				label: stem === "" ? "(no package)" : stem,
				symbols,
			});
		}
		groups.sort((a, b) => a.label.localeCompare(b.label));
		versions.push({
			key,
			label: key === UNVERSIONED_GROUP ? "unversioned" : key,
			count,
			packages: groups,
		});
	}
	// Newest release first: the version a reader is most likely working in.
	versions.sort((a, b) => compareVersionKeys(a.key, b.key));

	return {
		versions,
		symbols: collected.symbols,
		total: collected.symbols.length,
		truncated: collected.truncated,
	};
}

/**
 * Orders version keys newest first, with `unversioned` last.
 * @param a - First key
 * @param b - Second key
 * @returns Negative when `a` sorts before `b`
 */
function compareVersionKeys(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a === UNVERSIONED_GROUP) {
		return 1;
	}
	if (b === UNVERSIONED_GROUP) {
		return -1;
	}
	const na = Number.parseInt(a.slice(1), 10);
	const nb = Number.parseInt(b.slice(1), 10);
	return na === nb ? a.localeCompare(b) : nb - na;
}

/** One workspace location the Proto view can reveal. */
export interface LocationItem {
	label: string;
	detail?: string;
	/** Documentation snippet (e.g. leading comment) for hover/tooltip. */
	documentation?: string;
	uri: vscode.Uri;
	range: vscode.Range;
	icon: string;
	/** Fully-qualified name, when derived from an indexed symbol. */
	fqn?: string;
	/** Index file id this item came from. */
	fileId?: number;
	/** Symbol kind, when derived from an indexed symbol. */
	symbolKind?: SymbolKind;
	/** Annotation namespace, for items under the Annotations section. */
	namespace?: string;
	/** True when the view should offer children (message fields / enums). */
	expandable?: boolean;
	/** Owning RPC, for items attached to one. */
	rpcName?: string;
}

/** One RPC method, with its request/response types split out. */
export interface RpcItem {
	name: string;
	fullName: string;
	requestType: string;
	responseType: string;
	detail: string;
	documentation?: string;
	uri: vscode.Uri;
	range: vscode.Range;
	/** Fully-qualified name of the method. */
	fqn?: string;
}

/** One service and the RPCs declared inside it. */
export interface ServiceItem {
	name: string;
	uri: vscode.Uri;
	range: vscode.Range;
	rpcs: RpcItem[];
	/** Fully-qualified name of the service. */
	fqn?: string;
}

/** A bounded slice of indexed symbols, flagged when the cap was hit. */
export interface CollectedSymbols {
	readonly symbols: readonly IndexedSymbol[];
	readonly truncated: boolean;
}

/** A bounded slice of derived locations, flagged when the cap was hit. */
export interface CollectedLocations {
	readonly items: readonly LocationItem[];
	readonly truncated: boolean;
}

/** One annotation namespace and how many annotations it declares. */
export interface AnnotationNamespace {
	readonly namespace: string;
	readonly count: number;
}

/**
 * Everything the Proto view can show, derived eagerly. Prefer the per-section
 * collectors below: this materialises every section at once, which is exactly
 * what the lazy view exists to avoid.
 */
export interface WorkspaceProtoScan {
	services: ServiceItem[];
	rpcs: LocationItem[];
	resources: LocationItem[];
	messages: LocationItem[];
	enums: LocationItem[];
	annotations: LocationItem[];
	/** True when any section hit a cap and is therefore incomplete. */
	truncated: boolean;
}

const RE_RPC_DETAIL = /^\(([^)]+)\)\s*returns\s*\(([^)]+)\)$/;
const RE_RESOURCE_OPTION = /option\s*\(\s*google\.api\.resource\s*\)/;
const RE_LINE_COMMENT = /^\s*(\/\/|\/\*|\*)/;
const RESOURCE_IMPORT = "google/api/resource.proto";
const RESOURCE_SCAN_CONCURRENCY = 16;
const MAX_SCANNED_FILE_BYTES = 4_000_000;

/** Resolves an index file id to a URI, or undefined when the id is stale. */
function fileUri(index: ProtoIndex, fileId: number): vscode.Uri | undefined {
	const file = index.file(fileId);
	return file ? vscode.Uri.file(file.path) : undefined;
}

/** The name range of a symbol, as a VS Code range. */
function symbolRange(symbol: IndexedSymbol): vscode.Range {
	return new vscode.Range(
		symbol.line,
		symbol.startCol,
		symbol.line,
		symbol.endCol,
	);
}

/** Last dotted segment of a fully-qualified name. */
function lastSegment(fqn: string): string {
	const dot = fqn.lastIndexOf(".");
	return dot >= 0 ? fqn.slice(dot + 1) : fqn;
}

function compareSymbols(a: IndexedSymbol, b: IndexedSymbol): number {
	const byName = a.name.localeCompare(b.name);
	return byName !== 0 ? byName : a.fqn.localeCompare(b.fqn);
}

/**
 * Every symbol of one kind across the index, sorted by name and capped.
 * Reads only in-memory index data — never opens a document.
 */
export function collectSymbolsOfKind(
	index: ProtoIndex,
	kind: SymbolKind,
	max: number = MAX_SECTION_SYMBOLS,
): CollectedSymbols {
	const symbols: IndexedSymbol[] = [];
	let truncated = false;
	for (const file of index.files()) {
		for (const symbol of index.symbolsInFile(file.id)) {
			if (symbol.kind !== kind) {
				continue;
			}
			if (symbols.length >= max) {
				truncated = true;
				break;
			}
			symbols.push(symbol);
		}
		if (truncated) {
			break;
		}
	}
	symbols.sort(compareSymbols);
	return { symbols, truncated };
}

/** Splits an rpc `detail` of the form `(Req) returns (Res)` into its types. */
export function splitRpcDetail(detail: string | undefined): {
	requestType: string;
	responseType: string;
} {
	const match = (detail ?? "").trim().match(RE_RPC_DETAIL);
	return {
		requestType: match ? match[1].trim() : "",
		responseType: match ? match[2].trim() : "",
	};
}

/** The RPCs declared inside one service, in declaration order. */
export function buildRpcItems(
	index: ProtoIndex,
	service: IndexedSymbol,
): RpcItem[] {
	const uri = fileUri(index, service.fileId);
	if (!uri) {
		return [];
	}
	const prefix = `${service.fqn}.`;
	const rpcs: RpcItem[] = [];
	for (const symbol of index.symbolsInFile(service.fileId)) {
		if (symbol.kind !== "rpc") {
			continue;
		}
		const owned =
			symbol.parentFqn !== undefined
				? symbol.parentFqn === service.fqn
				: symbol.fqn.startsWith(prefix);
		if (!owned) {
			continue;
		}
		const { requestType, responseType } = splitRpcDetail(symbol.detail);
		rpcs.push({
			name: symbol.name,
			fullName: `${service.name}.${symbol.name}`,
			requestType,
			responseType,
			detail: symbol.detail ?? "",
			documentation: symbol.doc,
			uri,
			range: symbolRange(symbol),
			fqn: symbol.fqn,
		});
	}
	rpcs.sort((a, b) => a.name.localeCompare(b.name));
	return rpcs;
}

/** Builds a service node, including its RPC children. */
export function buildServiceItem(
	index: ProtoIndex,
	service: IndexedSymbol,
): ServiceItem | undefined {
	const uri = fileUri(index, service.fileId);
	if (!uri) {
		return undefined;
	}
	return {
		name: service.name,
		uri,
		range: symbolRange(service),
		rpcs: buildRpcItems(index, service),
		fqn: service.fqn,
	};
}

/** Turns an indexed symbol into a revealable location item. */
export function toLocationItem(
	index: ProtoIndex,
	symbol: IndexedSymbol,
	detail: string,
	icon: string,
	expandable = false,
): LocationItem | undefined {
	const uri = fileUri(index, symbol.fileId);
	if (!uri) {
		return undefined;
	}
	return {
		label: symbol.name,
		detail,
		documentation: symbol.doc,
		uri,
		range: symbolRange(symbol),
		icon,
		fqn: symbol.fqn,
		fileId: symbol.fileId,
		symbolKind: symbol.kind,
		expandable,
	};
}

/** Turns an indexed rpc symbol into a `Service.Method` location item. */
export function toRpcLocationItem(
	index: ProtoIndex,
	symbol: IndexedSymbol,
): LocationItem | undefined {
	const item = toLocationItem(
		index,
		symbol,
		symbol.detail ?? "rpc",
		"symbol-method",
	);
	if (!item) {
		return undefined;
	}
	const owner = symbol.parentFqn
		? lastSegment(symbol.parentFqn)
		: lastSegment(
				symbol.fqn.slice(0, Math.max(0, symbol.fqn.lastIndexOf("."))),
			);
	item.label = owner ? `${owner}.${symbol.name}` : symbol.name;
	item.rpcName = item.label;
	return item;
}

/** Fields and nested enums of one message, straight from the index. */
export function collectMessageMembers(
	index: ProtoIndex,
	message: LocationItem,
): { fields: IndexedSymbol[]; enums: IndexedSymbol[] } {
	const fields: IndexedSymbol[] = [];
	const enums: IndexedSymbol[] = [];
	if (message.fileId === undefined || message.fqn === undefined) {
		return { fields, enums };
	}
	const prefix = `${message.fqn}.`;
	for (const symbol of index.symbolsInFile(message.fileId)) {
		const owned =
			symbol.parentFqn !== undefined
				? symbol.parentFqn === message.fqn
				: symbol.fqn.startsWith(prefix);
		if (!owned) {
			continue;
		}
		if (symbol.kind === "field") {
			fields.push(symbol);
		} else if (symbol.kind === "enum") {
			enums.push(symbol);
		}
	}
	return { fields, enums };
}

/* ------------------------------------------------------------------ *
 * Annotations
 * ------------------------------------------------------------------ */

function annotationIcon(target: AnnotationTarget): string {
	switch (target) {
		case "File":
			return "file-code";
		case "Message":
			return "symbol-class";
		case "Field":
			return "symbol-field";
		case "Oneof":
			return "symbol-structure";
		case "Enum":
			return "symbol-enum";
		case "EnumValue":
			return "symbol-enum-member";
		case "Service":
			return "symbol-interface";
		case "Method":
			return "symbol-method";
		default:
			return "symbol-property";
	}
}

/**
 * Every annotation namespace the index discovered, with its annotation count.
 * Nothing here is hardcoded: `mcp.v1`, `cache.v1`, `store.v1` and every future
 * module appear purely because their `extend` blocks exist.
 */
export function collectAnnotationNamespaces(
	index: ProtoIndex,
): AnnotationNamespace[] {
	const counts = new Map<string, number>();
	for (const descriptor of index.annotations().all()) {
		counts.set(
			descriptor.namespace,
			(counts.get(descriptor.namespace) ?? 0) + 1,
		);
	}
	return [...counts.entries()]
		.map(([namespace, count]) => ({ namespace, count }))
		.sort((a, b) => a.namespace.localeCompare(b.namespace));
}

/** Annotations declared in one namespace, sorted by name. */
export function collectAnnotationsIn(
	index: ProtoIndex,
	namespace: string,
): AnnotationDescriptor[] {
	return index
		.annotations()
		.all()
		.filter((descriptor) => descriptor.namespace === namespace)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turns an annotation descriptor into a revealable location item. */
export function annotationLocationItem(
	index: ProtoIndex,
	descriptor: AnnotationDescriptor,
): LocationItem | undefined {
	const uri = fileUri(index, descriptor.fileId);
	if (!uri) {
		return undefined;
	}
	const documentation = descriptor.example
		? `${descriptor.doc ?? descriptor.fqn}\n\n${descriptor.example}`
		: descriptor.doc;
	return {
		label: descriptor.name,
		detail: `${descriptor.target} · ${descriptor.type}`,
		documentation,
		uri,
		range: new vscode.Range(descriptor.line, 0, descriptor.line, 0),
		icon: annotationIcon(descriptor.target),
		fqn: descriptor.fqn,
		fileId: descriptor.fileId,
		namespace: descriptor.namespace,
	};
}

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

function importsResourceOptions(imports: readonly string[]): boolean {
	return imports.some(
		(imported) =>
			imported === RESOURCE_IMPORT || imported.endsWith(`/${RESOURCE_IMPORT}`),
	);
}

/**
 * Messages carrying `option (google.api.resource)`.
 *
 * The index records declarations, not option usage, so this narrows to files
 * that import `google/api/resource.proto` and confirms with a bounded
 * `fs.readFile` pass. Text is discarded immediately; no document is opened.
 */
export async function collectResources(
	index: ProtoIndex,
	maxFiles: number = MAX_RESOURCE_SCAN_FILES,
): Promise<CollectedLocations> {
	const candidates = index
		.files()
		.filter((file) => importsResourceOptions(file.imports));
	const truncated = candidates.length > maxFiles;
	const scanned = truncated ? candidates.slice(0, maxFiles) : candidates;
	const items: LocationItem[] = [];

	for (let i = 0; i < scanned.length; i += RESOURCE_SCAN_CONCURRENCY) {
		const batch = scanned.slice(i, i + RESOURCE_SCAN_CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (file) => {
				const messages = index
					.symbolsInFile(file.id)
					.filter((symbol) => symbol.kind === "message")
					.slice()
					.sort((a, b) => a.line - b.line);
				if (messages.length === 0) {
					return [];
				}
				let text: string;
				try {
					text = await readFile(file.path, "utf8");
				} catch {
					return [];
				}
				if (text.length > MAX_SCANNED_FILE_BYTES) {
					return [];
				}
				const owners = new Set<IndexedSymbol>();
				const lines = text.split("\n");
				for (let line = 0; line < lines.length; line++) {
					const source = lines[line];
					if (RE_LINE_COMMENT.test(source)) {
						continue;
					}
					if (!RE_RESOURCE_OPTION.test(source)) {
						continue;
					}
					let owner: IndexedSymbol | undefined;
					for (const message of messages) {
						if (message.line <= line) {
							owner = message;
						} else {
							break;
						}
					}
					if (owner) {
						owners.add(owner);
					}
				}
				const found: LocationItem[] = [];
				for (const owner of owners) {
					const item = toLocationItem(
						index,
						owner,
						"google.api.resource",
						"symbol-class",
						true,
					);
					if (item) {
						found.push(item);
					}
				}
				return found;
			}),
		);
		for (const found of results) {
			items.push(...found);
		}
	}

	items.sort((a, b) => a.label.localeCompare(b.label));
	return { items, truncated };
}

/* ------------------------------------------------------------------ *
 * Eager scan (compatibility surface)
 * ------------------------------------------------------------------ */

/**
 * Derives every Proto view section from the index in one pass.
 *
 * This never opens a TextDocument: the old implementation called
 * `vscode.workspace.openTextDocument` once per workspace proto, and VS Code
 * retains every such document for the session. Prefer the per-section
 * collectors — the tree uses those so a section costs nothing until expanded.
 */
export async function scanWorkspaceProto(
	index: ProtoIndex,
	max: number = MAX_SECTION_SYMBOLS,
): Promise<WorkspaceProtoScan> {
	const serviceSymbols = collectSymbolsOfKind(index, "service", max);
	const rpcSymbols = collectSymbolsOfKind(index, "rpc", max);
	const messageSymbols = collectSymbolsOfKind(index, "message", max);
	const enumSymbols = collectSymbolsOfKind(index, "enum", max);
	const resources = await collectResources(index);

	const services: ServiceItem[] = [];
	for (const symbol of serviceSymbols.symbols) {
		const item = buildServiceItem(index, symbol);
		if (item) {
			services.push(item);
		}
	}

	const rpcs: LocationItem[] = [];
	for (const symbol of rpcSymbols.symbols) {
		const item = toRpcLocationItem(index, symbol);
		if (item) {
			rpcs.push(item);
		}
	}

	const messages: LocationItem[] = [];
	for (const symbol of messageSymbols.symbols) {
		const item = toLocationItem(index, symbol, "message", "symbol-class", true);
		if (item) {
			messages.push(item);
		}
	}

	const enums: LocationItem[] = [];
	for (const symbol of enumSymbols.symbols) {
		const item = toLocationItem(index, symbol, "enum", "symbol-enum");
		if (item) {
			enums.push(item);
		}
	}

	const annotations: LocationItem[] = [];
	for (const descriptor of index.annotations().all()) {
		const item = annotationLocationItem(index, descriptor);
		if (item) {
			annotations.push(item);
		}
	}
	annotations.sort((a, b) =>
		(a.fqn ?? a.label).localeCompare(b.fqn ?? b.label),
	);

	return {
		services,
		rpcs,
		resources: [...resources.items],
		messages,
		enums,
		annotations,
		truncated:
			serviceSymbols.truncated ||
			rpcSymbols.truncated ||
			messageSymbols.truncated ||
			enumSymbols.truncated ||
			resources.truncated,
	};
}
