/**
 * Turning protocol values into the strings a reader sees.
 *
 * Every location on the wire is zero-based, matching `vscode.Position`; every
 * location on screen is one-based, matching the editor's gutter. The
 * conversion lives here so no component has to remember which side it is on.
 */

import type { Loc } from "../../shared/protocol";

/** How many scattered lines are named before the rest become a count. */
const MAX_LISTED_LINES = 4;

/**
 * The last segment of a path, splitting on both separators.
 *
 * `node:path` does not exist in a webview and the host sends whatever its
 * platform uses, so a Windows payload must not come out as one long name.
 *
 * @param filePath - Absolute path as the host sent it
 */
export function baseName(filePath: string): string {
	const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	return cut === -1 ? filePath : filePath.slice(cut + 1);
}

/**
 * A path short enough for a 300px panel: the last two segments, usually
 * `v1/library.proto`.
 *
 * The absolute path is machine-specific noise that would push every other
 * column off-screen, while the bare file name cannot tell `v1/library.proto`
 * from `v2/library.proto`. Callers put the full path in a `title`.
 *
 * @param filePath - Absolute path as the host sent it
 */
export function shortPath(filePath: string): string {
	const parts = filePath.split(/[/\\]/).filter((part) => part.length > 0);
	return parts.slice(-2).join("/") || filePath;
}

/** A location as `v1/library.proto:48`, with the line one-based. */
export function formatLoc(loc: Loc): string {
	return `${shortPath(loc.path)}:${loc.line + 1}`;
}

/** The same location unabbreviated, for a tooltip. */
export function fullLoc(loc: Loc): string {
	return `${loc.path}:${loc.line + 1}`;
}

/**
 * The line span a collapsed finding covers, one-based.
 *
 * A contiguous run becomes `lines 54-58`. A scattered one is listed instead,
 * because `54-58` would claim five findings where there are two.
 *
 * @param lines - Zero-based lines, ascending, as {@link ProblemDetail.lines}
 * @returns The rendered span, or `undefined` when there is nothing to show
 */
export function formatLines(lines: readonly number[]): string | undefined {
	if (lines.length === 0) {
		return undefined;
	}
	const first = lines[0] + 1;
	const last = lines[lines.length - 1] + 1;
	if (lines.length === 1) {
		return `line ${first}`;
	}
	if (last - first + 1 === lines.length) {
		return `lines ${first}-${last}`;
	}
	const listed = lines
		.slice(0, MAX_LISTED_LINES)
		.map((line) => line + 1)
		.join(", ");
	const hidden = lines.length - MAX_LISTED_LINES;
	return hidden > 0 ? `lines ${listed}, +${hidden}` : `lines ${listed}`;
}

/** `1 problem` / `4 problems`, so the header never reads `1 problems`. */
export function countLabel(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * An RPC signature as `stream Request -> stream Response`.
 *
 * The arrow is rendered by the caller; streaming is folded into the type names
 * because that is where protobuf itself writes it.
 */
export function streamed(type: string, streaming: boolean): string {
	return streaming ? `stream ${type}` : type;
}
