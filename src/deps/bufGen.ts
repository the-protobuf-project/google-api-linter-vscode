/**
 * `buf.gen.yaml` parsing and discovery.
 *
 * Nothing else in the extension reads this file, so the parser is written to
 * the same rule the `buf.yaml` parser follows: a half-typed template is the
 * normal state of a file being edited, and the Dependencies view must keep
 * rendering while the user types. Every helper here degrades to a partial
 * result; none of them throws.
 *
 * The v1 and v2 schemas name plugins differently. v2 says where a plugin runs
 * (`remote:` / `local:` / `protoc_builtin:`); v1 only gives a name (`plugin:`,
 * or `name:` in the oldest files) and leaves the kind to be inferred. Both
 * collapse onto {@link GenPlugin} so the panel renders one shape.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { GenConfig, GenPlugin, GenPluginKind } from "../shared/protocol";

/**
 * `buf.gen.yaml`, plus the named templates buf accepts alongside it
 * (`buf.gen.go.yaml` and friends), in either YAML extension.
 */
const GEN_FILE_PATTERN = /^buf\.gen(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/;

/**
 * Languages protoc generates without a plugin binary. A v1 entry naming one of
 * these is `protoc_builtin:` in v2 terms; anything else unqualified is a local
 * binary on PATH.
 */
const PROTOC_BUILTINS = new Set([
	"cpp",
	"csharp",
	"java",
	"js",
	"kotlin",
	"objc",
	"php",
	"python",
	"pyi",
	"ruby",
]);

/** Upper bound on templates returned by one discovery pass. */
const MAX_GEN_CONFIGS = 128;

/** A sink for diagnostics; the extension's output channel satisfies it. */
interface Logger {
	appendLine(message: string): void;
}

/**
 * A plugin reference as written. v2's `local:` accepts an argv list
 * (`local: [go, run, ./cmd/protoc-gen-x]`), which is joined back into the
 * command line the user wrote rather than shown as a JSON array.
 */
function asRef(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || undefined;
	}
	if (Array.isArray(value)) {
		const parts = value.filter(
			(item): item is string => typeof item === "string",
		);
		return parts.length > 0 ? parts.join(" ") : undefined;
	}
	return undefined;
}

/**
 * `opt:` normalised to a list. It is a scalar in the majority of real templates
 * and a list in the rest; the panel should not have to know which.
 */
function asOptList(value: unknown): string[] {
	if (typeof value === "string") {
		return value.trim() ? [value] : [];
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	return [];
}

/** `revision:` as a non-negative integer, ignoring anything else. */
function asRevision(value: unknown): number | undefined {
	const numeric = typeof value === "string" ? Number(value) : value;
	if (
		typeof numeric !== "number" ||
		!Number.isInteger(numeric) ||
		numeric < 0
	) {
		return undefined;
	}
	return numeric;
}

/** Where a v1 plugin runs, judged from its name alone. */
function inferKind(ref: string): GenPluginKind {
	if (ref.includes("/")) {
		return "remote";
	}
	return PROTOC_BUILTINS.has(ref) ? "protoc_builtin" : "local";
}

/** The plugin a `plugins:` entry names, and where it runs. */
function namePlugin(
	entry: Record<string, unknown>,
): { ref: string; kind: GenPluginKind } | undefined {
	// v2 keys state the kind outright, so they are consulted first: a file that
	// carries both (mid-migration, or hand-merged) is v2 by intent.
	const remote = asRef(entry.remote);
	if (remote) {
		return { ref: remote, kind: "remote" };
	}
	const local = asRef(entry.local);
	if (local) {
		return { ref: local, kind: "local" };
	}
	const builtin = asRef(entry.protoc_builtin);
	if (builtin) {
		return { ref: builtin, kind: "protoc_builtin" };
	}
	const v1 = asRef(entry.plugin) ?? asRef(entry.name);
	return v1 ? { ref: v1, kind: inferKind(v1) } : undefined;
}

/** One `plugins:` entry, or `undefined` when it names no plugin at all. */
function readPlugin(raw: unknown): GenPlugin | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return undefined;
	}
	const entry = raw as Record<string, unknown>;
	const named = namePlugin(entry);
	if (!named) {
		return undefined;
	}
	return {
		ref: named.ref,
		kind: named.kind,
		out: typeof entry.out === "string" ? entry.out : "",
		opt: asOptList(entry.opt),
		revision: asRevision(entry.revision),
	};
}

/**
 * Parses one `buf.gen.yaml`.
 *
 * Pure: `filePath` is only recorded on the result, never read, so the parser is
 * testable without touching a disk.
 *
 * Two degrade levels are distinguishable on the result. A document that is not
 * a mapping — unparseable YAML, or a bare list — yields an empty config with an
 * empty `version`, because nothing was read. A mapping that merely omits
 * `version:` yields `v1`, which is the version buf assumes for it.
 *
 * @param text - File contents
 * @param filePath - Absolute path recorded as {@link GenConfig.path}
 * @returns The parsed template, partial rather than absent when malformed
 */
export function parseBufGenYaml(text: string, filePath: string): GenConfig {
	let doc: Record<string, unknown> | undefined;
	try {
		const parsed = parseYaml(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			doc = parsed as Record<string, unknown>;
		}
	} catch {
		doc = undefined;
	}
	if (!doc) {
		return { path: filePath, version: "", managed: false, plugins: [] };
	}

	const plugins: GenPlugin[] = [];
	if (Array.isArray(doc.plugins)) {
		for (const raw of doc.plugins) {
			const plugin = readPlugin(raw);
			if (plugin) {
				plugins.push(plugin);
			}
		}
	}

	const managed = doc.managed;
	return {
		path: filePath,
		version: typeof doc.version === "string" ? doc.version : "v1",
		managed:
			!!managed &&
			typeof managed === "object" &&
			(managed as Record<string, unknown>).enabled === true,
		plugins,
	};
}

/** Bounds and cancellation for {@link findGenConfigs}. */
export interface GenDiscoveryOptions {
	/** Aborts between directories when it returns true. */
	readonly isCancelled?: () => boolean;
	/** Hard ceiling on templates returned. Defaults to 128. */
	readonly maxConfigs?: number;
	readonly log?: Logger;
}

/**
 * Finds and parses every `buf.gen.yaml` sitting directly in one of `dirs`.
 *
 * One `readdir` per directory rather than a workspace-wide glob: the callers
 * already know which directories own a module, and buf only ever reads a
 * template from the directory it runs in, so descending would surface files
 * `buf generate` would never use.
 *
 * @param dirs - Absolute directories to look in; duplicates are collapsed
 * @param options - Bounds and cancellation
 * @returns Parsed templates, ordered by path
 */
export async function findGenConfigs(
	dirs: readonly string[],
	options: GenDiscoveryOptions = {},
): Promise<GenConfig[]> {
	const limit = options.maxConfigs ?? MAX_GEN_CONFIGS;
	const unique = [...new Set(dirs.map((dir) => path.resolve(dir)))];
	const found: string[] = [];

	for (const dir of unique) {
		if (options.isCancelled?.() || found.length >= limit) {
			break;
		}
		let entries: string[];
		try {
			entries = await fsp.readdir(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (GEN_FILE_PATTERN.test(name)) {
				found.push(path.join(dir, name));
			}
		}
	}

	const paths = [...new Set(found)].sort().slice(0, limit);
	const configs = await Promise.all(
		paths.map(async (filePath) => {
			try {
				return parseBufGenYaml(await fsp.readFile(filePath, "utf8"), filePath);
			} catch (error) {
				options.log?.appendLine(
					`[deps] unreadable ${filePath}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return undefined;
			}
		}),
	);
	return configs.filter((config): config is GenConfig => config !== undefined);
}
