/**
 * Shared fixtures: a fake `TextDocument`, and registries built from real protos.
 *
 * Two rules keep these tests honest.
 *
 * **Real inputs where it matters.** The reference repo next door has 9,280
 * generated protos and a populated buf module cache; assertions about
 * annotations, enums and package versions run against those rather than against
 * a hand-written proto that happens to suit the assertion. A fixture string is
 * for pinning one behaviour, not for standing in as the corpus.
 *
 * **Scan once.** Building a registry from the reference repo takes ~600 ms, so
 * it is cached per process and shared by every test that asks for it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TextDocument } from "vscode";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import { bufCacheRoots, scanRootsInto } from "../../../annotations/scan";
import { Position, Range, Uri } from "./vscode";

/** Repo root of the extension itself. */
export const EXTENSION_ROOT = path.resolve(__dirname, "../../../..");

/**
 * The protobuf-fhir checkout this extension is developed against, or undefined
 * when the extension is checked out on its own.
 */
export const REFERENCE_PROTO_ROOT: string | undefined = (() => {
	const candidate = path.resolve(EXTENSION_ROOT, "..", "protobuf");
	try {
		return fs.statSync(candidate).isDirectory() ? candidate : undefined;
	} catch {
		return undefined;
	}
})();

/** Absolute path to the buf module cache, whether or not it exists. */
export const BUF_CACHE_ROOT = path.join(
	os.homedir(),
	".cache/buf/v3/modules/b5/buf.build",
);

let documentSeq = 0;

/**
 * A `TextDocument` good enough for a provider under test.
 *
 * Each call gets a distinct uri by default: the providers cache their parsed
 * model on `uri` + `version`, so reusing one across fixtures silently serves
 * the first fixture's model to every later test — a mistake that makes
 * unrelated assertions fail in confusing ways.
 *
 * @param text - Buffer contents
 * @param uri - Override the generated uri, when a test needs a specific path
 * @returns A document backed by `text`
 */
export function makeDocument(text: string, uri?: string): TextDocument {
	const lines = text.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		lineStarts.push(offset);
		offset += line.length + 1;
	}
	const resolved = uri ?? `/virtual/test-${documentSeq++}.proto`;

	return {
		uri: Uri.file(resolved),
		fileName: resolved,
		languageId: "proto3",
		version: 1,
		lineCount: lines.length,
		getText: (range?: Range) => {
			if (!range) {
				return text;
			}
			const from = lineStarts[range.start.line] + range.start.character;
			const to = lineStarts[range.end.line] + range.end.character;
			return text.slice(from, to);
		},
		lineAt: (lineOrPosition: number | Position) => {
			const line =
				typeof lineOrPosition === "number"
					? lineOrPosition
					: lineOrPosition.line;
			return {
				text: lines[line] ?? "",
				lineNumber: line,
				range: new Range(line, 0, line, (lines[line] ?? "").length),
				isEmptyOrWhitespace: (lines[line] ?? "").trim().length === 0,
			};
		},
		offsetAt: (position: Position) =>
			lineStarts[position.line] + position.character,
		positionAt: (target: number) => {
			let low = 0;
			let high = lines.length - 1;
			while (low < high) {
				const mid = (low + high + 1) >> 1;
				if (lineStarts[mid] <= target) {
					low = mid;
				} else {
					high = mid - 1;
				}
			}
			return new Position(low, target - lineStarts[low]);
		},
		getWordRangeAtPosition: () => undefined,
	} as unknown as TextDocument;
}

/**
 * Splits a fixture marked with `▮` into a document and the cursor position.
 *
 * Writing the cursor inline keeps a completion test readable: the assertion
 * sits next to the exact column it is about.
 *
 * @param marked - Proto source containing exactly one `▮`
 * @returns The document with the marker removed, and where it was
 */
export function atCursor(marked: string): {
	document: TextDocument;
	position: Position;
} {
	const at = marked.indexOf("▮");
	if (at < 0) {
		throw new Error("fixture has no ▮ cursor marker");
	}
	const text = marked.replace("▮", "");
	const before = text.slice(0, at).split("\n");
	return {
		document: makeDocument(text),
		position: new Position(before.length - 1, before[before.length - 1].length),
	};
}

let cachedRegistry: Promise<AnnotationRegistryImpl> | undefined;

/**
 * An annotation registry built from the reference repo and the buf module
 * cache, scanned once per process.
 *
 * @returns The shared registry
 */
export function referenceRegistry(): Promise<AnnotationRegistryImpl> {
	cachedRegistry ??= (async () => {
		const registry = new AnnotationRegistryImpl();
		const roots: string[] = [];
		if (REFERENCE_PROTO_ROOT) {
			roots.push(REFERENCE_PROTO_ROOT);
		}
		roots.push(...(await bufCacheRoots(BUF_CACHE_ROOT)));
		await scanRootsInto(roots, registry, { maxFiles: 30000 });
		return registry;
	})();
	return cachedRegistry;
}

/**
 * Whether the reference corpus is available.
 *
 * Tests that need it skip rather than fail when the extension is checked out
 * standalone — a missing sibling checkout is not a regression.
 *
 * @returns True when both the proto tree and the buf cache are present
 */
export function hasReferenceCorpus(): boolean {
	return REFERENCE_PROTO_ROOT !== undefined && fs.existsSync(BUF_CACHE_ROOT);
}

/** Every `.proto` under a directory, recursively. */
export function listProtos(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".proto")) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out;
}

/**
 * An absolute path that is absolute on Windows too.
 *
 * `path.join(path.sep, "synthetic", "protos")` yields `\\synthetic\\protos` on
 * Windows — rooted, but with no drive letter. Production code that calls
 * `path.resolve` on it gets `C:\\synthetic\\protos` back, which no longer equals
 * what the test built, so fifteen tests failed on `windows-latest` while
 * passing everywhere else. `path.resolve` qualifies the drive up front, and is
 * a no-op difference on POSIX.
 *
 * @param segments - Path segments below the filesystem root
 * @returns An absolute path valid on the host platform
 */
export function syntheticPath(...segments: string[]): string {
	return path.resolve(path.sep, ...segments);
}
