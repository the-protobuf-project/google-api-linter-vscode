/**
 * Fills an {@link AnnotationRegistryImpl} from proto import roots using node
 * `fs`.
 *
 * Two callers:
 *
 * 1. The extension, for roots the symbol index does not walk — chiefly the buf
 *    module cache, where the `mcp.v1`, `cache.v1`, `store.v1`, `orm.v1` … option
 *    definitions actually live.
 * 2. The verification script, which runs this outside the extension host.
 *
 * `vscode.workspace.openTextDocument` appears nowhere here, and must not: opening
 * one document per proto is the leak this whole effort exists to remove. Files are
 * read with `fs.promises.readFile`, parsed, and the text is dropped immediately.
 *
 * This module must never import `vscode`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractAnnotations } from "./extractor";
import type { AnnotationRegistryImpl } from "./registry";

/** Directory names never worth walking for annotation definitions. */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"out",
	"dist",
	"build",
	"vendor",
	".vscode-test",
]);

/** Bounds on a scan, so a mis-pointed root cannot run away with the host. */
export interface ScanOptions {
	/** Hard ceiling on files read. Default 20000. */
	readonly maxFiles?: number;
	/** Files read concurrently. Default 32. */
	readonly concurrency?: number;
	/** First file id to hand out. Defaults to 0. */
	readonly startFileId?: number;
	/** Aborts the scan between files when it returns true. */
	readonly isCancelled?: () => boolean;
}

/** What a scan actually did. */
export interface ScanResult {
	readonly roots: number;
	readonly files: number;
	readonly bytes: number;
	readonly durationMs: number;
	/** Next unused file id, so callers can chain scans. */
	readonly nextFileId: number;
	/** True when {@link ScanOptions.maxFiles} cut the scan short. */
	readonly truncated: boolean;
}

/**
 * Lists every `.proto` file under a directory.
 * @param root - Absolute directory to walk
 * @param limit - Stop once this many files have been collected
 * @returns Absolute paths, in directory order
 */
export async function listProtoFiles(
	root: string,
	limit = Number.POSITIVE_INFINITY,
): Promise<string[]> {
	const out: string[] = [];
	const queue: string[] = [root];
	while (queue.length > 0 && out.length < limit) {
		const dir = queue.pop();
		if (dir === undefined) {
			break;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) {
					queue.push(path.join(dir, entry.name));
				}
			} else if (entry.isFile() && entry.name.endsWith(".proto")) {
				out.push(path.join(dir, entry.name));
				if (out.length >= limit) {
					break;
				}
			}
		}
	}
	return out;
}

/**
 * Reads every `.proto` under each root and feeds the registry.
 *
 * A file's import path is its path relative to the root it was found under,
 * which is precisely the string other protos must write in an `import`
 * statement — so the registry can tell a file it is missing one.
 *
 * @param roots - Absolute proto import roots, e.g. buf module cache `files` dirs
 * @param registry - Registry to populate; not cleared first
 * @param options - Bounds and cancellation
 * @returns Counts and timing for the scan
 */
export async function scanRootsInto(
	roots: readonly string[],
	registry: AnnotationRegistryImpl,
	options: ScanOptions = {},
): Promise<ScanResult> {
	const maxFiles = options.maxFiles ?? 20000;
	const concurrency = Math.max(1, options.concurrency ?? 32);
	const started = Date.now();
	let fileId = options.startFileId ?? 0;
	let files = 0;
	let bytes = 0;
	let truncated = false;
	let scannedRoots = 0;

	for (const root of roots) {
		if (options.isCancelled?.()) {
			break;
		}
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(root);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) {
			continue;
		}
		scannedRoots++;

		const remaining = maxFiles - files;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const found = await listProtoFiles(root, remaining);
		if (found.length >= remaining) {
			truncated = true;
		}

		for (let i = 0; i < found.length; i += concurrency) {
			if (options.isCancelled?.()) {
				break;
			}
			const batch = found.slice(i, i + concurrency);
			const texts = await Promise.all(
				batch.map(async (file) => {
					try {
						return await fs.promises.readFile(file, "utf8");
					} catch {
						return undefined;
					}
				}),
			);
			for (let j = 0; j < batch.length; j++) {
				const text = texts[j];
				if (text === undefined) {
					continue;
				}
				bytes += text.length;
				files++;
				registry.ingest(
					extractAnnotations(text, {
						fileId: fileId++,
						importPath: toImportPath(root, batch[j]),
						path: batch[j],
					}),
				);
			}
		}
	}

	return {
		roots: scannedRoots,
		files,
		bytes,
		durationMs: Date.now() - started,
		nextFileId: fileId,
		truncated,
	};
}

/**
 * Converts an absolute file path into the import path protos must write.
 * @param root - The import root the file was found under
 * @param file - Absolute file path
 * @returns Forward-slashed path relative to the root
 */
export function toImportPath(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Expands a buf module cache directory into its per-module `files` roots.
 *
 * The layout is `<cache>/<org>/<module>/<commit>/files`, and each `files`
 * directory is an import root in its own right.
 *
 * @param cacheDir - Usually `~/.cache/buf/v3/modules/b5/buf.build`
 * @returns Absolute import roots, empty when the cache is absent
 */
export async function bufCacheRoots(cacheDir: string): Promise<string[]> {
	const roots: string[] = [];
	const readDirs = async (dir: string): Promise<string[]> => {
		try {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(dir, entry.name));
		} catch {
			return [];
		}
	};

	for (const org of await readDirs(cacheDir)) {
		for (const module of await readDirs(org)) {
			for (const commit of await readDirs(module)) {
				const files = path.join(commit, "files");
				try {
					if ((await fs.promises.stat(files)).isDirectory()) {
						roots.push(files);
					}
				} catch {
					// Commit without an unpacked `files` dir; nothing to scan.
				}
			}
		}
	}
	return roots;
}
