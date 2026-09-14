/**
 * Assembles the {@link DependencyModel} the Dependencies view and the Registry
 * panel render.
 *
 * Everything about *which* modules exist and where their dependencies are
 * unpacked already comes from the buf module graph; this file adds only what
 * the graph has no reason to know: how many protos a cached module actually
 * contains, which cached modules nothing declares, and which `buf.gen.yaml`
 * templates sit beside each module.
 *
 * Two constraints shape the implementation:
 *
 *   1. Counting is done with `node:fs/promises` and nothing else. Opening a
 *      `vscode.TextDocument` per proto is what grew this extension's host to
 *      ~60 GB on a large workspace, and a dependency like `googleapis` is
 *      ~1,500 files on its own. The count only needs directory entries, so it
 *      never reads a byte of file content.
 *   2. Every walk is bounded and cancellable. The buf cache is shared across
 *      every repository on the machine, so its size is unrelated to the size of
 *      the workspace that is open.
 */

import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { BufDependency, ModuleGraph } from "../index/types";
import type {
	BufDep,
	DependencyModel,
	GenConfig,
	ModuleDeps,
} from "../shared/protocol";
import { getBufModuleCacheRoot, getModuleGraph } from "../utils/moduleGraph";
import { findGenConfigs } from "./bufGen";

/** Directories listed concurrently while counting or scanning. */
const READDIR_CONCURRENCY = 16;

/** Depth limit for a proto count, measured from the `files/` directory. */
const MAX_COUNT_DEPTH = 24;

/** Ceiling on protos counted in one module. Larger reports stop here. */
const MAX_COUNT_FILES = 50_000;

/** Ceiling on modules returned by one cache scan. */
const MAX_CACHED_MODULES = 1024;

/** Levels walked upward from a module root looking for its `buf.yaml`. */
const MAX_YAML_WALK = 8;

/** A sink for diagnostics; the extension's output channel satisfies it. */
interface Logger {
	appendLine(message: string): void;
}

/**
 * Proto counts keyed by absolute cache path.
 *
 * A cache path embeds a commit, so its contents are immutable by construction
 * and a count taken once stays correct for the life of the process. Only
 * non-zero counts are memoised: a zero means the directory was empty or
 * unreadable, which is exactly the state `buf dep update` changes underneath
 * us.
 */
const protoCounts = new Map<string, number>();

/**
 * Drops memoised proto counts. Only needed if a cache directory is rewritten
 * in place, which buf does not do; kept so a test or a manual refresh can start
 * from a clean slate.
 */
export function invalidateDepCaches(): void {
	protoCounts.clear();
}

/* ------------------------------------------------------------------ *
 * Module references
 * ------------------------------------------------------------------ */

/** A module reference split into its registry parts. */
export interface ModuleRef {
	/** Registry host, e.g. `buf.build`. Empty when the ref omits one. */
	readonly remote: string;
	readonly owner: string;
	/** Module name alone, e.g. `googleapis`. */
	readonly module: string;
}

/**
 * Splits `buf.build/googleapis/googleapis` into its parts.
 *
 * Degrades rather than rejecting short references: a `buf.yaml` under edit can
 * hold `buf.build/googleapis` for as long as it takes to type the rest, and the
 * view still has to render a row for it.
 *
 * @param name - Reference as written in `buf.yaml` or `buf.lock`
 * @returns Remote, owner and module, with missing leading parts left empty
 */
export function splitModuleRef(name: string): ModuleRef {
	const parts = name.split("/").filter((part) => part.length > 0);
	if (parts.length >= 3) {
		return { remote: parts[0], owner: parts[1], module: parts[2] };
	}
	if (parts.length === 2) {
		return { remote: "", owner: parts[0], module: parts[1] };
	}
	return { remote: "", owner: "", module: parts[0] ?? name };
}

/* ------------------------------------------------------------------ *
 * Proto counting
 * ------------------------------------------------------------------ */

/** Bounds and cancellation for {@link countProtoFiles}. */
export interface CountOptions {
	/** Directory levels below the root to descend. Defaults to 24. */
	readonly maxDepth?: number;
	/** Stop once this many `.proto` files have been seen. Defaults to 50,000. */
	readonly maxFiles?: number;
	/** Aborts between directory batches when it returns true. */
	readonly isCancelled?: () => boolean;
}

/**
 * Counts `.proto` files under a directory.
 *
 * Breadth-first with several `readdir` calls in flight, mirroring the index
 * walk: the cost here is per-directory latency, not per-entry work, so the only
 * useful lever is overlapping the listings.
 *
 * @param dir - Absolute directory, normally a `…/<commit>/files`
 * @param options - Depth, file ceiling and cancellation
 * @returns Number of `.proto` files found, or 0 when the directory is unreadable
 */
export async function countProtoFiles(
	dir: string,
	options: CountOptions = {},
): Promise<number> {
	const maxDepth = options.maxDepth ?? MAX_COUNT_DEPTH;
	const maxFiles = options.maxFiles ?? MAX_COUNT_FILES;
	let count = 0;
	let queue: string[] = [path.resolve(dir)];

	for (let depth = 0; depth <= maxDepth && queue.length > 0; depth++) {
		const next: string[] = [];
		for (let i = 0; i < queue.length; i += READDIR_CONCURRENCY) {
			if (options.isCancelled?.() || count >= maxFiles) {
				return count;
			}
			const listings = await Promise.all(
				queue.slice(i, i + READDIR_CONCURRENCY).map(readDirSafe),
			);
			for (const { parent, entries } of listings) {
				for (const entry of entries) {
					if (entry.isDirectory()) {
						next.push(path.join(parent, entry.name));
					} else if (entry.isFile() && entry.name.endsWith(".proto")) {
						count++;
						if (count >= maxFiles) {
							return count;
						}
					}
				}
			}
		}
		queue = next;
	}
	return count;
}

/** `readdir` that reports an unreadable directory as an empty one. */
async function readDirSafe(
	parent: string,
): Promise<{ parent: string; entries: Dirent[] }> {
	try {
		return {
			parent,
			entries: await fsp.readdir(parent, { withFileTypes: true }),
		};
	} catch {
		return { parent, entries: [] };
	}
}

/** Memoised {@link countProtoFiles}; see {@link protoCounts} for the rules. */
async function countCached(
	dir: string,
	options: CountOptions,
): Promise<number> {
	const hit = protoCounts.get(dir);
	if (hit !== undefined) {
		return hit;
	}
	const count = await countProtoFiles(dir, options);
	if (count > 0) {
		protoCounts.set(dir, count);
	}
	return count;
}

/* ------------------------------------------------------------------ *
 * Module cache scan
 * ------------------------------------------------------------------ */

/** One unpacked module found in the buf module cache. */
export interface CachedModule {
	/** Full reference rebuilt from the directory layout. */
	readonly name: string;
	readonly commit: string;
	/** The `…/<commit>/files` directory. */
	readonly cachePath: string;
}

/** Bounds and cancellation for {@link scanModuleCache}. */
export interface CacheScanOptions {
	/** Ceiling on modules returned. Defaults to 1,024. */
	readonly maxModules?: number;
	readonly isCancelled?: () => boolean;
}

/** Subdirectories of `dir`, or none when it cannot be listed. */
async function subdirectories(dir: string): Promise<string[]> {
	const { entries } = await readDirSafe(dir);
	return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
}

/**
 * Lists every module unpacked in the buf module cache.
 *
 * The layout is `<cacheRoot>/<remote>/<owner>/<module>/<commit>/files`, so this
 * is four levels of `readdir` and no file reads. A module usually has several
 * commits cached; the most recently written one wins, which is the same rule
 * the module graph uses when a `buf.lock` pins a commit that was garbage
 * collected.
 *
 * @param cacheRoot - Root from `getBufModuleCacheRoot()`
 * @param options - Bounds and cancellation
 * @returns One entry per cached module, ordered by name
 */
export async function scanModuleCache(
	cacheRoot: string,
	options: CacheScanOptions = {},
): Promise<CachedModule[]> {
	const limit = options.maxModules ?? MAX_CACHED_MODULES;
	const found: CachedModule[] = [];

	for (const remote of await subdirectories(cacheRoot)) {
		if (options.isCancelled?.() || found.length >= limit) {
			break;
		}
		const remoteDir = path.join(cacheRoot, remote);
		for (const owner of await subdirectories(remoteDir)) {
			if (options.isCancelled?.() || found.length >= limit) {
				break;
			}
			const ownerDir = path.join(remoteDir, owner);
			const modules = await subdirectories(ownerDir);
			const resolved = await Promise.all(
				modules.map(async (module) => {
					const moduleDir = path.join(ownerDir, module);
					const newest = await newestUnpackedCommit(moduleDir);
					return newest
						? {
								name: `${remote}/${owner}/${module}`,
								commit: newest.commit,
								cachePath: newest.files,
							}
						: undefined;
				}),
			);
			for (const entry of resolved) {
				if (entry && found.length < limit) {
					found.push(entry);
				}
			}
		}
	}

	found.sort((a, b) => a.name.localeCompare(b.name));
	return found;
}

/** The most recently written `<commit>/files` under a module directory. */
async function newestUnpackedCommit(
	moduleDir: string,
): Promise<{ commit: string; files: string } | undefined> {
	const commits = await subdirectories(moduleDir);
	let best: { commit: string; files: string; mtimeMs: number } | undefined;
	for (const commit of commits) {
		const files = path.join(moduleDir, commit, "files");
		try {
			const stat = await fsp.stat(files);
			if (!stat.isDirectory()) {
				continue;
			}
			if (!best || stat.mtimeMs > best.mtimeMs) {
				best = { commit, files, mtimeMs: stat.mtimeMs };
			}
		} catch {
			// Downloaded but not unpacked; nothing to point a proto path at.
		}
	}
	return best ? { commit: best.commit, files: best.files } : undefined;
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

/** Inputs for {@link buildDependencyModel}. */
export interface DependencyModelOptions {
	/**
	 * Graph to read modules from. Omitted, the shared workspace graph is used;
	 * a caller already holding one (or a test with a hand-built one) passes it to
	 * avoid a second discovery pass.
	 */
	readonly graph?: ModuleGraph;
	/** Buf module cache root. Defaults to `getBufModuleCacheRoot()`. */
	readonly cacheRoot?: string;
	/**
	 * Extra directories to look for `buf.gen.yaml` in, beyond the module roots.
	 *
	 * A template does not have to live next to a `buf.yaml`: repositories
	 * routinely keep one at the root while the modules sit under `proto/`, and
	 * looking only where a module was found misses every one of them. The host
	 * passes the whole workspace here; a test passes nothing.
	 */
	readonly extraGenDirs?: readonly string[];
	/** Aborts between filesystem batches when it returns true. */
	readonly isCancelled?: () => boolean;
	readonly log?: Logger;
}

/** The `buf.yaml` governing a module root, searched at or above it. */
async function findDeclaringYaml(root: string): Promise<string | undefined> {
	let current = path.resolve(root);
	for (let level = 0; level < MAX_YAML_WALK; level++) {
		const candidate = path.join(current, "buf.yaml");
		try {
			if ((await fsp.stat(candidate)).isFile()) {
				return candidate;
			}
		} catch {
			// keep walking
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
	return undefined;
}

/** One `BufDependency` from the graph, widened into the wire shape. */
async function toBufDep(
	dep: BufDependency,
	declaredIn: string | undefined,
	options: DependencyModelOptions,
): Promise<BufDep> {
	const ref = splitModuleRef(dep.name);
	const cachePath = dep.cachePath;
	return {
		name: dep.name,
		remote: ref.remote,
		owner: ref.owner,
		module: ref.module,
		commit: dep.commit,
		cachePath,
		protoCount: cachePath
			? await countCached(cachePath, { isCancelled: options.isCancelled })
			: undefined,
		declaredIn,
		// A declared dependency with no unpacked directory has not been fetched;
		// that is the state `buf dep update` exists to fix, and the view says so
		// rather than silently showing an empty module.
		state: cachePath ? "declared" : "missing",
	};
}

/**
 * Builds the whole dependency model.
 *
 * Modules are keyed by the directory of the `buf.yaml` that declares them, not
 * by module root: a v2 manifest can declare several module roots but carries a
 * single `deps:` list, so one row per manifest is what the dependency story
 * actually has to tell. The module root is used as the key only when no
 * `buf.yaml` can be found above it.
 *
 * Never rejects. A failure anywhere is reported as
 * {@link DependencyModel.error} on an otherwise empty model, because a panel
 * that renders nothing is strictly worse than one that says why.
 *
 * @param options - Graph, cache root, cancellation and logging
 * @returns The model, with `updatesChecked` false until `checkUpdates` runs
 */
export async function buildDependencyModel(
	options: DependencyModelOptions = {},
): Promise<DependencyModel> {
	try {
		const graph = options.graph ?? (await getModuleGraph(options.log));
		const cacheRoot = options.cacheRoot ?? getBufModuleCacheRoot();

		/** Manifest directory → the row being assembled for it. */
		const byRoot = new Map<
			string,
			{ root: string; name?: string; deps: BufDep[]; seen: Set<string> }
		>();
		/** Directories to look for `buf.gen.yaml` in. */
		const genDirs: string[] = [];
		/** Every declared reference, so the cache scan can subtract them. */
		const declaredNames = new Set<string>();

		for (const module of graph.modules()) {
			if (options.isCancelled?.()) {
				break;
			}
			const declaringYaml = await findDeclaringYaml(module.root);
			const root = declaringYaml ? path.dirname(declaringYaml) : module.root;
			genDirs.push(module.root, root);

			let row = byRoot.get(root);
			if (!row) {
				row = { root, name: module.name, deps: [], seen: new Set() };
				byRoot.set(root, row);
			} else if (!row.name && module.name) {
				row.name = module.name;
			}

			for (const dep of module.deps) {
				if (row.seen.has(dep.name)) {
					continue;
				}
				row.seen.add(dep.name);
				declaredNames.add(dep.name);
				row.deps.push(await toBufDep(dep, declaringYaml, options));
			}
		}

		const modules: ModuleDeps[] = [...byRoot.values()]
			.map((row) => ({ root: row.root, name: row.name, deps: row.deps }))
			.sort((a, b) => a.root.localeCompare(b.root));

		const undeclared = await collectUndeclared(
			cacheRoot,
			declaredNames,
			options,
		);
		const gen: GenConfig[] = await findGenConfigs(
			[...genDirs, ...(options.extraGenDirs ?? [])],
			{
				isCancelled: options.isCancelled,
				log: options.log,
			},
		);

		options.log?.appendLine(
			`[deps] ${modules.length} module(s), ${undeclared.length} undeclared cached module(s), ${gen.length} buf.gen.yaml`,
		);
		return { modules, gen, undeclared, updatesChecked: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.log?.appendLine(`[deps] model build failed: ${message}`);
		return {
			modules: [],
			gen: [],
			undeclared: [],
			updatesChecked: false,
			error: message,
		};
	}
}

/** Cached modules nothing in the workspace declares. */
async function collectUndeclared(
	cacheRoot: string,
	declaredNames: ReadonlySet<string>,
	options: DependencyModelOptions,
): Promise<BufDep[]> {
	const cached = await scanModuleCache(cacheRoot, {
		isCancelled: options.isCancelled,
	});
	const out: BufDep[] = [];
	for (const entry of cached) {
		if (declaredNames.has(entry.name)) {
			continue;
		}
		if (options.isCancelled?.()) {
			break;
		}
		const ref = splitModuleRef(entry.name);
		out.push({
			name: entry.name,
			remote: ref.remote,
			owner: ref.owner,
			module: ref.module,
			commit: entry.commit,
			cachePath: entry.cachePath,
			protoCount: await countCached(entry.cachePath, {
				isCancelled: options.isCancelled,
			}),
			state: "cached",
		});
	}
	return out;
}
