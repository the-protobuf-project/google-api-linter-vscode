/**
 * The workspace proto index.
 *
 * ## Why this exists
 *
 * The extension used to call `vscode.workspace.openTextDocument` once per
 * `.proto` to answer definitions, references, symbols and the Proto view. VS
 * Code retains every document it opens for the life of the session and exposes
 * no way to close one, so on a 9,280-file workspace the extension host grew to
 * about 60 GB. This index replaces all of that: node `fs` reads each file once,
 * a regex parser pulls out declarations and type references, and **the text is
 * dropped immediately**.
 *
 * ## How memory stays bounded
 *
 * 1. No file text is retained, and every retained substring is flattened first
 *    (see `strings.ts` — a V8 `SlicedString` would pin the whole source file).
 * 2. Strings are interned; hot storage is columnar typed arrays of pool ids.
 *    {@link IndexedSymbol} objects exist only as query results.
 * 3. A pre-flight walk measures file count and bytes, and a tier is chosen
 *    against the injected {@link IndexBudget} before anything is read. Real
 *    heap use is re-checked during the build and the tier degrades — loudly,
 *    with a reason a human can read — rather than consuming the machine.
 *
 * The budget is injected, never read from `vscode.workspace.getConfiguration`,
 * so all of this is testable under plain node.
 *
 * ## Symbols are fully qualified
 *
 * Every symbol is keyed by `package` + nesting. Simple-name matching is what
 * made Rename rewrite 154 files at once on protobuf-fhir, where 76% of type
 * names are ambiguous across `v4`/`v5`/`v6`. {@link ProtoIndexImpl.referencesTo}
 * returns only references that genuinely resolve to the exact fqn asked for,
 * and a reference that could mean two different types resolves to neither.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractAnnotations } from "../annotations/extractor";
import { AnnotationRegistryImpl } from "../annotations/registry";
import { scanRootsInto } from "../annotations/scan";
import { type ParsedFile, parseProtoText } from "./parser";
import {
	KIND_ENUM,
	KIND_MESSAGE,
	kindId,
	ReferenceStore,
	SYMBOL_KINDS,
	SymbolStore,
} from "./store";
import { StringPool } from "./strings";
import type {
	AnnotationRegistry,
	IndexBudget,
	IndexedFile,
	IndexedReference,
	IndexedSymbol,
	IndexStats,
	IndexTier,
	ProtoIndex,
} from "./types";
import { importPathFor, walkProtoFiles } from "./walk";

/**
 * Default ceiling. Deliberately generous enough for protobuf-fhir at `full`
 * (measured ~95 MB) and far below anything that would threaten the host.
 */
export const DEFAULT_INDEX_BUDGET: IndexBudget = {
	maxMemoryMB: 256,
	maxFiles: 20000,
};

/** File ids handed to the annotation scanner for roots outside the walk. */
const EXTERNAL_FILE_ID_BASE = 1_000_000;

/** Files read between heap checks during a build. */
const MONITOR_STRIDE = 512;

/** Bytes of index per byte of proto text, measured on protobuf-fhir. */
const FULL_TIER_FACTOR = 2.4;
const REDUCED_TIER_FACTOR = 0.9;
/** Fixed overhead per file, in MB. */
const PER_FILE_MB = 0.0005;

/** Ceiling on candidates examined by {@link ProtoIndexImpl.searchSymbols}. */
const SEARCH_CANDIDATE_CAP = 4096;

/** Ceiling on files re-read to resolve annotation option bodies. */
const ANNOTATION_CLOSURE_CAP = 2048;

/** Construction-time wiring. Everything optional has a safe default. */
export interface ProtoIndexOptions {
	/** Memory ladder limits. Injected so the ladder is testable outside VS Code. */
	readonly budget?: IndexBudget;
	/** Files read concurrently. Default 32. */
	readonly concurrency?: number;
	/** Populate the annotation registry during the walk. Default true. */
	readonly scanAnnotations?: boolean;
	/**
	 * Extra import roots scanned for annotations only — chiefly the buf module
	 * cache, where the option definitions live outside the workspace.
	 */
	readonly annotationRoots?: readonly string[];
	/** Supplies {@link IndexedFile.moduleRoot} from the module graph. */
	readonly moduleRootOf?: (absolutePath: string) => string | undefined;
	/** Aborts a build between files when it returns true. */
	readonly isCancelled?: () => boolean;
	/** Called whenever the tier drops, with a human-readable reason. */
	readonly onDegrade?: (tier: IndexTier, reason: string) => void;
}

/** Result of the pre-flight tier decision. */
interface TierChoice {
	readonly tier: IndexTier;
	readonly reason?: string;
}

/**
 * Rounds to one decimal place for reasons a user reads.
 * @param value - Any number
 * @returns The number rounded to one decimal
 */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * {@link ProtoIndex} over plain node `fs`.
 *
 * @example
 * ```ts
 * const index = new ProtoIndexImpl({ budget: { maxMemoryMB: 256, maxFiles: 20000 } });
 * const stats = await index.build([workspaceRoot]);
 * index.referencesTo("fhir.r4.core.Patient");
 * index.dispose();
 * ```
 */
export class ProtoIndexImpl implements ProtoIndex {
	private readonly pool = new StringPool();
	private readonly syms = new SymbolStore();
	private readonly refs = new ReferenceStore();
	private readonly registry = new AnnotationRegistryImpl();

	/** Docs are unique per symbol, so they are stored flat rather than interned. */
	private docs: string[] = [];
	private docFree: number[] = [];

	private filePath: string[] = [];
	private filePkgId: number[] = [];
	private fileImportIds: number[][] = [];
	private fileMtime: number[] = [];
	private fileModuleRoot: (string | undefined)[] = [];
	private fileAlive: boolean[] = [];
	private fileFree: number[] = [];
	private readonly fileIdByPath = new Map<string, number>();
	private readonly filesByBase = new Map<string, number[]>();
	private readonly filesByPkg = new Map<number, number[]>();

	private symsByFile: (number[] | undefined)[] = [];
	private refsByFile: (number[] | undefined)[] = [];
	/** fqn string -> symbol row, for message/enum/service/extend only. */
	private readonly declByFqn = new Map<string, number>();
	/** pool id of a resolved fqn -> reference rows. May hold stale rows. */
	private readonly refsByResolved = new Map<number, number[]>();
	/** Reference rows with no resolution. May hold stale rows. */
	private unresolved: number[] = [];

	private importPkgCache = new Map<number, number[]>();
	private filesCache: IndexedFile[] | undefined;
	/** Files that declare an `extend`, the seeds of the annotation closure. */
	private extendFileIds: number[] = [];
	/** Paths already handed to the annotation registry. */
	private readonly annotationPaths = new Set<string>();

	private readonly listeners = new Set<() => void>();
	private readonly budget: IndexBudget;

	private roots: string[] = [];
	private tier: IndexTier = "full";
	private degradeReason: string | undefined;
	private keepMembers = true;
	private keepDocs = true;
	private bytesRead = 0;
	private buildMs = 0;
	private approxHeapMB = 0;
	private heapBase = 0;
	private aborted = false;
	private disposed = false;

	constructor(private readonly options: ProtoIndexOptions = {}) {
		this.budget = options.budget ?? DEFAULT_INDEX_BUDGET;
	}

	/* ---------------------------------------------------------------- *
	 * Build
	 * ---------------------------------------------------------------- */

	/**
	 * Walks the roots, reads every `.proto` once with node `fs`, and builds the
	 * index. Replaces any previous contents.
	 *
	 * @param roots - Absolute directories to index
	 * @returns Counts, timing and the tier actually used
	 */
	async build(roots: readonly string[]): Promise<IndexStats> {
		const started = Date.now();
		this.clearData();
		this.resetTier();
		this.roots = roots.map((root) => path.resolve(root));
		this.heapBase = process.memoryUsage().heapUsed;

		const walk = await walkProtoFiles(this.roots, {
			maxFiles: this.budget.maxFiles + 1,
			isCancelled: this.options.isCancelled,
		});

		const choice = this.chooseTier(walk.files.length, walk.bytes);
		this.applyTier(choice.tier, choice.reason);

		if (this.tier === "onDemand") {
			this.buildMs = Date.now() - started;
			this.approxHeapMB = 0;
			this.fire();
			return this.stats();
		}

		const concurrency = Math.max(1, this.options.concurrency ?? 32);
		const files = walk.files;
		let next = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				const i = next++;
				if (i >= files.length || this.aborted) {
					return;
				}
				if (this.options.isCancelled?.()) {
					this.aborted = true;
					return;
				}
				await this.ingestFile(files[i].path, files[i].mtimeMs);
				if (i % MONITOR_STRIDE === 0) {
					this.checkMemory();
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(concurrency, files.length) }, worker),
		);

		// `aborted` is set only when the ladder bottomed out at `onDemand` and
		// threw the partial index away, or when the caller cancelled.
		if (!this.aborted) {
			this.resolveAll();
			await this.ingestAnnotationClosure(this.extendFileIds);
			await this.scanExternalAnnotationRoots();
		}

		this.importPkgCache.clear();
		this.buildMs = Date.now() - started;
		this.approxHeapMB = round1(
			Math.max(0, process.memoryUsage().heapUsed - this.heapBase) / 1e6,
		);
		this.fire();
		return this.stats();
	}

	/**
	 * Re-parses exactly one file and patches its slice of the index. No full
	 * rebuild: only the file's own references, references that pointed into it,
	 * and — when the edit introduced new types — previously unresolved
	 * references are resolved again.
	 *
	 * @param absolutePath - Path to the changed `.proto`
	 */
	async update(absolutePath: string): Promise<void> {
		if (this.disposed || this.tier === "onDemand") {
			return;
		}
		const abs = path.resolve(absolutePath);
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(abs);
		} catch {
			this.remove(abs);
			return;
		}

		const previous = this.fileIdByPath.get(abs);
		const typesBefore =
			previous === undefined ? [] : this.typeFqnIdsOfFile(previous);
		if (previous !== undefined) {
			this.dropFile(previous);
		}

		await this.ingestFile(abs, stat.mtimeMs);
		this.importPkgCache.clear();

		const fileId = this.fileIdByPath.get(abs);
		const typesAfter =
			fileId === undefined ? [] : this.typeFqnIdsOfFile(fileId);

		if (fileId !== undefined) {
			for (const ri of this.refsByFile[fileId] ?? []) {
				this.setResolved(ri, this.resolveRef(ri));
			}
		}
		for (const fqnId of typesBefore) {
			this.reresolveTargets(fqnId);
		}
		const added = typesAfter.some((id) => !typesBefore.includes(id));
		if (added) {
			this.reresolveUnresolved();
		}
		if (fileId !== undefined && this.extendFileIds.includes(fileId)) {
			await this.ingestAnnotationClosure([fileId]);
		}
		this.fire();
	}

	/**
	 * Drops one file's symbols, references and annotations.
	 * @param absolutePath - Path to the removed `.proto`
	 */
	remove(absolutePath: string): void {
		const abs = path.resolve(absolutePath);
		const fileId = this.fileIdByPath.get(abs);
		if (fileId === undefined) {
			return;
		}
		const types = this.typeFqnIdsOfFile(fileId);
		this.dropFile(fileId);
		this.importPkgCache.clear();
		for (const fqnId of types) {
			this.reresolveTargets(fqnId);
		}
		this.fire();
	}

	/* ---------------------------------------------------------------- *
	 * Queries
	 * ---------------------------------------------------------------- */

	/** @returns Counts, timing, tier and any degrade reason. */
	stats(): IndexStats {
		return {
			tier: this.tier,
			fileCount: this.fileIdByPath.size,
			symbolCount: this.syms.count,
			annotationCount: this.registry.all().length,
			bytesRead: this.bytesRead,
			buildMs: this.buildMs,
			approxHeapMB: this.approxHeapMB,
			degradeReason: this.degradeReason,
		};
	}

	/** @returns Every file in the index. Cached until the next change. */
	files(): readonly IndexedFile[] {
		if (this.filesCache === undefined) {
			const out: IndexedFile[] = [];
			for (const id of this.fileIdByPath.values()) {
				const file = this.toFile(id);
				if (file) {
					out.push(file);
				}
			}
			this.filesCache = out;
		}
		return this.filesCache;
	}

	/**
	 * @param id - File id
	 * @returns The file, or undefined when the id is unknown
	 */
	file(id: number): IndexedFile | undefined {
		return this.toFile(id);
	}

	/**
	 * @param absolutePath - Path to a `.proto`
	 * @returns The file, or undefined when it is not indexed
	 */
	fileByPath(absolutePath: string): IndexedFile | undefined {
		const id = this.fileIdByPath.get(path.resolve(absolutePath));
		return id === undefined ? undefined : this.toFile(id);
	}

	/**
	 * Exact fully-qualified lookup — the basis of safe rename.
	 * @param fqn - Fully-qualified name, e.g. `fhir.r4.core.Patient.Contact`
	 * @returns The declaration, or undefined
	 */
	symbol(fqn: string): IndexedSymbol | undefined {
		const direct = this.declByFqn.get(fqn);
		if (direct !== undefined) {
			return this.toSymbol(direct);
		}
		const dot = fqn.lastIndexOf(".");
		if (dot < 0) {
			return undefined;
		}
		// Members (fields, enum values, rpcs) are not in the fqn map; they are
		// found through their container, which is.
		const containerId = this.pool.lookup(fqn.slice(0, dot));
		const nameId = this.pool.lookup(fqn.slice(dot + 1));
		if (containerId === undefined || nameId === undefined) {
			return undefined;
		}
		const containerIdx = this.declByFqn.get(fqn.slice(0, dot));
		const fileIds =
			containerIdx !== undefined
				? [this.syms.file[containerIdx]]
				: (this.filesByPkg.get(containerId) ?? []);
		for (const fileId of fileIds) {
			for (const i of this.symsByFile[fileId] ?? []) {
				if (
					this.syms.alive[i] === 1 &&
					this.syms.name[i] === nameId &&
					this.syms.container[i] === containerId
				) {
					return this.toSymbol(i);
				}
			}
		}
		return undefined;
	}

	/**
	 * Substring match on the bare name, for Go to Symbol. Exact matches sort
	 * first, then prefix matches, then the shortest containing names.
	 *
	 * @param query - Case-insensitive substring
	 * @param limit - Maximum results. Default 200
	 * @returns Matching declarations
	 */
	searchSymbols(query: string, limit = 200): readonly IndexedSymbol[] {
		const q = query.trim().toLowerCase();
		const scored: { i: number; score: number; length: number }[] = [];
		const high = this.syms.highWater;
		for (let i = 0; i < high; i++) {
			if (this.syms.alive[i] === 0) {
				continue;
			}
			const name = this.pool.lower(this.syms.name[i]);
			let score: number;
			if (q.length === 0) {
				score = 3;
			} else if (name === q) {
				score = 0;
			} else if (name.startsWith(q)) {
				score = 1;
			} else if (name.includes(q)) {
				score = 2;
			} else {
				continue;
			}
			scored.push({ i, score, length: name.length });
			if (scored.length >= SEARCH_CANDIDATE_CAP) {
				break;
			}
		}
		scored.sort((a, b) => a.score - b.score || a.length - b.length);
		return scored.slice(0, limit).map((entry) => this.toSymbol(entry.i));
	}

	/**
	 * @param fileId - File id
	 * @returns Declarations in that file, in source order
	 */
	symbolsInFile(fileId: number): readonly IndexedSymbol[] {
		const rows = this.symsByFile[fileId];
		if (!rows) {
			return [];
		}
		const out: IndexedSymbol[] = [];
		for (const i of rows) {
			if (this.syms.alive[i] === 1) {
				out.push(this.toSymbol(i));
			}
		}
		return out;
	}

	/**
	 * Uses of one fully-qualified type. Never a simple-name match: a reference
	 * whose written name could mean two imported types resolves to neither and
	 * is not returned here for either of them.
	 *
	 * @param fqn - Fully-qualified message or enum name
	 * @returns References that resolve to exactly this type
	 */
	referencesTo(fqn: string): readonly IndexedReference[] {
		const symIdx = this.declByFqn.get(fqn);
		if (symIdx === undefined) {
			return [];
		}
		const fqnId = this.syms.fqn[symIdx];
		const bucket = this.refsByResolved.get(fqnId);
		if (!bucket) {
			return [];
		}
		const out: IndexedReference[] = [];
		const live: number[] = [];
		for (const ri of bucket) {
			if (this.refs.alive[ri] === 1 && this.refs.resolved[ri] === fqnId) {
				live.push(ri);
				out.push(this.toReference(ri, fqn));
			}
		}
		if (live.length !== bucket.length) {
			this.refsByResolved.set(fqnId, live);
		}
		return out;
	}

	/**
	 * The annotation registry, populated from the same single read of each file.
	 * Track F owns the implementation; this index only feeds and exposes it.
	 *
	 * @returns The registry
	 */
	annotations(): AnnotationRegistry {
		return this.registry;
	}

	/**
	 * @param listener - Called after any build, update or removal
	 * @returns A disposable that unregisters the listener
	 */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return {
			dispose: (): void => {
				this.listeners.delete(listener);
			},
		};
	}

	/** Releases every structure. The index is unusable afterwards. */
	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		this.clearData();
		this.pool.clear();
	}

	/* ---------------------------------------------------------------- *
	 * Ingest
	 * ---------------------------------------------------------------- */

	private async ingestFile(
		absolutePath: string,
		mtimeMs: number,
	): Promise<void> {
		let text: string;
		try {
			text = await fs.promises.readFile(absolutePath, "utf8");
		} catch {
			return;
		}
		this.bytesRead += text.length;

		const parsed = parseProtoText(text, {
			keepMembers: this.keepMembers,
			keepDocs: this.keepDocs,
		});
		const fileId = this.addFile(absolutePath, mtimeMs, parsed);
		this.storeParsed(fileId, parsed);

		// Only files that actually declare an `extend` are worth handing to the
		// annotation registry, plus the files those import (their option bodies),
		// which `ingestAnnotationClosure` picks up afterwards. On a workspace with
		// no custom options at all — protobuf-fhir is one — this skips a second
		// full parse of every file and the registry stays empty, as it should.
		const hasExtend = parsed.symbols.some((symbol) => symbol.kind === "extend");
		if (hasExtend) {
			this.extendFileIds.push(fileId);
		}
		if (
			this.options.scanAnnotations !== false &&
			(hasExtend || this.annotationPaths.has(absolutePath))
		) {
			this.ingestAnnotations(fileId, absolutePath, text);
		}
		// `text` goes out of scope here; nothing above retains a slice of it.
	}

	private ingestAnnotations(
		fileId: number,
		absolutePath: string,
		text: string,
	): void {
		this.registry.ingest(
			extractAnnotations(text, {
				fileId,
				importPath: importPathFor(this.roots, absolutePath),
				path: this.filePath[fileId],
			}),
		);
		this.annotationPaths.add(absolutePath);
	}

	/**
	 * Reads the transitive imports of every file that declares an `extend` and
	 * feeds them to the registry, so option *body* messages defined in a
	 * neighbouring file resolve. Nothing else in the workspace is re-read.
	 *
	 * @param seeds - File ids that declare at least one `extend`
	 */
	private async ingestAnnotationClosure(
		seeds: readonly number[],
	): Promise<void> {
		if (this.options.scanAnnotations === false || seeds.length === 0) {
			return;
		}
		const pending = [...seeds];
		const visited = new Set<number>(seeds);
		while (pending.length > 0 && visited.size < ANNOTATION_CLOSURE_CAP) {
			const fileId = pending.pop() as number;
			for (const impId of this.fileImportIds[fileId] ?? []) {
				for (const target of this.fileIdsForImport(this.pool.get(impId))) {
					if (visited.has(target)) {
						continue;
					}
					visited.add(target);
					pending.push(target);
					const abs = this.filePath[target];
					if (this.annotationPaths.has(abs)) {
						continue;
					}
					try {
						const text = await fs.promises.readFile(abs, "utf8");
						this.ingestAnnotations(target, abs, text);
					} catch {
						// Unreadable imports simply contribute nothing.
					}
				}
			}
		}
	}

	private addFile(
		absolutePath: string,
		mtimeMs: number,
		parsed: ParsedFile,
	): number {
		const reused = this.fileFree.pop();
		const id = reused ?? this.filePath.length;
		const pkgId = this.pool.intern(parsed.packageName);
		this.filePath[id] = absolutePath;
		this.filePkgId[id] = pkgId;
		this.fileImportIds[id] = parsed.imports.map((imp) => this.pool.intern(imp));
		this.fileMtime[id] = mtimeMs;
		this.fileModuleRoot[id] = this.options.moduleRootOf?.(absolutePath);
		this.fileAlive[id] = true;
		this.symsByFile[id] = [];
		this.refsByFile[id] = [];
		this.fileIdByPath.set(absolutePath, id);

		const base = path.basename(absolutePath);
		const byBase = this.filesByBase.get(base);
		if (byBase) {
			byBase.push(id);
		} else {
			this.filesByBase.set(base, [id]);
		}
		const byPkg = this.filesByPkg.get(pkgId);
		if (byPkg) {
			byPkg.push(id);
		} else {
			this.filesByPkg.set(pkgId, [id]);
		}
		this.filesCache = undefined;
		return id;
	}

	private storeParsed(fileId: number, parsed: ParsedFile): void {
		const symRows = this.symsByFile[fileId] as number[];
		for (const symbol of parsed.symbols) {
			const containerId = this.pool.intern(symbol.container);
			const nameId = this.pool.intern(symbol.name);
			// Containers get their fqn interned: it is both the parent key for
			// nested declarations and the key references resolve against. Members
			// do not, because their fqns are unique and would double the pool.
			const isContainer =
				symbol.kind === "message" ||
				symbol.kind === "enum" ||
				symbol.kind === "service" ||
				symbol.kind === "extend";
			let fqnId = -1;
			let fqn = "";
			if (isContainer) {
				fqn = symbol.container
					? `${symbol.container}.${symbol.name}`
					: symbol.name;
				fqnId = this.pool.intern(fqn);
			}
			const row = this.syms.add({
				nameId,
				kind: kindId(symbol.kind),
				fileId,
				line: symbol.line,
				startCol: symbol.startCol,
				endCol: symbol.endCol,
				containerId,
				fqnId,
				detailId:
					symbol.detail === undefined ? -1 : this.pool.intern(symbol.detail),
				docId: symbol.doc === undefined ? -1 : this.addDoc(symbol.doc),
			});
			symRows.push(row);
			if (fqnId >= 0) {
				this.declByFqn.set(this.pool.get(fqnId), row);
			}
		}

		const refRows = this.refsByFile[fileId] as number[];
		for (const reference of parsed.references) {
			refRows.push(
				this.refs.add({
					typeId: this.pool.intern(reference.typeName),
					scopeId: this.pool.intern(reference.scope),
					fileId,
					line: reference.line,
					startCol: reference.startCol,
					endCol: reference.endCol,
				}),
			);
		}
	}

	private addDoc(doc: string): number {
		const reused = this.docFree.pop();
		if (reused !== undefined) {
			this.docs[reused] = doc;
			return reused;
		}
		this.docs.push(doc);
		return this.docs.length - 1;
	}

	private dropFile(fileId: number): void {
		for (const i of this.symsByFile[fileId] ?? []) {
			const fqnId = this.syms.fqn[i];
			if (fqnId >= 0) {
				const fqn = this.pool.get(fqnId);
				if (this.declByFqn.get(fqn) === i) {
					this.declByFqn.delete(fqn);
				}
			}
			const docId = this.syms.doc[i];
			if (docId >= 0) {
				this.docs[docId] = "";
				this.docFree.push(docId);
			}
			this.syms.free(i);
		}
		for (const ri of this.refsByFile[fileId] ?? []) {
			this.refs.free(ri);
		}
		this.symsByFile[fileId] = undefined;
		this.refsByFile[fileId] = undefined;

		const abs = this.filePath[fileId];
		this.fileIdByPath.delete(abs);
		const base = path.basename(abs);
		const byBase = this.filesByBase.get(base);
		if (byBase) {
			const at = byBase.indexOf(fileId);
			if (at >= 0) {
				byBase.splice(at, 1);
			}
		}
		const byPkg = this.filesByPkg.get(this.filePkgId[fileId]);
		if (byPkg) {
			const at = byPkg.indexOf(fileId);
			if (at >= 0) {
				byPkg.splice(at, 1);
			}
		}
		this.registry.removeFile(fileId);
		const seed = this.extendFileIds.indexOf(fileId);
		if (seed >= 0) {
			this.extendFileIds.splice(seed, 1);
		}
		this.fileAlive[fileId] = false;
		this.filePath[fileId] = "";
		this.fileImportIds[fileId] = [];
		this.fileModuleRoot[fileId] = undefined;
		this.fileFree.push(fileId);
		this.filesCache = undefined;
	}

	/* ---------------------------------------------------------------- *
	 * Resolution
	 * ---------------------------------------------------------------- */

	private resolveAll(): void {
		const high = this.refs.highWater;
		for (let ri = 0; ri < high; ri++) {
			if (this.refs.alive[ri] === 1) {
				this.setResolved(ri, this.resolveRef(ri));
			}
		}
	}

	private setResolved(ri: number, fqnId: number): void {
		this.refs.resolved[ri] = fqnId;
		if (fqnId < 0) {
			this.unresolved.push(ri);
			return;
		}
		const bucket = this.refsByResolved.get(fqnId);
		if (bucket) {
			bucket.push(ri);
		} else {
			this.refsByResolved.set(fqnId, [ri]);
		}
	}

	/**
	 * Protobuf name resolution, narrowed so it never guesses: exact fqn, then
	 * the enclosing scopes down to (and including) the file's own package, then
	 * the packages of the file's imports. Two importable candidates mean the
	 * reference is ambiguous and stays unresolved.
	 */
	private resolveRef(ri: number): number {
		const written = this.pool.get(this.refs.type[ri]);
		if (written.length === 0) {
			return -1;
		}
		if (written.charCodeAt(0) === 46 /* . */) {
			return this.typeFqnId(written.slice(1));
		}

		const exact = this.typeFqnId(written);
		if (exact >= 0) {
			return exact;
		}

		const fileId = this.refs.file[ri];
		const pkg = this.pool.get(this.filePkgId[fileId]);
		let scope = this.pool.get(this.refs.scope[ri]);
		while (scope.length >= pkg.length && scope.length > 0) {
			const candidate = this.typeFqnId(`${scope}.${written}`);
			if (candidate >= 0) {
				return candidate;
			}
			const dot = scope.lastIndexOf(".");
			if (dot < 0) {
				break;
			}
			scope = scope.slice(0, dot);
		}

		let found = -1;
		for (const pkgId of this.packagesForImports(fileId)) {
			const importPkg = this.pool.get(pkgId);
			const candidate = this.typeFqnId(
				importPkg ? `${importPkg}.${written}` : written,
			);
			if (candidate < 0) {
				continue;
			}
			if (found >= 0 && found !== candidate) {
				// Ambiguous across imports: refuse to guess.
				return -1;
			}
			found = candidate;
		}
		return found;
	}

	private typeFqnId(fqn: string): number {
		const symIdx = this.declByFqn.get(fqn);
		if (symIdx === undefined) {
			return -1;
		}
		const kind = this.syms.kind[symIdx];
		if (kind !== KIND_MESSAGE && kind !== KIND_ENUM) {
			return -1;
		}
		return this.syms.fqn[symIdx];
	}

	private packagesForImports(fileId: number): number[] {
		const cached = this.importPkgCache.get(fileId);
		if (cached) {
			return cached;
		}
		const out: number[] = [];
		for (const impId of this.fileImportIds[fileId] ?? []) {
			for (const candidate of this.fileIdsForImport(this.pool.get(impId))) {
				const pkgId = this.filePkgId[candidate];
				if (!out.includes(pkgId)) {
					out.push(pkgId);
				}
			}
		}
		this.importPkgCache.set(fileId, out);
		return out;
	}

	/**
	 * Maps an import path as written to the indexed files it can name. Matching
	 * is by path suffix, which is what a proto import path is: a path relative
	 * to some import root.
	 *
	 * @param importPath - e.g. `google/api/field_behavior.proto`
	 * @returns File ids whose absolute path ends with that import path
	 */
	private fileIdsForImport(importPath: string): number[] {
		const slash = importPath.lastIndexOf("/");
		const base = slash < 0 ? importPath : importPath.slice(slash + 1);
		const candidates = this.filesByBase.get(base);
		if (!candidates) {
			return [];
		}
		const suffix = path.sep + importPath.split("/").join(path.sep);
		const out: number[] = [];
		for (const candidate of candidates) {
			if (this.filePath[candidate].endsWith(suffix)) {
				out.push(candidate);
			}
		}
		return out;
	}

	private typeFqnIdsOfFile(fileId: number): number[] {
		const out: number[] = [];
		for (const i of this.symsByFile[fileId] ?? []) {
			const fqnId = this.syms.fqn[i];
			const kind = this.syms.kind[i];
			if (fqnId >= 0 && (kind === KIND_MESSAGE || kind === KIND_ENUM)) {
				out.push(fqnId);
			}
		}
		return out;
	}

	private reresolveTargets(fqnId: number): void {
		const bucket = this.refsByResolved.get(fqnId);
		if (!bucket) {
			return;
		}
		this.refsByResolved.set(fqnId, []);
		for (const ri of bucket) {
			if (this.refs.alive[ri] === 1 && this.refs.resolved[ri] === fqnId) {
				this.setResolved(ri, this.resolveRef(ri));
			}
		}
	}

	private reresolveUnresolved(): void {
		const pending = this.unresolved;
		this.unresolved = [];
		for (const ri of pending) {
			if (this.refs.alive[ri] === 1 && this.refs.resolved[ri] === -1) {
				this.setResolved(ri, this.resolveRef(ri));
			}
		}
	}

	/* ---------------------------------------------------------------- *
	 * Memory ladder
	 * ---------------------------------------------------------------- */

	private chooseTier(fileCount: number, bytes: number): TierChoice {
		if (fileCount > this.budget.maxFiles) {
			return {
				tier: "onDemand",
				reason:
					`${fileCount} .proto files exceeds the ${this.budget.maxFiles}-file index limit; ` +
					"workspace indexing is off and per-file features only are available",
			};
		}
		const textMB = round1(bytes / 1e6);
		const estFull = (bytes * FULL_TIER_FACTOR) / 1e6 + fileCount * PER_FILE_MB;
		if (estFull <= this.budget.maxMemoryMB) {
			return { tier: "full" };
		}
		const estReduced =
			(bytes * REDUCED_TIER_FACTOR) / 1e6 + fileCount * PER_FILE_MB;
		if (estReduced <= this.budget.maxMemoryMB) {
			return {
				tier: "reduced",
				reason:
					`a full index of ${textMB} MB of proto in ${fileCount} files is estimated at ` +
					`${round1(estFull)} MB, above the ${this.budget.maxMemoryMB} MB limit; ` +
					"indexing declarations only, without fields, enum values or doc comments",
			};
		}
		return {
			tier: "onDemand",
			reason:
				`even a reduced index of ${textMB} MB of proto in ${fileCount} files is estimated at ` +
				`${round1(estReduced)} MB, above the ${this.budget.maxMemoryMB} MB limit; ` +
				"workspace indexing is off",
		};
	}

	/** Returns the ladder to its top rung before a fresh build. */
	private resetTier(): void {
		this.tier = "full";
		this.degradeReason = undefined;
		this.keepMembers = true;
		this.keepDocs = true;
	}

	private applyTier(tier: IndexTier, reason?: string): void {
		const changed = tier !== this.tier;
		this.tier = tier;
		this.keepMembers = tier === "full";
		this.keepDocs = tier === "full";
		if (reason) {
			this.degradeReason = reason;
			if (changed || this.options.onDegrade) {
				this.options.onDegrade?.(tier, reason);
			}
		}
	}

	/** Re-checks real heap use mid-build and drops a rung when it is exceeded. */
	private checkMemory(): void {
		const usedMB =
			Math.max(0, process.memoryUsage().heapUsed - this.heapBase) / 1e6;
		if (usedMB <= this.budget.maxMemoryMB) {
			return;
		}
		if (this.tier === "full") {
			this.applyTier(
				"reduced",
				`index reached ${round1(usedMB)} MB while building, above the ` +
					`${this.budget.maxMemoryMB} MB limit; dropped fields, enum values and doc ` +
					"comments and continued with declarations only",
			);
			this.purgeMembersAndDocs();
			return;
		}
		if (usedMB > this.budget.maxMemoryMB * 1.5) {
			this.applyTier(
				"onDemand",
				`index reached ${round1(usedMB)} MB, more than 1.5x the ` +
					`${this.budget.maxMemoryMB} MB limit, even after degrading; workspace ` +
					"indexing has been abandoned for this session",
			);
			this.aborted = true;
			this.clearData();
		}
	}

	/** Reclaims what the `full` tier had already stored when it degrades. */
	private purgeMembersAndDocs(): void {
		const memberKinds = new Set([
			kindId("field"),
			kindId("enumValue"),
			kindId("rpc"),
		]);
		const high = this.syms.highWater;
		for (let i = 0; i < high; i++) {
			if (this.syms.alive[i] === 0) {
				continue;
			}
			const docId = this.syms.doc[i];
			if (docId >= 0) {
				this.docs[docId] = "";
				this.docFree.push(docId);
				this.syms.doc[i] = -1;
			}
			if (memberKinds.has(this.syms.kind[i])) {
				const fileId = this.syms.file[i];
				const rows = this.symsByFile[fileId];
				if (rows) {
					const at = rows.indexOf(i);
					if (at >= 0) {
						rows.splice(at, 1);
					}
				}
				this.syms.free(i);
			}
		}
		this.filesCache = undefined;
	}

	/* ---------------------------------------------------------------- *
	 * Helpers
	 * ---------------------------------------------------------------- */

	private async scanExternalAnnotationRoots(): Promise<void> {
		const extra = this.options.annotationRoots;
		if (
			this.options.scanAnnotations === false ||
			!extra ||
			extra.length === 0
		) {
			return;
		}
		await scanRootsInto(extra, this.registry, {
			startFileId: EXTERNAL_FILE_ID_BASE,
			isCancelled: this.options.isCancelled,
		});
	}

	private toFile(id: number): IndexedFile | undefined {
		if (id < 0 || id >= this.filePath.length || !this.fileAlive[id]) {
			return undefined;
		}
		return {
			id,
			path: this.filePath[id],
			packageName: this.pool.get(this.filePkgId[id]),
			imports: this.fileImportIds[id].map((impId) => this.pool.get(impId)),
			moduleRoot: this.fileModuleRoot[id],
			mtimeMs: this.fileMtime[id],
		};
	}

	private toSymbol(i: number): IndexedSymbol {
		const containerId = this.syms.container[i];
		const container = this.pool.get(containerId);
		const name = this.pool.get(this.syms.name[i]);
		const fqnId = this.syms.fqn[i];
		const fqn =
			fqnId >= 0
				? this.pool.get(fqnId)
				: container
					? `${container}.${name}`
					: name;
		const fileId = this.syms.file[i];
		const detailId = this.syms.detail[i];
		const docId = this.syms.doc[i];
		const doc = docId >= 0 ? this.docs[docId] : "";
		return {
			fqn,
			name,
			kind: SYMBOL_KINDS[this.syms.kind[i]],
			fileId,
			line: this.syms.line[i],
			startCol: this.syms.startCol[i],
			endCol: this.syms.endCol[i],
			parentFqn: containerId === this.filePkgId[fileId] ? undefined : container,
			detail: detailId >= 0 ? this.pool.get(detailId) : undefined,
			doc: doc.length > 0 ? doc : undefined,
		};
	}

	private toReference(ri: number, resolvedFqn: string): IndexedReference {
		return {
			typeName: this.pool.get(this.refs.type[ri]),
			resolvedFqn,
			fileId: this.refs.file[ri],
			line: this.refs.line[ri],
			startCol: this.refs.startCol[ri],
			endCol: this.refs.endCol[ri],
		};
	}

	private fire(): void {
		this.filesCache = undefined;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private clearData(): void {
		this.syms.clear();
		this.refs.clear();
		this.registry.clear();
		this.docs = [];
		this.docFree = [];
		this.filePath = [];
		this.filePkgId = [];
		this.fileImportIds = [];
		this.fileMtime = [];
		this.fileModuleRoot = [];
		this.fileAlive = [];
		this.fileFree = [];
		this.fileIdByPath.clear();
		this.filesByBase.clear();
		this.filesByPkg.clear();
		this.symsByFile = [];
		this.refsByFile = [];
		this.declByFqn.clear();
		this.refsByResolved.clear();
		this.unresolved = [];
		this.importPkgCache = new Map();
		this.filesCache = undefined;
		this.extendFileIds = [];
		this.annotationPaths.clear();
		this.bytesRead = 0;
		this.aborted = false;
	}
}

/**
 * Creates a proto index.
 *
 * @param options - Budget and wiring; every field has a safe default
 * @returns An index that has not been built yet
 */
export function createProtoIndex(options: ProtoIndexOptions = {}): ProtoIndex {
	return new ProtoIndexImpl(options);
}
