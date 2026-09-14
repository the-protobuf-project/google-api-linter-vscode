/**
 * Pure derivations behind the Registry panel.
 *
 * Nothing here touches the DOM, a rune, or the bridge. The same functions back
 * the fixture render and the live one, so a mistake in the grouping shows up as
 * a wrong number in a unit-testable place rather than as a wrong pixel.
 */

import type {
	BufDep,
	DependencyModel,
	GenConfig,
	ModuleDeps,
} from "../../shared/protocol";

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

/**
 * Every glyph `Icon.svelte` can draw.
 *
 * Declared here rather than in the component because `tsc` cannot read a
 * `.svelte` file, so a union exported from one would be unresolvable to every
 * `.ts` module that names an icon.
 */
export type IconName =
	| "registry"
	| "package"
	| "plug"
	| "sync"
	| "plus"
	| "warning"
	| "check"
	| "search"
	| "external-link"
	| "github";

/** Which slice of the model the middle list shows. */
export type FilterId =
	| "ws:declared"
	| "ws:updates"
	| "ws:cached"
	| "ws:orphaned"
	| `owner:${string}`
	| `remote:${string}`
	| "gen:plugins";

/** What the selection in the rail resolves to before anything is persisted. */
export const DEFAULT_FILTER: FilterId = "ws:declared";

/* ------------------------------------------------------------------ *
 * Paths and commits
 * ------------------------------------------------------------------ */

/** First eight characters of a commit — the width `buf` prints in its tables. */
export function shortCommit(commit: string): string {
	return commit.slice(0, 8);
}

/**
 * True when two commit ids name the same commit.
 *
 * A registry lookup and a `buf.lock` entry do not always agree on how much of
 * the id they print, so the comparison is made at the shorter of the two.
 */
export function sameCommit(a: string, b: string): boolean {
	return a.length && b.length ? shortCommit(a) === shortCommit(b) : a === b;
}

/** Directory part of an absolute path, for either separator. */
export function dirOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut > 0 ? path.slice(0, cut) : path;
}

/** Last segment of a path, e.g. a module directory's own name. */
export function baseOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Join with the separator the path already uses, so a Windows root stays one. */
function join(dir: string, name: string): string {
	const windows = dir.includes("\\") && !dir.includes("/");
	return windows ? `${dir}\\${name}` : `${dir}/${name}`;
}

/**
 * Absolute `buf.yaml` a `dep/add` should edit for this module.
 *
 * `ModuleDeps` carries the directory but not the file, so the path is taken
 * from a dep that records where it was declared when there is one — that is the
 * exact file the host already parsed — and assembled only as a fallback.
 */
export function bufYamlPath(module: ModuleDeps): string {
	const declared = module.deps.find((dep) => dep.declaredIn);
	return declared?.declaredIn ?? join(module.root, "buf.yaml");
}

/** A module's display name: its `name:` when it has one, else its directory. */
export function moduleLabel(module: ModuleDeps): string {
	return module.name ?? baseOf(module.root);
}

/* ------------------------------------------------------------------ *
 * Dependency queries
 * ------------------------------------------------------------------ */

/**
 * Every dependency in the model, declared and merely cached, deduplicated.
 *
 * Sorted by proto count so the modules that actually carry weight sit at the
 * top; a two-file helper module and a 94-file `googleapis` are not equally
 * interesting when scanning a list.
 */
export function allDeps(model: DependencyModel): readonly BufDep[] {
	const byName = new Map<string, BufDep>();
	for (const module of model.modules) {
		for (const dep of module.deps) {
			byName.set(dep.name, dep);
		}
	}
	// An undeclared entry must never displace a declared one of the same name:
	// only the declared record carries `declaredIn`, which the add preview needs.
	for (const dep of model.undeclared) {
		if (!byName.has(dep.name)) {
			byName.set(dep.name, dep);
		}
	}
	return [...byName.values()].sort(compareDeps);
}

function compareDeps(a: BufDep, b: BufDep): number {
	const size = (b.protoCount ?? 0) - (a.protoCount ?? 0);
	return size !== 0 ? size : a.name.localeCompare(b.name);
}

/**
 * True when the registry holds a commit newer than the pinned one.
 *
 * `behind` is absent when the pinned commit fell off the label's first page,
 * which the protocol distinguishes from being behind by zero — so an absent
 * count with a differing latest commit still counts as behind.
 */
export function isBehind(dep: BufDep): boolean {
	const update = dep.update;
	if (!update || update.error) {
		return false;
	}
	return update.behind === undefined
		? !sameCommit(update.latestCommit, dep.commit)
		: update.behind > 0;
}

/** The registry could not speak for this module at all. */
export function isGone(dep: BufDep): boolean {
	return dep.state === "orphaned" || dep.update?.error !== undefined;
}

/** Matches the search box against the three names a reader would type. */
export function matchesQuery(dep: BufDep, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	return (
		dep.name.toLowerCase().includes(needle) ||
		dep.module.toLowerCase().includes(needle) ||
		dep.owner.toLowerCase().includes(needle)
	);
}

/** Narrows a dependency list to one rail selection. */
export function filterDeps(
	deps: readonly BufDep[],
	filter: FilterId,
): readonly BufDep[] {
	switch (filter) {
		case "ws:declared":
			// `missing` is still declared — it is declared and not unpacked, which
			// is a cache problem rather than a different kind of dependency.
			return deps.filter(
				(dep) => dep.state === "declared" || dep.state === "missing",
			);
		case "ws:updates":
			return deps.filter(isBehind);
		case "ws:cached":
			return deps.filter((dep) => dep.state === "cached");
		case "ws:orphaned":
			return deps.filter(isGone);
		case "gen:plugins":
			return [];
		default:
			// Two prefixed families share this arm: a registry host and an owner.
			if (filter.startsWith("remote:")) {
				const remote = filter.slice("remote:".length);
				return deps.filter((dep) => dep.remote === remote);
			}
			return deps.filter((dep) => dep.owner === filter.slice("owner:".length));
	}
}

/** One heading and the rows beneath it in the middle list. */
export interface DepGroup {
	readonly label: string;
	readonly deps: readonly BufDep[];
}

/** Groups rows under `remote/owner`, preserving the incoming order. */
export function groupDeps(deps: readonly BufDep[]): readonly DepGroup[] {
	const buckets = new Map<string, BufDep[]>();
	for (const dep of deps) {
		const key = `${dep.remote}/${dep.owner}`;
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.push(dep);
		} else {
			buckets.set(key, [dep]);
		}
	}
	return [...buckets].map(([label, list]) => ({ label, deps: list }));
}

/** The module whose `buf.yaml` an action on `dep` should target. */
export function moduleFor(
	model: DependencyModel,
	dep: BufDep,
): ModuleDeps | undefined {
	if (dep.declaredIn) {
		const dir = dirOf(dep.declaredIn);
		const owner = model.modules.find((module) => module.root === dir);
		if (owner) {
			return owner;
		}
	}
	const holder = model.modules.find((module) =>
		module.deps.some((each) => each.name === dep.name),
	);
	// A cached-but-undeclared module belongs to no `buf.yaml` yet, so adding it
	// has to pick one; the first workspace module is the only sane default.
	return holder ?? model.modules[0];
}

/**
 * The `buf.gen.yaml` that belongs to a module root.
 *
 * `GenConfig` records its own path but nothing linking it back to a
 * `ModuleDeps`, so the two are matched by directory and the first config stands
 * in when nothing matches.
 */
export function genForRoot(
	model: DependencyModel,
	root: string | undefined,
): GenConfig | undefined {
	if (root) {
		const match = model.gen.find((config) => dirOf(config.path) === root);
		if (match) {
			return match;
		}
	}
	return model.gen[0];
}

/** Plugin reference without its owner path, e.g. `go` from `…/plugins/go`. */
export function pluginName(ref: string): string {
	return baseOf(ref);
}

/* ------------------------------------------------------------------ *
 * The add preview
 * ------------------------------------------------------------------ */

/** One rendered line of the `buf.yaml` preview. */
export interface YamlLine {
	readonly text: string;
	/** True for the line this action would write. */
	readonly added?: boolean;
}

/** True when `module` already names `dep` in its `deps:`. */
export function isDeclaredIn(
	module: ModuleDeps | undefined,
	dep: BufDep,
): boolean {
	return (module?.deps ?? []).some(
		(each) => each.name === dep.name && each.declaredIn !== undefined,
	);
}

/**
 * The `deps:` block as it will read once `dep` is added.
 *
 * Only the `deps:` key is rendered. The file's `version:`, `name:` and `lint:`
 * keys are not in the model, and inventing them would make a preview that
 * claims to be exact into a guess.
 */
export function addPreview(
	module: ModuleDeps | undefined,
	dep: BufDep,
): readonly YamlLine[] {
	const existing = (module?.deps ?? [])
		.filter((each) => each.declaredIn !== undefined)
		.map((each) => each.name)
		.sort();
	const lines: YamlLine[] = [{ text: "deps:" }];
	for (const name of existing) {
		lines.push({ text: `  - ${name}` });
	}
	if (!existing.includes(dep.name)) {
		lines.push({ text: `  - ${dep.name}`, added: true });
	}
	return lines;
}

/* ------------------------------------------------------------------ *
 * Commit history
 * ------------------------------------------------------------------ */

/** One row of the detail pane's commit list. */
export interface CommitRow {
	readonly commit: string;
	/** ISO-8601, when known. */
	readonly time?: string;
	/** This is the commit `buf.lock` pins. */
	readonly pinned: boolean;
	/** This is the newest commit on the module's label. */
	readonly latest: boolean;
	/** `source_control_url` from the registry, when the commit carried one. */
	readonly sourceControlUrl?: string;
}

/**
 * Commit rows for the detail pane.
 *
 * `UpdateStatus` carries only the newest commit and a distance, so a live model
 * can describe at most two points: what is pinned and what is newest. `extra`
 * exists for callers that hold the full list from elsewhere — today only the
 * fixture does, because the protocol has no field to carry one.
 *
 * @param dep - The dependency whose pinned commit anchors the list
 * @param extra - A known history, newest first
 * @returns Rows newest first, with `pinned` and `latest` recomputed
 */
export function commitHistory(
	dep: BufDep,
	extra?: readonly CommitRow[],
): readonly CommitRow[] {
	if (extra && extra.length > 0) {
		return extra.map((row, index) => ({
			...row,
			pinned: sameCommit(row.commit, dep.commit),
			latest: index === 0,
		}));
	}
	const rows: CommitRow[] = [];
	const update = dep.update;
	if (
		update &&
		!update.error &&
		update.latestCommit &&
		!sameCommit(update.latestCommit, dep.commit)
	) {
		rows.push({
			commit: update.latestCommit,
			time: update.latestTime,
			pinned: false,
			latest: true,
		});
	}
	rows.push({ commit: dep.commit, pinned: true, latest: rows.length === 0 });
	return rows;
}

/** `2026-09-08T11:04:12Z` as `2026-09-08`, and anything unparseable as itself. */
export function shortDate(time: string | undefined): string {
	if (!time) {
		return "";
	}
	const at = time.indexOf("T");
	return at > 0 ? time.slice(0, at) : time;
}

/* ------------------------------------------------------------------ *
 * The rail
 * ------------------------------------------------------------------ */

/** One filter row in the left rail. */
export interface RailItem {
	readonly id: FilterId;
	readonly label: string;
	readonly icon: IconName;
	readonly count: number;
}

/** A titled block of rail rows. */
export interface RailGroup {
	readonly label: string;
	readonly items: readonly RailItem[];
}

/**
 * The rail, derived entirely from the model.
 *
 * Owners are counted from the dependencies themselves rather than listed
 * anywhere, so a workspace that pulls from an owner nobody anticipated still
 * gets a row.
 */
export function buildRail(model: DependencyModel): readonly RailGroup[] {
	const deps = allDeps(model);
	const owners = new Map<string, number>();
	// Registries are counted from the dependencies rather than from settings:
	// a workspace pulling from a host nobody configured still gets a row.
	const remotes = new Map<string, number>();
	for (const dep of deps) {
		owners.set(dep.owner, (owners.get(dep.owner) ?? 0) + 1);
		if (dep.remote) {
			remotes.set(dep.remote, (remotes.get(dep.remote) ?? 0) + 1);
		}
	}
	const plugins = model.gen.reduce(
		(total, config) => total + config.plugins.length,
		0,
	);

	return [
		{
			label: "Workspace",
			items: [
				{
					id: "ws:declared",
					label: "Declared",
					icon: "package",
					count: filterDeps(deps, "ws:declared").length,
				},
				{
					id: "ws:updates",
					label: "Updates available",
					icon: "sync",
					count: filterDeps(deps, "ws:updates").length,
				},
				{
					id: "ws:cached",
					label: "Cached",
					icon: "registry",
					count: filterDeps(deps, "ws:cached").length,
				},
				{
					id: "ws:orphaned",
					label: "Orphaned",
					icon: "warning",
					count: filterDeps(deps, "ws:orphaned").length,
				},
			],
		},
		{
			label: "Registries",
			items: [...remotes]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([remote, count]) => ({
					id: `remote:${remote}` as FilterId,
					label: remote,
					icon: "registry" as IconName,
					count,
				})),
		},
		{
			label: "Owners",
			items: [...owners]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([owner, count]) => ({
					id: `owner:${owner}` as FilterId,
					label: owner,
					icon: "github" as IconName,
					count,
				})),
		},
		{
			label: "Codegen",
			items: [
				{ id: "gen:plugins", label: "Plugins", icon: "plug", count: plugins },
			],
		},
	];
}

/** The first rail row with anything in it, so a cold panel does not open empty. */
export function firstPopulated(groups: readonly RailGroup[]): FilterId {
	for (const group of groups) {
		for (const item of group.items) {
			if (item.count > 0) {
				return item.id;
			}
		}
	}
	return DEFAULT_FILTER;
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/*
 * Written out as whole class strings rather than assembled from fragments:
 * Tailwind scans source text, so a class built at runtime is a class that is
 * never emitted into the stylesheet.
 */
const TONES = [
	"border-sym-class/30 bg-sym-class/15 text-sym-class",
	"border-sym-method/30 bg-sym-method/15 text-sym-method",
	"border-sym-field/30 bg-sym-field/15 text-sym-field",
	"border-sym-iface/30 bg-sym-iface/15 text-sym-iface",
	"border-sym-enum/30 bg-sym-enum/15 text-sym-enum",
] as const;

/**
 * A stable avatar tint for a name.
 *
 * Keyed on the owner rather than the module so an owner's modules read as a
 * set, and hashed rather than assigned by index so a module keeps its colour
 * when the list above it changes.
 */
export function avatarTone(seed: string): string {
	let hash = 0;
	for (let index = 0; index < seed.length; index += 1) {
		hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
	}
	return TONES[hash % TONES.length];
}

/** `94 protos`, or an honest dash when the module is not unpacked locally. */
export function protoSummary(dep: BufDep): string {
	if (dep.protoCount === undefined) {
		return "not cached";
	}
	return `${dep.protoCount} proto${dep.protoCount === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/** One host task, tracked by the action it backs rather than by its id. */
export interface TaskRecord {
	readonly taskId: string;
	readonly state: "running" | "done" | "failed";
	readonly message?: string;
}

/** Something the panel can ask the host to do. */
export type Action =
	| { readonly kind: "add"; readonly dep: BufDep }
	| { readonly kind: "update"; readonly root: string }
	| { readonly kind: "gen"; readonly root: string }
	| { readonly kind: "check" };

/**
 * The key one action's progress is filed under.
 *
 * Keyed by what the button does, not by `taskId`: a button has to know it is
 * busy before the host has answered, and two presses of the same button are one
 * pending action rather than two.
 */
export function actionKey(action: Action): string {
	switch (action.kind) {
		case "add":
			return `add:${action.dep.name}`;
		case "update":
			return `update:${action.root}`;
		case "gen":
			return `gen:${action.root}`;
		case "check":
			return "check";
	}
}

/**
 * A fresh task id.
 *
 * `crypto.randomUUID` needs a secure context, which a webview always is — the
 * fallback is for the panel opened in a plain page for screenshots.
 */
export function newTaskId(): string {
	return typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
