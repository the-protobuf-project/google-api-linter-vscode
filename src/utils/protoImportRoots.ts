import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getProtoPaths, getProtoPathsForFile } from "./configReader";
import { invalidateModuleGraphCache } from "./moduleGraph";

/**
 * Call when buf.yaml, buf.work.yaml, buf.lock, or workspace protobuf config
 * changes so the module graph and editor roots refresh.
 */
export function invalidateProtoImportRootsCache(): void {
	invalidateModuleGraphCache();
}

/** Keep only directories that exist. Async — never stats on the event loop path. */
async function keepExistingDirs(
	candidates: readonly (string | undefined | null)[],
): Promise<string[]> {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) {
			continue;
		}
		seen.add(resolved);
		ordered.push(resolved);
	}
	const checked = await Promise.all(
		ordered.map(async (dir) => {
			try {
				return (await fsp.stat(dir)).isDirectory() ? dir : undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return checked.filter((dir): dir is string => dir !== undefined);
}

/**
 * The well-known `~/.gapi` directories, whichever of them exist.
 *
 * Exported because annotations have to be scanned out of them. The extension
 * downloads googleapis and protobuf here precisely so `import
 * "google/api/annotations.proto"` resolves, and the `extend` blocks that
 * declare `google.api.http`, `field_behavior` and `resource` live in those
 * files — so a workspace resolving its imports this way found no annotations at
 * all until this list reached the scanner.
 *
 * @returns Absolute directories that exist on disk
 */
export async function getGapiAnnotationRoots(): Promise<string[]> {
	return keepExistingDirs(gapiHomeRoots());
}

/** Well-known fallback locations for googleapis / protobuf checkouts. */
function gapiHomeRoots(): string[] {
	const home = os.homedir();
	return [
		path.join(home, ".gapi", "googleapis"),
		path.join(home, ".gapi", "protobuf", "src"),
		path.join(home, ".gapi", "protobuf"),
	];
}

/**
 * Directories used to resolve `import "…/file.proto"` for navigation
 * (definition, links, references scan).
 *
 * Merges workspace folders, `getProtoPaths` (workspace.protobuf.yaml + the
 * module graph's roots and buf cache dependencies), and ~/.gapi well-known dirs.
 */
export async function getProtoImportSearchRoots(
	outputChannel?: vscode.OutputChannel,
): Promise<string[]> {
	const candidates: (string | undefined)[] = [];

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		candidates.push(folder.uri.fsPath);
	}

	try {
		candidates.push(...(await getProtoPaths(outputChannel)));
	} catch {
		// ignore
	}

	candidates.push(...gapiHomeRoots());

	return keepExistingDirs(candidates);
}

/**
 * Import search roots scoped to one file: its own module's roots and
 * dependencies first, then its workspace folder and the ~/.gapi fallbacks.
 * Prefer this over `getProtoImportSearchRoots` whenever a file is in hand.
 */
export async function getProtoImportSearchRootsForFile(
	absolutePath: string,
	outputChannel?: vscode.OutputChannel,
): Promise<string[]> {
	const candidates: (string | undefined)[] = [];

	try {
		candidates.push(
			...(await getProtoPathsForFile(absolutePath, outputChannel)),
		);
	} catch {
		// ignore
	}

	const folder = vscode.workspace.getWorkspaceFolder(
		vscode.Uri.file(absolutePath),
	);
	candidates.push(folder?.uri.fsPath);
	candidates.push(...gapiHomeRoots());

	return keepExistingDirs(candidates);
}
