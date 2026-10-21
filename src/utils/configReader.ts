import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";
import { createGlobMatcher } from "./glob";
import { getModuleGraph } from "./moduleGraph";

/**
 * Configuration from workspace.protobuf.yaml
 */
export interface GapiConfig {
	protoPath: string;
	protoPaths: string[];
	/** Raw `exclude` globs, relative to the config file's own directory. */
	exclude: string[];
}

/**
 * Finds workspace.protobuf.yaml file in workspace (first match across all roots).
 */
export async function findGapiConfigFile(): Promise<vscode.Uri | null> {
	const files = await vscode.workspace.findFiles(
		"**/workspace.protobuf.yaml",
		"**/node_modules/**",
		1,
	);
	return files.length > 0 ? files[0] : null;
}

/**
 * Finds workspace.protobuf.yaml in a specific workspace folder (root of that folder).
 */
export async function findGapiConfigFileInFolder(
	folderUri: vscode.Uri,
): Promise<vscode.Uri | null> {
	const configPath = vscode.Uri.joinPath(folderUri, "workspace.protobuf.yaml");
	try {
		await vscode.workspace.fs.stat(configPath);
		return configPath;
	} catch {
		return null;
	}
}

/** Accept either a scalar or a list for `proto_path` / `proto_paths`. */
function collectPathValues(value: unknown, into: string[]): void {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) {
			into.push(trimmed);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectPathValues(item, into);
		}
	}
}

/**
 * Reads and parses workspace.protobuf.yaml configuration.
 *
 * Accepts `proto_path` and `proto_paths`, each as a scalar or a list. Paths are
 * resolved relative to the config file. Falls back to the config's own
 * directory when neither key is present.
 *
 * Also reads `exclude` (alias: `excluded_paths`), the globs naming folders and
 * files the linter should leave alone entirely.
 */
export async function readGapiConfig(
	configUri: vscode.Uri,
): Promise<GapiConfig | null> {
	try {
		const content = await vscode.workspace.fs.readFile(configUri);
		const text = Buffer.from(content).toString("utf8");
		const configDir = path.dirname(configUri.fsPath);

		let doc: Record<string, unknown> = {};
		const parsed = parseYaml(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			doc = parsed as Record<string, unknown>;
		}

		const relative: string[] = [];
		collectPathValues(doc.proto_paths, relative);
		collectPathValues(doc.proto_path, relative);

		const protoPaths: string[] = [];
		const seen = new Set<string>();
		for (const item of relative) {
			const resolved = path.resolve(configDir, item);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				protoPaths.push(resolved);
			}
		}

		if (protoPaths.length === 0) {
			// If no proto_path specified, use config directory
			protoPaths.push(configDir);
		}

		const exclude: string[] = [];
		collectPathValues(doc.exclude, exclude);
		collectPathValues(doc.excluded_paths, exclude);

		return {
			protoPath: protoPaths[0],
			protoPaths,
			exclude,
		};
	} catch (error) {
		console.error("Error reading workspace.protobuf.yaml:", error);
		return null;
	}
}

/** `workspace.protobuf.yaml` paths, when such a file exists. */
async function getGapiConfigProtoPaths(): Promise<string[]> {
	const configUri = await findGapiConfigFile();
	if (!configUri) {
		return [];
	}
	const config = await readGapiConfig(configUri);
	return config ? config.protoPaths : [];
}

function dedupeResolved(candidates: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			out.push(resolved);
		}
	}
	return out;
}

/**
 * Whole-workspace proto paths: `workspace.protobuf.yaml` entries, then every
 * module root and dependency cache directory in the module graph, then the
 * workspace root as a last resort.
 *
 * Prefer `getProtoPathsForFile` wherever the file is known — this list mixes
 * roots from every module in the workspace, which is exactly the bug that made
 * a file in one module resolve against another module's roots.
 */
export async function getProtoPaths(outputChannel?: {
	appendLine: (s: string) => void;
}): Promise<string[]> {
	const graph = await getModuleGraph(outputChannel);
	const allPaths = dedupeResolved([
		...(await getGapiConfigProtoPaths()),
		...graph.allProtoPaths(),
	]);

	if (allPaths.length === 0) {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			allPaths.push(workspaceRoot);
		}
	}

	return allPaths;
}

/**
 * Proto paths for one file: its own module's roots plus that module's
 * dependencies, with `workspace.protobuf.yaml` entries in front. Falls back to
 * the whole-workspace list when the file belongs to no module.
 */
export async function getProtoPathsForFile(
	absolutePath: string,
	outputChannel?: { appendLine: (s: string) => void },
): Promise<string[]> {
	const graph = await getModuleGraph(outputChannel);
	const modulePaths = graph.protoPathsFor(path.resolve(absolutePath));
	if (modulePaths.length === 0) {
		return getProtoPaths(outputChannel);
	}
	return dedupeResolved([...(await getGapiConfigProtoPaths()), ...modulePaths]);
}

/**
 * Which protos the linter should not touch at all, per `workspace.protobuf.yaml`.
 *
 * This is the blunt instrument, and deliberately so. `.api-linter.yaml` can
 * silence every rule for a path, but api-linter still parses those files and
 * still reports them as linted; `exclude` drops them before a process is ever
 * spawned, which is what you want for vendored or generated trees that are not
 * yours to fix.
 */
export interface ProtoExclusion {
	/** Directory the patterns are written relative to, or null when none apply. */
	root: string | null;
	/** Raw patterns, as written in the config. */
	patterns: string[];
	/** True when `absolutePath` is excluded from linting. */
	isExcluded(absolutePath: string): boolean;
}

/** An exclusion that excludes nothing, for workspaces with no config. */
const NO_EXCLUSION: ProtoExclusion = {
	root: null,
	patterns: [],
	isExcluded: () => false,
};

/**
 * Reads the workspace's `exclude` globs and compiles them into a predicate.
 *
 * Call this once per lint pass rather than once per file: it reads the config
 * from disk, and a workspace lint asks about thousands of files.
 */
export async function getProtoExclusion(): Promise<ProtoExclusion> {
	const configUri = await findGapiConfigFile();
	if (!configUri) {
		return NO_EXCLUSION;
	}
	const config = await readGapiConfig(configUri);
	if (!config || config.exclude.length === 0) {
		return NO_EXCLUSION;
	}

	const root = path.dirname(configUri.fsPath);
	const matcher = createGlobMatcher(config.exclude);
	const linked = excludedLinkTargets(root, matcher);
	return {
		root,
		patterns: config.exclude,
		isExcluded: (absolutePath: string) => {
			const relative = path.relative(root, path.resolve(absolutePath));
			// A file outside the config's own tree is not something these
			// workspace-relative patterns have any claim over -- unless it is
			// the far end of an excluded symlink.
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
				return linked.length > 0 && isUnder(realPath(absolutePath), linked);
			}
			return matcher(relative);
		},
	};
}

/**
 * The real directories behind the excluded symlinks at the top of `root`.
 *
 * Bazel leaves `bazel-bin`, `bazel-out` and friends there, each a symlink into
 * its cache, and tools that resolve links -- `buf` among them -- report a proto
 * under them by its real path. That path no longer contains `bazel-bin`, so no
 * pattern can match it; what can is knowing that the link was excluded and
 * where it leads. Only the top level is read: that is where build tools put
 * their links, and walking a tree for links would cost every lint pass.
 *
 * @param root - The config's directory
 * @param matcher - The compiled `exclude` patterns
 * @returns Real paths of the directories excluded symlinks point at
 */
function excludedLinkTargets(
	root: string,
	matcher: (relativePath: string) => boolean,
): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const targets: string[] = [];
	for (const entry of entries) {
		// A probe beneath the link stands for "anything under it", since a
		// pattern like `bazel-*/**` matches the contents, not the link itself.
		if (!entry.isSymbolicLink() || !matcher(`${entry.name}/x.proto`)) {
			continue;
		}
		const target = realPath(path.join(root, entry.name));
		try {
			if (fs.statSync(target).isDirectory()) {
				targets.push(target);
			}
		} catch {
			// A dangling link leads nowhere a proto could be reported from.
		}
	}
	return targets;
}

/** `file` with every symlink resolved, or as given when it cannot be. */
function realPath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

/** True when `file` is one of `dirs` or lies beneath one. */
function isUnder(file: string, dirs: readonly string[]): boolean {
	return dirs.some((dir) => {
		const relative = path.relative(dir, file);
		return !relative.startsWith("..") && !path.isAbsolute(relative);
	});
}
