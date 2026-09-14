/**
 * Update status from the Buf Schema Registry, via the `buf` CLI.
 *
 * This is the only part of the dependency model that touches the network, and
 * it is therefore the only part that must be invoked explicitly. Nothing here
 * may run on activation: the registry is unreachable on a plane, behind a proxy
 * and inside CI, and a dependency view that cannot render without it is a view
 * that does not render.
 *
 * The CLI is shelled out to rather than the BSR being called over HTTP, because
 * `buf` already holds the user's credentials, honours their `~/.netrc` and
 * their `BUF_TOKEN`, and knows which remotes are private. Reimplementing that
 * would mean reimplementing authentication.
 *
 * Facts the parsers are written against, from the CLI itself:
 *   - `buf registry module commit list <ref> --format=json` prints
 *     `{"commits":[{"commit","create_time","source_control_url"?}, …]}`,
 *     newest first.
 *   - `buf registry module info <ref> --format=json` prints a single object
 *     with `id`, `remote`, `owner`, `name`, `create_time`, `state` and
 *     `default_label_name`.
 *   - A deleted module fails with
 *     `Failure: a module named "…" does not exist`.
 *   - `buf dep` has no `add` subcommand — only `graph`, `prune` and `update`.
 */

import * as cp from "node:child_process";
import type {
	BufDep,
	DependencyModel,
	ModuleDeps,
	UpdateStatus,
} from "../shared/protocol";

/** Default ceiling on one registry call. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Registry calls in flight at once. */
const DEFAULT_CONCURRENCY = 4;

/** Cap on captured output; a commit page is kilobytes, never megabytes. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * The failure a deleted module produces. Matched loosely around the quoted
 * reference so a change of quoting style in the CLI does not silently turn an
 * orphan back into a healthy dependency.
 */
const MODULE_MISSING = /a module named\b[^\n]*\bdoes not exist/i;

/** A sink for diagnostics; the extension's output channel satisfies it. */
interface Logger {
	appendLine(message: string): void;
}

/** What a finished subprocess reported. */
export interface CommandResult {
	/** Exit status, or 1 when the process could not be started at all. */
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Set when the process failed to spawn or was killed by the timeout. */
	readonly error?: string;
}

/**
 * Runs a command and resolves with its result.
 *
 * Implementations must never reject: a rejected promise here would propagate
 * into the model assembly and lose every dependency, not just the one that
 * could not be checked. Tests inject their own so no test touches the network.
 */
export type CommandRunner = (
	command: string,
	args: readonly string[],
	timeoutMs: number,
) => Promise<CommandResult>;

/** The default {@link CommandRunner}, backed by `child_process.execFile`. */
export const execCommand: CommandRunner = (command, args, timeoutMs) =>
	new Promise<CommandResult>((resolve) => {
		const finish = (result: CommandResult): void => resolve(result);
		try {
			cp.execFile(
				command,
				[...args],
				{
					timeout: timeoutMs,
					maxBuffer: MAX_OUTPUT_BYTES,
					windowsHide: true,
				},
				(error, stdout, stderr) => {
					if (!error) {
						finish({ code: 0, stdout, stderr });
						return;
					}
					const code =
						typeof (error as { code?: unknown }).code === "number"
							? (error as { code: number }).code
							: 1;
					finish({ code, stdout, stderr, error: error.message });
				},
			);
		} catch (error) {
			// A missing binary throws synchronously on some platforms.
			finish({
				code: 1,
				stdout: "",
				stderr: "",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

/** One commit on a module's default label. */
export interface RegistryCommit {
	readonly commit: string;
	/** ISO-8601, as `create_time` in the CLI's JSON. */
	readonly createTime: string;
	readonly sourceControlUrl?: string;
}

/** What `buf registry module info` reports about a module. */
export interface RegistryModuleInfo {
	readonly id: string;
	readonly remote: string;
	readonly owner: string;
	readonly name: string;
	readonly createTime: string;
	/** e.g. `STATE_ACTIVE`. */
	readonly state: string;
	readonly defaultLabelName: string;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** JSON.parse that reports malformed input as absent rather than throwing. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** One `commits:` element, or `undefined` when it carries no commit id. */
function readCommit(raw: unknown): RegistryCommit | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	const entry = raw as Record<string, unknown>;
	const commit = asString(entry.commit);
	if (!commit) {
		return undefined;
	}
	const url = asString(entry.source_control_url);
	return {
		commit,
		createTime: asString(entry.create_time),
		sourceControlUrl: url || undefined,
	};
}

/**
 * Parses `buf registry module commit list --format=json`.
 *
 * Accepts the documented `{"commits":[…]}` object, a bare array, and
 * newline-delimited objects, because `--format=json` has meant all three across
 * CLI versions and the difference is not worth a version probe. Order is
 * preserved: the registry returns newest first and {@link computeBehind}
 * depends on that.
 *
 * @param stdout - Raw standard output of the command
 * @returns Commits in the order printed, empty when nothing parsed
 */
export function parseCommitList(stdout: string): RegistryCommit[] {
	const text = stdout.trim();
	if (!text) {
		return [];
	}
	const collect = (value: unknown): RegistryCommit[] => {
		const list = Array.isArray(value)
			? value
			: value && typeof value === "object"
				? (value as { commits?: unknown }).commits
				: undefined;
		if (!Array.isArray(list)) {
			return [];
		}
		const out: RegistryCommit[] = [];
		for (const raw of list) {
			const commit = readCommit(raw);
			if (commit) {
				out.push(commit);
			}
		}
		return out;
	};

	const whole = collect(parseJson(text));
	if (whole.length > 0) {
		return whole;
	}
	const lines: RegistryCommit[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const parsed = parseJson(trimmed);
		const one = readCommit(parsed);
		if (one) {
			lines.push(one);
			continue;
		}
		lines.push(...collect(parsed));
	}
	return lines;
}

/**
 * Parses `buf registry module info --format=json`.
 *
 * @param stdout - Raw standard output of the command
 * @returns The module, or `undefined` when the output was not a JSON object
 */
export function parseModuleInfo(
	stdout: string,
): RegistryModuleInfo | undefined {
	const parsed = parseJson(stdout.trim());
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return undefined;
	}
	const doc = parsed as Record<string, unknown>;
	return {
		id: asString(doc.id),
		remote: asString(doc.remote),
		owner: asString(doc.owner),
		name: asString(doc.name),
		createTime: asString(doc.create_time),
		state: asString(doc.state),
		defaultLabelName: asString(doc.default_label_name),
	};
}

/**
 * True when a CLI failure says the module no longer exists on the registry.
 *
 * @param text - Combined stderr and stdout of a failed call
 */
export function isModuleMissing(text: string): boolean {
	return MODULE_MISSING.test(text);
}

/**
 * How many commits separate a pinned commit from the newest one.
 *
 * `undefined` is returned whenever the pin is not on the page the registry
 * handed back, and that is deliberately not zero: a commit old enough to have
 * fallen off the first page is the furthest behind a dependency can be, so
 * reporting 0 there would invert the meaning.
 *
 * @param commits - Commits newest first, as the registry returns them
 * @param pinned - Commit from `buf.lock`
 * @returns Commits ahead of the pin, or `undefined` when it was not found
 */
export function computeBehind(
	commits: readonly RegistryCommit[],
	pinned: string,
): number | undefined {
	if (!pinned) {
		return undefined;
	}
	const at = commits.findIndex((entry) => entry.commit === pinned);
	return at >= 0 ? at : undefined;
}

/** Inputs for every registry call. */
export interface RegistryOptions {
	/** The `buf` binary, from the `gapi.bufPath` setting. Defaults to `buf`. */
	readonly bufPath?: string;
	/** Injected for tests; defaults to {@link execCommand}. */
	readonly run?: CommandRunner;
	/** Ceiling on one call. Defaults to 15 s. */
	readonly timeoutMs?: number;
	/** Calls in flight at once. Defaults to 4. */
	readonly concurrency?: number;
	/** Abandons the remaining calls when it returns true. */
	readonly isCancelled?: () => boolean;
	readonly log?: Logger;
}

/** The outcome of one module's commit lookup. */
export interface CommitLookup {
	readonly commits: readonly RegistryCommit[];
	/** True when the registry says the module no longer exists. */
	readonly missing: boolean;
	/** Set when the call failed for any reason, including `missing`. */
	readonly error?: string;
}

/** First non-empty line of CLI output, which is where buf puts the failure. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return "";
}

/**
 * Lists a module's commits, newest first.
 *
 * @param name - Module reference, e.g. `buf.build/googleapis/googleapis`
 * @param options - Binary, runner, timeout and logging
 * @returns Commits, or the reason none could be listed. Never rejects.
 */
export async function fetchCommits(
	name: string,
	options: RegistryOptions = {},
): Promise<CommitLookup> {
	const run = options.run ?? execCommand;
	const result = await run(
		options.bufPath ?? "buf",
		["registry", "module", "commit", "list", name, "--format=json"],
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const failureText = `${result.stderr}\n${result.stdout}`;
	if (isModuleMissing(failureText)) {
		return {
			commits: [],
			missing: true,
			error: firstLine(result.stderr) || `${name} does not exist`,
		};
	}
	if (result.code !== 0) {
		const message =
			firstLine(result.stderr) ||
			result.error ||
			`buf exited with ${result.code}`;
		options.log?.appendLine(`[deps] ${name}: ${message}`);
		return { commits: [], missing: false, error: message };
	}
	const commits = parseCommitList(result.stdout);
	if (commits.length === 0) {
		return {
			commits: [],
			missing: false,
			error: "registry returned no commits",
		};
	}
	return { commits, missing: false };
}

/**
 * Reads a module's registry record — used for its default label and state.
 *
 * @param name - Module reference
 * @param options - Binary, runner, timeout and logging
 * @returns The record, or `undefined` when the lookup failed. Never rejects.
 */
export async function fetchModuleInfo(
	name: string,
	options: RegistryOptions = {},
): Promise<RegistryModuleInfo | undefined> {
	const run = options.run ?? execCommand;
	const result = await run(
		options.bufPath ?? "buf",
		["registry", "module", "info", name, "--format=json"],
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	if (result.code !== 0) {
		options.log?.appendLine(
			`[deps] ${name}: ${firstLine(result.stderr) || result.error || "info failed"}`,
		);
		return undefined;
	}
	return parseModuleInfo(result.stdout);
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lanes = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const at = next++;
				results[at] = await worker(items[at]);
			}
		},
	);
	await Promise.all(lanes);
	return results;
}

/**
 * The {@link UpdateStatus} one lookup implies for one pinned commit.
 *
 * A failed lookup still produces a status, with empty commit fields and the
 * failure in `error`: {@link UpdateStatus} makes `latestCommit` and
 * `latestTime` required, and a row that shows the error is more useful than one
 * that silently shows nothing.
 */
function statusFor(lookup: CommitLookup, pinned: string): UpdateStatus {
	const newest = lookup.commits[0];
	if (!newest) {
		return { latestCommit: "", latestTime: "", error: lookup.error };
	}
	return {
		latestCommit: newest.commit,
		latestTime: newest.createTime,
		behind: computeBehind(lookup.commits, pinned),
		error: lookup.error,
	};
}

/** One dependency with its lookup applied. */
function withUpdate(dep: BufDep, lookup: CommitLookup): BufDep {
	return {
		...dep,
		// A module the registry has deleted is an orphan whatever the workspace
		// still says about it, so the lookup overrides the on-disk state.
		state: lookup.missing ? "orphaned" : dep.state,
		update: statusFor(lookup, dep.commit),
	};
}

/**
 * Fetches update status for every module in a model and returns a new one.
 *
 * One lookup per distinct module reference, however many manifests declare it;
 * `behind` is then computed locally per pinned commit, so two modules pinned to
 * different commits of the same dependency cost one round trip, not two.
 *
 * Network-bound. Call it from an explicit user action — the `dep/checkUpdates`
 * message — never from activation or a file watcher.
 *
 * @param model - Model from `buildDependencyModel`
 * @param options - Binary path, runner, timeout, concurrency and cancellation
 * @returns A new model with `update` filled in and `updatesChecked` true, or
 *   the original model untouched when cancelled before the first call
 */
export async function checkUpdates(
	model: DependencyModel,
	options: RegistryOptions = {},
): Promise<DependencyModel> {
	if (options.isCancelled?.()) {
		return model;
	}
	const names = new Set<string>();
	for (const module of model.modules) {
		for (const dep of module.deps) {
			names.add(dep.name);
		}
	}
	for (const dep of model.undeclared) {
		names.add(dep.name);
	}
	if (names.size === 0) {
		return { ...model, updatesChecked: true };
	}

	const ordered = [...names];
	const lookups = await mapLimited(
		ordered,
		options.concurrency ?? DEFAULT_CONCURRENCY,
		async (name): Promise<CommitLookup> => {
			if (options.isCancelled?.()) {
				return { commits: [], missing: false, error: "cancelled" };
			}
			return fetchCommits(name, options);
		},
	);
	const byName = new Map(ordered.map((name, at) => [name, lookups[at]]));
	const apply = (dep: BufDep): BufDep => {
		const lookup = byName.get(dep.name);
		return lookup ? withUpdate(dep, lookup) : dep;
	};

	const modules: ModuleDeps[] = model.modules.map((module) => ({
		...module,
		deps: module.deps.map(apply),
	}));
	return {
		...model,
		modules,
		undeclared: model.undeclared.map(apply),
		updatesChecked: true,
	};
}
