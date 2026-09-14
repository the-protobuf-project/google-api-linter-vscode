/**
 * Directory walking for the proto index.
 *
 * Plain node `fs` only. Nothing here may import `vscode`: opening one
 * `TextDocument` per proto is what grew the extension host to ~60 GB on a
 * 9,280-file workspace, and VS Code offers no API to close them again.
 *
 * The walk is also the pre-flight pass for the memory ladder: it returns file
 * count and total bytes *before* a single file is read, so the starting
 * {@link IndexTier} is chosen from measurements rather than hope.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { flattenString } from "./strings";

/** Directory names never worth walking. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"out",
	"dist",
	"build",
	"vendor",
	".vscode-test",
	".next",
	"coverage",
]);

/** Directories listed concurrently. */
const WALK_CONCURRENCY = 32;
/** Files stat-ed concurrently. */
const STAT_BATCH = 64;

/** One `.proto` found on disk, with the stat the index needs anyway. */
export interface WalkedFile {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
}

/** Bounds and cancellation for a walk. */
export interface WalkOptions {
	/** Hard ceiling on files listed. The walk stops once it is reached. */
	readonly maxFiles?: number;
	/** Aborts the walk between directories when it returns true. */
	readonly isCancelled?: () => boolean;
}

/** What the walk found. */
export interface WalkResult {
	readonly files: WalkedFile[];
	readonly bytes: number;
	/** True when {@link WalkOptions.maxFiles} cut the listing short. */
	readonly truncated: boolean;
}

/**
 * Lists every `.proto` under the given roots, deduplicated across overlapping
 * roots, with size and mtime.
 *
 * @param roots - Absolute directories to walk
 * @param options - Bounds and cancellation
 * @returns Files, total bytes and whether the listing was truncated
 */
export async function walkProtoFiles(
	roots: readonly string[],
	options: WalkOptions = {},
): Promise<WalkResult> {
	const maxFiles = options.maxFiles ?? Number.MAX_SAFE_INTEGER;
	const seen = new Set<string>();
	const candidates: string[] = [];
	let truncated = false;

	// Phase 1: traverse directories, several `readdir` calls in flight at once.
	// Serialising them costs more than the reads that follow.
	const queue: string[] = roots.map((root) => path.resolve(root));
	while (queue.length > 0 && !truncated) {
		if (options.isCancelled?.()) {
			break;
		}
		const batch = queue.splice(0, WALK_CONCURRENCY);
		const listings = await Promise.all(
			batch.map(async (dir) => {
				try {
					return {
						dir,
						entries: await fs.promises.readdir(dir, { withFileTypes: true }),
					};
				} catch {
					return { dir, entries: [] as fs.Dirent[] };
				}
			}),
		);
		for (const { dir, entries } of listings) {
			for (const entry of entries) {
				const name = entry.name;
				if (entry.isDirectory()) {
					if (!SKIP_DIRS.has(name)) {
						queue.push(path.join(dir, name));
					}
					continue;
				}
				if (!entry.isFile() || !name.endsWith(".proto")) {
					continue;
				}
				const full = path.join(dir, name);
				if (seen.has(full)) {
					continue;
				}
				seen.add(full);
				candidates.push(flattenString(full));
				if (candidates.length >= maxFiles) {
					truncated = true;
					break;
				}
			}
			if (truncated) {
				break;
			}
		}
	}

	// Phase 2: stat in parallel. `mtimeMs` is needed per file anyway, and the
	// sizes are the pre-flight measurement the memory ladder chooses a tier from.
	const files: WalkedFile[] = [];
	let bytes = 0;
	for (let i = 0; i < candidates.length; i += STAT_BATCH) {
		if (options.isCancelled?.()) {
			break;
		}
		const stats = await Promise.all(
			candidates.slice(i, i + STAT_BATCH).map(async (file) => {
				try {
					return { file, stat: await fs.promises.stat(file) };
				} catch {
					return undefined;
				}
			}),
		);
		for (const entry of stats) {
			if (!entry) {
				continue;
			}
			files.push({
				path: entry.file,
				size: entry.stat.size,
				mtimeMs: entry.stat.mtimeMs,
			});
			bytes += entry.stat.size;
		}
	}

	return { files, bytes, truncated };
}

/**
 * Import path a file would be written as, relative to the first root that
 * contains it.
 *
 * @param roots - Absolute proto import roots
 * @param absolutePath - Absolute path to a `.proto`
 * @returns Forward-slashed relative path, or the basename when no root matches
 */
export function importPathFor(
	roots: readonly string[],
	absolutePath: string,
): string {
	let best: string | undefined;
	for (const root of roots) {
		const rel = path.relative(root, absolutePath);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			continue;
		}
		if (best === undefined || rel.length < best.length) {
			best = rel;
		}
	}
	const chosen = best ?? path.basename(absolutePath);
	return flattenString(chosen.split(path.sep).join("/"));
}
