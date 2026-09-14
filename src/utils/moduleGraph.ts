import * as cp from "node:child_process";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";
import type { BufDependency, ModuleGraph, ProtoModule } from "../index/types";

/**
 * Module graph for buf workspaces.
 *
 * Replaces the old single-`buf.yaml` + `buf export` scheme. Two rules drive the
 * design:
 *
 *   1. Nothing blocks the event loop. Every filesystem call is `fs/promises`,
 *      and the only subprocess (a best-effort cache warm) is fire-and-forget.
 *   2. Dependencies are resolved by reading `buf.lock` and pointing at the
 *      already-unpacked buf module cache. `buf export` compiles the module, so
 *      it fails exactly when a linter is most useful; the cache does not.
 */

/** Directory layout inside the buf cache for b5-digest modules. */
const MODULE_CACHE_SEGMENT = path.join("v3", "modules", "b5");

/** Glob for every buf module/workspace manifest in the workspace. */
const CONFIG_GLOB = "**/{buf.yaml,buf.work.yaml}";

/** Directories that never contain a module we care about. */
const CONFIG_EXCLUDE = "**/{node_modules,.git,out,dist,build,.vscode-test}/**";

/** Upper bound on discovered manifests; far above any real repository. */
const MAX_CONFIGS = 512;

/** Re-discovery is skipped entirely inside this window. */
const FAST_TTL_MS = 15 * 1000;

/** Levels walked upward when looking for a governing `.api-linter.yaml`. */
const MAX_CONFIG_WALK = 12;

interface Logger {
	appendLine(message: string): void;
}

/** A manifest the graph was built from, with the mtime it had at build time. */
export interface ConfigStamp {
	readonly path: string;
	readonly mtimeMs: number;
}

/** `ModuleGraph` plus the whole-workspace helpers the legacy API needs. */
export interface BufModuleGraph extends ModuleGraph {
	/** Every root and dependency cache path across every module, deduped. */
	allProtoPaths(): readonly string[];
	/** Manifests this graph was built from. Used for cache invalidation. */
	configStamps(): readonly ConfigStamp[];
	/** The outermost `buf.yaml`, preferring a workspace-folder root. */
	primaryConfig(): string | undefined;
}

/* ------------------------------------------------------------------ *
 * Buf module cache
 * ------------------------------------------------------------------ */

/**
 * Absolute path of the buf module cache for b5 digests, e.g.
 * `~/.cache/buf/v3/modules/b5`. Honours `BUF_CACHE_DIR` and `XDG_CACHE_HOME`.
 */
export function getBufModuleCacheRoot(): string {
	const explicit = process.env.BUF_CACHE_DIR;
	if (explicit) {
		return path.join(explicit, MODULE_CACHE_SEGMENT);
	}
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		if (local) {
			return path.join(local, "buf", "cache", MODULE_CACHE_SEGMENT);
		}
	}
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg
		? path.join(xdg, "buf")
		: path.join(os.homedir(), ".cache", "buf");
	return path.join(base, MODULE_CACHE_SEGMENT);
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await fsp.stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/** One `deps:` entry from a `buf.lock`, before cache resolution. */
interface LockedDep {
	name: string;
	commit: string;
}

/**
 * Parse `buf.lock` in `dir`. Understands both the v2 shape
 * (`{name, commit, digest}`) and the v1 shape (`{remote, owner, repository}`).
 */
async function readBufLock(dir: string): Promise<LockedDep[]> {
	let text: string;
	try {
		text = await fsp.readFile(path.join(dir, "buf.lock"), "utf8");
	} catch {
		return [];
	}
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch {
		return [];
	}
	const deps = (doc as { deps?: unknown } | null)?.deps;
	if (!Array.isArray(deps)) {
		return [];
	}
	const out: LockedDep[] = [];
	for (const raw of deps) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const entry = raw as Record<string, unknown>;
		let name: string | undefined;
		if (typeof entry.name === "string") {
			name = entry.name;
		} else if (
			typeof entry.remote === "string" &&
			typeof entry.owner === "string" &&
			typeof entry.repository === "string"
		) {
			name = `${entry.remote}/${entry.owner}/${entry.repository}`;
		}
		if (!name) {
			continue;
		}
		out.push({
			name,
			commit: typeof entry.commit === "string" ? entry.commit : "",
		});
	}
	return out;
}

/**
 * Map one locked dependency onto its unpacked cache directory:
 * `<cacheRoot>/<name>/<commit>/files`. When that exact commit is not present,
 * fall back to the most recently written commit for the same module so a stale
 * lock still resolves imports. Returns the dep without `cachePath` when the
 * module is not cached at all.
 */
async function resolveDependency(
	dep: LockedDep,
	cacheRoot: string,
): Promise<BufDependency> {
	const moduleDir = path.join(cacheRoot, ...dep.name.split("/"));
	if (dep.commit) {
		const exact = path.join(moduleDir, dep.commit, "files");
		if (await isDirectory(exact)) {
			return { name: dep.name, commit: dep.commit, cachePath: exact };
		}
	}
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(moduleDir, { withFileTypes: true });
	} catch {
		return { name: dep.name, commit: dep.commit };
	}
	let best: { commit: string; mtimeMs: number; files: string } | undefined;
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const files = path.join(moduleDir, entry.name, "files");
		try {
			const stat = await fsp.stat(files);
			if (!stat.isDirectory()) {
				continue;
			}
			if (!best || stat.mtimeMs > best.mtimeMs) {
				best = { commit: entry.name, mtimeMs: stat.mtimeMs, files };
			}
		} catch {
			// not unpacked; skip
		}
	}
	if (best) {
		return {
			name: dep.name,
			commit: dep.commit || best.commit,
			cachePath: best.files,
		};
	}
	return { name: dep.name, commit: dep.commit };
}

/* ------------------------------------------------------------------ *
 * Best-effort cache warm (never awaited)
 * ------------------------------------------------------------------ */

const warmedDirs = new Set<string>();

/**
 * Run a buf command detached from the request that triggered it. Nothing ever
 * awaits the result: a missing `buf`, a slow network, or a module that does not
 * compile must never stall the extension host.
 */
function spawnDetached(
	command: string,
	args: readonly string[],
	cwd: string,
	log?: Logger,
): void {
	let child: cp.ChildProcess;
	try {
		child = cp.spawn(command, [...args], {
			cwd,
			timeout: 120_000,
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (error) {
		log?.appendLine(
			`[buf] ${command} ${args.join(" ")} could not start: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return;
	}
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		if (stderr.length < 4096) {
			stderr += chunk.toString("utf8");
		}
	});
	child.on("error", (error) => {
		log?.appendLine(
			`[buf] ${command} ${args.join(" ")} failed: ${error.message}`,
		);
	});
	child.on("close", (code) => {
		if (code !== 0 && stderr.trim()) {
			log?.appendLine(`[buf] ${command} ${args.join(" ")}: ${stderr.trim()}`);
		}
	});
	child.unref?.();
}

/**
 * Populate the module cache for `dir` in the background, once per session.
 * `buf dep graph` is read-only with respect to `buf.lock`; `buf dep update` is
 * only used when there is no lock to clobber.
 */
function warmModuleCache(dir: string, hasLock: boolean, log?: Logger): void {
	if (warmedDirs.has(dir)) {
		return;
	}
	warmedDirs.add(dir);
	spawnDetached(
		"buf",
		hasLock ? ["dep", "graph"] : ["dep", "update"],
		dir,
		log,
	);
}

/* ------------------------------------------------------------------ *
 * Manifest parsing
 * ------------------------------------------------------------------ */

/** A `modules:` entry from a v2 `buf.yaml`, or the implied single module. */
interface ParsedModuleEntry {
	/** Absolute directory this module is rooted at. */
	root: string;
	name?: string;
}

/** Parsed shape of one `buf.yaml`. */
export interface ParsedBufYaml {
	version: string;
	/** Module roots declared by this file, already resolved to absolute paths. */
	entries: ParsedModuleEntry[];
	/** `deps:` names as written; the lock file is authoritative for commits. */
	deps: string[];
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * Parse a `buf.yaml` with a real YAML parser. Handles v2 (`modules:` with
 * `path`/`name`), v1 (module rooted at the file's directory) and v1beta1
 * (`build.roots`).
 */
export function parseBufYaml(text: string, dir: string): ParsedBufYaml {
	let doc: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			doc = parsed as Record<string, unknown>;
		}
	} catch {
		doc = {};
	}
	const version = typeof doc.version === "string" ? doc.version : "v1";
	const entries: ParsedModuleEntry[] = [];

	const modules = doc.modules;
	if (Array.isArray(modules)) {
		for (const raw of modules) {
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const entry = raw as Record<string, unknown>;
			const relative = typeof entry.path === "string" ? entry.path : ".";
			entries.push({
				root: path.resolve(dir, relative),
				name: typeof entry.name === "string" ? entry.name : undefined,
			});
		}
	}

	// v1beta1 build roots.
	const build = doc.build;
	if (build && typeof build === "object") {
		for (const root of asStringArray(
			(build as Record<string, unknown>).roots,
		)) {
			entries.push({ root: path.resolve(dir, root) });
		}
	}

	if (entries.length === 0) {
		entries.push({
			root: dir,
			name: typeof doc.name === "string" ? doc.name : undefined,
		});
	} else if (typeof doc.name === "string") {
		for (const entry of entries) {
			if (!entry.name) {
				entry.name = doc.name;
			}
		}
	}

	return { version, entries, deps: asStringArray(doc.deps) };
}

/** Parse `buf.work.yaml`: `directories:` relative to the file's own directory. */
export function parseBufWorkYaml(text: string, dir: string): string[] {
	let doc: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			doc = parsed as Record<string, unknown>;
		}
	} catch {
		return [];
	}
	return asStringArray(doc.directories).map((relative) =>
		path.resolve(dir, relative),
	);
}

/**
 * Nearest `.api-linter.yaml` at or above `root`, stopping at the containing
 * workspace folder.
 */
async function findApiLinterConfig(root: string): Promise<string | undefined> {
	const boundary = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))
		?.uri.fsPath;
	let current = root;
	for (let level = 0; level < MAX_CONFIG_WALK; level++) {
		for (const candidate of [".api-linter.yaml", "api-linter.yaml"]) {
			const full = path.join(current, candidate);
			try {
				if ((await fsp.stat(full)).isFile()) {
					return full;
				}
			} catch {
				// keep walking
			}
		}
		if (boundary && current === boundary) {
			return undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
	return undefined;
}

/* ------------------------------------------------------------------ *
 * Graph
 * ------------------------------------------------------------------ */

function isInside(target: string, root: string): boolean {
	return target === root || target.startsWith(root + path.sep);
}

class BufModuleGraphImpl implements BufModuleGraph {
	private readonly byLongestRoot: readonly ProtoModule[];

	constructor(
		private readonly all: readonly ProtoModule[],
		private readonly stamps: readonly ConfigStamp[],
		private readonly primary: string | undefined,
	) {
		this.byLongestRoot = [...all].sort((a, b) => b.root.length - a.root.length);
	}

	modules(): readonly ProtoModule[] {
		return this.all;
	}

	forFile(absolutePath: string): ProtoModule | undefined {
		const target = path.resolve(absolutePath);
		for (const module of this.byLongestRoot) {
			if (isInside(target, module.root)) {
				return module;
			}
		}
		return undefined;
	}

	protoPathsFor(absolutePath: string): readonly string[] {
		const module = this.forFile(absolutePath);
		if (!module) {
			return [];
		}
		const out: string[] = [];
		const seen = new Set<string>();
		const add = (candidate: string | undefined) => {
			if (!candidate || seen.has(candidate)) {
				return;
			}
			seen.add(candidate);
			out.push(candidate);
		};
		for (const root of module.roots) {
			add(root);
		}
		for (const dep of module.deps) {
			add(dep.cachePath);
		}
		return out;
	}

	allProtoPaths(): readonly string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const add = (candidate: string | undefined) => {
			if (!candidate || seen.has(candidate)) {
				return;
			}
			seen.add(candidate);
			out.push(candidate);
		};
		for (const module of this.all) {
			for (const root of module.roots) {
				add(root);
			}
		}
		for (const module of this.all) {
			for (const dep of module.deps) {
				add(dep.cachePath);
			}
		}
		return out;
	}

	configStamps(): readonly ConfigStamp[] {
		return this.stamps;
	}

	primaryConfig(): string | undefined {
		return this.primary;
	}
}

/** An empty graph, used when there is no workspace or no manifest at all. */
const EMPTY_GRAPH: BufModuleGraph = new BufModuleGraphImpl([], [], undefined);

/* ------------------------------------------------------------------ *
 * Discovery + caching
 * ------------------------------------------------------------------ */

/** Every `buf.yaml` / `buf.work.yaml` in the workspace, with their mtimes. */
async function discoverConfigs(): Promise<ConfigStamp[]> {
	if (!vscode.workspace.workspaceFolders?.length) {
		return [];
	}
	let uris: vscode.Uri[];
	try {
		uris = await vscode.workspace.findFiles(
			CONFIG_GLOB,
			CONFIG_EXCLUDE,
			MAX_CONFIGS,
		);
	} catch {
		return [];
	}
	const stamps: ConfigStamp[] = [];
	await Promise.all(
		uris.map(async (uri) => {
			const filePath = uri.fsPath;
			try {
				const stat = await fsp.stat(filePath);
				stamps.push({ path: filePath, mtimeMs: stat.mtimeMs });
			} catch {
				// vanished between find and stat
			}
			// buf.lock sits beside buf.yaml and must invalidate the graph too.
			if (path.basename(filePath) === "buf.yaml") {
				const lockPath = path.join(path.dirname(filePath), "buf.lock");
				try {
					const stat = await fsp.stat(lockPath);
					stamps.push({ path: lockPath, mtimeMs: stat.mtimeMs });
				} catch {
					// no lock file
				}
			}
		}),
	);
	stamps.sort((a, b) => a.path.localeCompare(b.path));
	return stamps;
}

function stampsKey(stamps: readonly ConfigStamp[]): string {
	return stamps.map((s) => `${s.path}:${s.mtimeMs}`).join("|");
}

/** Build a graph from already-stamped manifests. */
async function buildGraph(
	stamps: readonly ConfigStamp[],
	log?: Logger,
): Promise<BufModuleGraph> {
	const cacheRoot = getBufModuleCacheRoot();
	const yamlPaths = stamps
		.map((s) => s.path)
		.filter((p) => path.basename(p) === "buf.yaml");
	const workPaths = stamps
		.map((s) => s.path)
		.filter((p) => path.basename(p) === "buf.work.yaml");

	// buf.work.yaml directories are module roots even when their buf.yaml was
	// excluded from the glob.
	const workDirs = new Set<string>();
	await Promise.all(
		workPaths.map(async (workPath) => {
			try {
				const text = await fsp.readFile(workPath, "utf8");
				for (const dir of parseBufWorkYaml(text, path.dirname(workPath))) {
					workDirs.add(dir);
				}
			} catch {
				// unreadable manifest
			}
		}),
	);

	const modules: ProtoModule[] = [];
	const claimedRoots = new Set<string>();

	await Promise.all(
		yamlPaths.map(async (yamlPath) => {
			const dir = path.dirname(yamlPath);
			let text: string;
			try {
				text = await fsp.readFile(yamlPath, "utf8");
			} catch {
				return;
			}
			const parsed = parseBufYaml(text, dir);
			const locked = await readBufLock(dir);
			const declared: LockedDep[] = locked.length
				? locked
				: parsed.deps.map((name) => ({ name, commit: "" }));
			const deps = await Promise.all(
				declared.map((dep) => resolveDependency(dep, cacheRoot)),
			);
			if (deps.some((dep) => !dep.cachePath)) {
				warmModuleCache(dir, locked.length > 0, log);
			}
			const apiLinterConfig = await findApiLinterConfig(dir);
			for (const entry of parsed.entries) {
				if (claimedRoots.has(entry.root)) {
					continue;
				}
				if (!(await isDirectory(entry.root))) {
					continue;
				}
				claimedRoots.add(entry.root);
				modules.push({
					root: entry.root,
					roots: [entry.root],
					deps,
					apiLinterConfig:
						entry.root === dir
							? apiLinterConfig
							: ((await findApiLinterConfig(entry.root)) ?? apiLinterConfig),
					name: entry.name,
				});
			}
		}),
	);

	// Workspace directories with no buf.yaml of their own still resolve imports
	// relative to themselves.
	for (const dir of workDirs) {
		if (claimedRoots.has(dir)) {
			continue;
		}
		if (!(await isDirectory(dir))) {
			continue;
		}
		claimedRoots.add(dir);
		modules.push({
			root: dir,
			roots: [dir],
			deps: [],
			apiLinterConfig: await findApiLinterConfig(dir),
		});
	}

	const workspaceRoots =
		vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
	const primary =
		yamlPaths.find((p) =>
			workspaceRoots.some((root) => p === path.join(root, "buf.yaml")),
		) ?? [...yamlPaths].sort((a, b) => a.length - b.length)[0];

	log?.appendLine(
		`[buf] module graph: ${modules.length} module(s) from ${yamlPaths.length} buf.yaml, ${workPaths.length} buf.work.yaml`,
	);
	return new BufModuleGraphImpl(modules, stamps, primary);
}

let cachedGraph: { graph: BufModuleGraph; key: string; at: number } | null =
	null;
let pendingGraph: Promise<BufModuleGraph> | null = null;

/**
 * The workspace module graph. Cached on manifest mtimes: inside a short window
 * the cached graph is returned outright, after it the manifests are re-stamped
 * and the graph is only rebuilt when something actually changed.
 */
export async function getModuleGraph(
	outputChannel?: Logger,
): Promise<BufModuleGraph> {
	if (cachedGraph && Date.now() - cachedGraph.at < FAST_TTL_MS) {
		return cachedGraph.graph;
	}
	if (pendingGraph) {
		return pendingGraph;
	}
	pendingGraph = (async () => {
		const stamps = await discoverConfigs();
		if (stamps.length === 0) {
			cachedGraph = { graph: EMPTY_GRAPH, key: "", at: Date.now() };
			return EMPTY_GRAPH;
		}
		const key = stampsKey(stamps);
		if (cachedGraph && cachedGraph.key === key) {
			cachedGraph.at = Date.now();
			return cachedGraph.graph;
		}
		const graph = await buildGraph(stamps, outputChannel);
		cachedGraph = { graph, key, at: Date.now() };
		return graph;
	})();
	try {
		return await pendingGraph;
	} finally {
		pendingGraph = null;
	}
}

/**
 * Drop the cached graph. Call when a `buf.yaml`, `buf.work.yaml` or `buf.lock`
 * changes, or when workspace folders change.
 */
export function invalidateModuleGraphCache(): void {
	cachedGraph = null;
	warmedDirs.clear();
}
