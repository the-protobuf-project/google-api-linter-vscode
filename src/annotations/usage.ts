/**
 * Which annotations the workspace actually *applies*.
 *
 * The registry answers a different question: what options *exist* anywhere the
 * scanner reached. On any workspace that reaches googleapis or a populated buf
 * module cache that is dozens of options the project never mentions —
 * `~/.gapi/googleapis/google/api` alone declares about nineteen — so labelling
 * the Proto view's Annotations section with `registry.all().length` counts
 * other people's vocabulary as if it were the project's.
 *
 * The two facts live in different places and only text connects them. An
 * annotation is *declared* by an `extend google.protobuf.*Options` block, which
 * is what the registry holds; it is *used* when some file writes
 * `option (fqn) = …` or `[(fqn) = …]`, which nothing in the index records.
 * So this module re-reads workspace protos and matches applied names back
 * against declared descriptors.
 *
 * Two constraints shape how that text is read:
 *
 *  1. Files are read through node `fs`, never `vscode.workspace.openTextDocument`.
 *     One open document per proto is what grew the extension host to ~60 GB on
 *     a 9,280-file workspace, and VS Code offers no API to release them again.
 *  2. The scan is string-aware before it is anything else. See {@link maskNonCode}.
 *
 * This module must never import `vscode`.
 */

import * as fs from "node:fs";
import { flattenString } from "../index/strings";
import type {
	AnnotationDescriptor,
	AnnotationRegistry,
	ProtoIndex,
} from "../index/types";

/**
 * First file id the index hands to roots outside the workspace walk — the buf
 * module cache and `~/.gapi/googleapis`. It mirrors `EXTERNAL_FILE_ID_BASE` in
 * `src/index/protoIndex.ts`, which does not export it.
 *
 * Ids at or above this describe someone else's module. googleapis applies
 * `google.api.http` in nearly every service it ships, so counting those files
 * would report googleapis as the user of its own annotations and put the
 * section right back where it started.
 */
const EXTERNAL_FILE_ID_BASE = 1_000_000;

/** Files read concurrently, matching the pool the index build uses. */
const READ_CONCURRENCY = 32;

/**
 * An applied option: a parenthesised, possibly qualified name being assigned to.
 *
 * The trailing `=` is what separates a use from every other parenthesised name
 * in a `.proto`. `rpc Get(GetRequest) returns (Book)` parenthesises two type
 * names and assigns to neither, so requiring the assignment keeps request and
 * response types out of the tally without needing a real parse. The optional
 * dotted tail is for `option (foo.bar).baz = 1`, where the option applied is
 * still `foo.bar`.
 */
const RE_APPLIED = /\(\s*(\.?[A-Za-z_][\w.]*)\s*\)\s*(?:\.[\w.]+\s*)?=/g;

/** One annotation the workspace applies, and where. */
export interface AnnotationUsage {
	readonly fqn: string;
	readonly descriptor: AnnotationDescriptor;
	/** Total applications across the workspace, not files touched. */
	readonly count: number;
	/** Workspace files applying it, ascending. Never external ids. */
	readonly fileIds: readonly number[];
}

/** Options bounding the scan. */
export interface UsageOptions {
	/** Abandons the scan between files when it returns true. */
	readonly isCancelled?: () => boolean;
	/** Hard ceiling on workspace files read. */
	readonly maxFiles?: number;
	/**
	 * Reads a file's text, resolving to undefined when it cannot be read.
	 * Injected so tests need no disk; defaults to node `fs`.
	 */
	readonly readFile?: (absolutePath: string) => Promise<string | undefined>;
}

/** Mutable tally, collapsed into an {@link AnnotationUsage} at the end. */
interface Tally {
	readonly descriptor: AnnotationDescriptor;
	count: number;
	/** A set, because two spellings in one file resolve to one descriptor. */
	readonly fileIds: Set<number>;
}

/**
 * Blanks comments and string literals, leaving the code between them.
 *
 * Doing this with `indexOf` is the trap. An AIP path template is written with
 * wildcard segments — think `users` followed by a slash and a star, inside the
 * quoted value of a `google.api.http` option — so a raw search finds a
 * block-comment opener that is not one, never finds its closer, and blanks the
 * rest of the file. Every annotation applied below the first HTTP rule then
 * disappears. `src/index/parser.ts` carries the same defence in
 * `blockCommentAt` for the same reason: there, the symptom was a service with
 * five RPCs reporting one.
 *
 * (This comment spells those characters out rather than quoting them: writing
 * the example literally would close this block early.)
 *
 * Each masked region collapses to a single space, so offsets in the result do
 * not correspond to offsets in the input. Nothing here needs them — only the
 * names survive — and preserving them would mean allocating padding for every
 * doc comment in the file.
 *
 * @param text - Full `.proto` contents
 * @returns The same text with comment and string-literal content removed
 */
function maskNonCode(text: string): string {
	let out = "";
	let kept = 0;
	let i = 0;

	while (i < text.length) {
		const ch = text.charCodeAt(i);

		if (ch === 34 /* " */ || ch === 39 /* ' */) {
			out += text.slice(kept, i);
			i++;
			while (i < text.length) {
				const inner = text.charCodeAt(i);
				if (inner === 92 /* \ */) {
					i += 2;
					continue;
				}
				i++;
				// A proto string never spans a line, so stopping at the newline
				// keeps one stray quote from swallowing the rest of the file.
				if (inner === ch || inner === 10 /* \n */) {
					break;
				}
			}
			kept = i;
			out += " ";
			continue;
		}

		if (ch === 47 /* / */) {
			const next = text.charCodeAt(i + 1);
			if (next === 47 /* / */) {
				out += text.slice(kept, i);
				const end = text.indexOf("\n", i + 2);
				i = end < 0 ? text.length : end;
				kept = i;
				out += " ";
				continue;
			}
			if (next === 42 /* * */) {
				out += text.slice(kept, i);
				const end = text.indexOf("*/", i + 2);
				i = end < 0 ? text.length : end + 2;
				kept = i;
				out += " ";
				continue;
			}
		}

		i++;
	}

	return out + text.slice(kept);
}

/**
 * Applied option names in one file's text, with how often each is applied.
 *
 * Pure: it knows nothing about the registry, so an unknown name is returned
 * like any other and the caller decides whether it names a real annotation.
 * Names are returned as written minus protobuf's optional leading dot, which
 * spells the same extension.
 *
 * @param text - Full `.proto` contents
 * @returns Option name to application count
 */
export function appliedOptionsIn(text: string): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	// Most protos apply nothing at all; this skips masking their whole text.
	if (!text.includes("(")) {
		return counts;
	}
	const code = maskNonCode(text);
	// `matchAll` rather than `exec`: it iterates a clone, so the module-level
	// regex never carries a `lastIndex` from one file into the next.
	for (const match of code.matchAll(RE_APPLIED)) {
		const written = match[1];
		const name =
			written.charCodeAt(0) === 46 /* . */ ? written.slice(1) : written;
		// The capture is a slice of the whole masked file; storing it unflattened
		// would keep that file alive for as long as the tally is held.
		const fqn = flattenString(name);
		counts.set(fqn, (counts.get(fqn) ?? 0) + 1);
	}
	return counts;
}

/**
 * Matches an applied option name to the annotation it names.
 *
 * Nearly every use writes the fully-qualified name, which is one map hit. The
 * fallback is for a file applying an option declared in its own package and
 * writing the short form, which protobuf resolves innermost-scope first — so
 * the walk goes outwards through the enclosing packages, exactly as
 * `AnnotationRegistryImpl.resolveTypeFqn` does for body message types.
 *
 * @param registry - Declared annotations
 * @param written - Option name as applied, leading dot already removed
 * @param packageName - Package of the file that applied it
 * @returns The declared annotation, or undefined when none matches
 */
function resolveApplied(
	registry: AnnotationRegistry,
	written: string,
	packageName: string,
): AnnotationDescriptor | undefined {
	const exact = registry.get(written);
	if (exact) {
		return exact;
	}
	let scope = packageName;
	while (scope.length > 0) {
		const found = registry.get(`${scope}.${written}`);
		if (found) {
			return found;
		}
		const cut = scope.lastIndexOf(".");
		if (cut < 0) {
			break;
		}
		scope = scope.slice(0, cut);
	}
	return undefined;
}

/**
 * Reads a file, treating every failure as "contributes nothing".
 * @param absolutePath - Path to a `.proto`
 * @returns Its text, or undefined when it could not be read
 */
async function readFromDisk(absolutePath: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(absolutePath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Every annotation a workspace file applies, with counts and applying files.
 *
 * Only workspace files are read: {@link ProtoIndex.files} also carries the ids
 * the annotation scanner assigned to external roots, and those belong to the
 * modules that *declare* the vocabulary. A declared annotation nobody applies
 * is absent from the result rather than present with a zero count — the caller
 * is labelling a section, and an empty result means the section is empty.
 *
 * @param index - A built index; its registry supplies the declarations
 * @param options - Bounds, cancellation and an injectable reader
 * @returns Applied annotations, ordered by fully-qualified name
 */
export async function collectAnnotationUsage(
	index: ProtoIndex,
	options: UsageOptions = {},
): Promise<readonly AnnotationUsage[]> {
	const registry = index.annotations();
	// Nothing declared means nothing can be applied, so reading the workspace
	// would be pure cost. protobuf-fhir is a workspace of exactly this shape.
	if (registry.all().length === 0) {
		return [];
	}

	const files = index.files().filter((file) => file.id < EXTERNAL_FILE_ID_BASE);
	const limit = Math.min(files.length, options.maxFiles ?? files.length);
	const read = options.readFile ?? readFromDisk;
	const tallies = new Map<string, Tally>();

	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= limit || options.isCancelled?.()) {
				return;
			}
			const file = files[i];
			let text: string | undefined;
			try {
				text = await read(file.path);
			} catch {
				// An injected reader may reject where `fs` would resolve; either
				// way one unreadable file must not lose the other 9,279.
				continue;
			}
			if (text === undefined) {
				continue;
			}
			for (const [written, count] of appliedOptionsIn(text)) {
				const descriptor = resolveApplied(registry, written, file.packageName);
				if (!descriptor) {
					continue;
				}
				const tally = tallies.get(descriptor.fqn);
				if (tally) {
					tally.count += count;
					tally.fileIds.add(file.id);
				} else {
					tallies.set(descriptor.fqn, {
						descriptor,
						count,
						fileIds: new Set([file.id]),
					});
				}
			}
			// `text` goes out of scope here; nothing above retains a slice of it.
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(READ_CONCURRENCY, limit) }, worker),
	);

	// Sorted, and file ids sorted within each entry: the workers finish in
	// whatever order the disk hands them back, and a tree that reorders itself
	// between refreshes reads as a bug.
	return [...tallies.values()]
		.map((tally) => ({
			fqn: tally.descriptor.fqn,
			descriptor: tally.descriptor,
			count: tally.count,
			fileIds: [...tally.fileIds].sort((a, b) => a - b),
		}))
		.sort((a, b) => (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0));
}
