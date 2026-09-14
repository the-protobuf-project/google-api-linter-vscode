import * as path from "node:path";
import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";
import {
	getModuleGraph,
	invalidateModuleGraphCache,
	parseBufYaml,
} from "./moduleGraph";

/** One entry of a v2 `buf.yaml` `modules:` list. */
export interface BufModule {
	path: string;
	name: string;
}

/** The parts of a `buf.yaml` this extension cares about. */
export interface BufConfig {
	version?: string;
	modules: BufModule[];
	deps: string[];
	breaking?: { use?: string[] };
}

/**
 * The outermost `buf.yaml` in the workspace, preferring one at a workspace
 * folder root.
 *
 * Kept for callers that need a single representative config. It is *not* how
 * proto paths are resolved any more: use the module graph, which knows about
 * every nested `buf.yaml` and `buf.work.yaml`.
 */
export async function findBufConfig(): Promise<vscode.Uri | null> {
	const graph = await getModuleGraph();
	const primary = graph.primaryConfig();
	return primary ? vscode.Uri.file(primary) : null;
}

/**
 * Parse `buf.yaml` text with the real YAML parser. Module `path` values are
 * returned exactly as written (relative to the `buf.yaml`), matching the old
 * hand-rolled behaviour.
 */
export function readBufConfig(content: string): BufConfig {
	const config: BufConfig = { modules: [], deps: [] };
	let doc: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(content);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			doc = parsed as Record<string, unknown>;
		}
	} catch {
		return config;
	}

	if (typeof doc.version === "string") {
		config.version = doc.version;
	}

	if (Array.isArray(doc.modules)) {
		for (const raw of doc.modules) {
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const entry = raw as Record<string, unknown>;
			config.modules.push({
				path: typeof entry.path === "string" ? entry.path : ".",
				name: typeof entry.name === "string" ? entry.name : "",
			});
		}
	}

	if (Array.isArray(doc.deps)) {
		for (const dep of doc.deps) {
			if (typeof dep === "string") {
				config.deps.push(dep);
			}
		}
	}

	const breaking = doc.breaking;
	if (breaking && typeof breaking === "object") {
		const use = (breaking as Record<string, unknown>).use;
		if (Array.isArray(use)) {
			config.breaking = {
				use: use.filter((item): item is string => typeof item === "string"),
			};
		}
	}

	return config;
}

/**
 * Parse `buf.yaml` text into absolute module roots. Thin re-export of the
 * module graph's parser so callers do not have to resolve paths themselves.
 */
export function readBufModuleRoots(content: string, dir: string): string[] {
	return parseBufYaml(content, dir).entries.map((entry) => entry.root);
}

/**
 * Every `--proto-path` in the workspace: each module's roots plus each
 * dependency's directory in the buf module cache.
 *
 * No subprocess and no temp directory. `buf export` used to produce this list
 * by compiling the module, which meant it returned nothing whenever the
 * workspace had a compile error — precisely when the linter is needed. Reading
 * `buf.lock` and pointing at `~/.cache/buf/v3/modules/b5/<name>/<commit>/files`
 * works regardless.
 *
 * Prefer `getBufProtoPathsForFile` where a file is known: this whole-workspace
 * list mixes roots from unrelated modules.
 */
export async function getBufProtoPaths(outputChannel?: {
	appendLine: (s: string) => void;
}): Promise<string[]> {
	const graph = await getModuleGraph(outputChannel);
	return [...graph.allProtoPaths()];
}

/**
 * The `--proto-path` list for one file: its own module's roots plus that
 * module's dependencies, and nothing else.
 */
export async function getBufProtoPathsForFile(
	absolutePath: string,
	outputChannel?: { appendLine: (s: string) => void },
): Promise<string[]> {
	const graph = await getModuleGraph(outputChannel);
	return [...graph.protoPathsFor(path.resolve(absolutePath))];
}

/**
 * Drop the cached module graph so the next resolution re-reads `buf.yaml`,
 * `buf.work.yaml` and `buf.lock`.
 */
export function invalidateBufProtoPathsCache(): void {
	invalidateModuleGraphCache();
}

/**
 * @deprecated No-op. `buf export` and its temp directories are gone; dependency
 * resolution now reads the buf module cache in place, so there is nothing to
 * clean up. Kept only so `extension.ts#deactivate` keeps compiling — the
 * integrator should delete the call and then this stub.
 */
export function cleanupAllBufTmpDirs(): void {
	// Intentionally empty.
}
