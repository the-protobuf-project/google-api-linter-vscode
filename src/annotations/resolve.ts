/**
 * Resolution helpers shared by the annotation providers.
 *
 * Three questions come up in every feature and none of them belong in a
 * provider:
 *
 * - **Which registry?** The index owns it, and the index may not exist yet. A
 *   provider must degrade to a no-op rather than build a scan of its own.
 * - **Which annotation is `(tool)`?** Option references are written the way
 *   protobuf allows them to be written — fully qualified, relative to the
 *   package, or with a leading dot — so a raw `get(fqn)` is not enough.
 * - **Can this file see the declaration?** protoc needs the extension in the
 *   file's *import closure*, not merely in a direct import, because
 *   `import public` re-exports are common in generated annotation bundles.
 *
 * This module must never import `vscode`: it is exercised directly on strings.
 */

import type { AnnotationDescriptor, ProtoIndex } from "../index/types";
import { analyzeProtoDocument, type ProtoDocumentModel } from "./document";
import type { DefinitionSite } from "./markdown";
import type { AnnotationRegistryImpl } from "./registry";

/**
 * Methods the providers need beyond the `AnnotationRegistry` contract. The
 * index hands back the interface; the providers need the implementation's lazy
 * body walker, so the value is probed structurally rather than with
 * `instanceof`, which would break the moment the index wraps or proxies it.
 */
const REQUIRED_METHODS = [
	"all",
	"get",
	"byTarget",
	"body",
	"collisions",
	"bodyAt",
	"fieldAt",
	"siteOf",
	"importsOf",
	"enumValues",
	"namespaces",
	"resolveEnumFqn",
	"resolveTypeFqn",
] as const;

/**
 * Pulls the annotation registry out of an index, if it exposes the full
 * implementation.
 * @param index - The workspace index, or undefined before it exists
 * @returns The registry, or undefined when annotation features must stay off
 */
export function annotationRegistryOf(
	index: ProtoIndex | undefined,
): AnnotationRegistryImpl | undefined {
	if (!index || typeof index.annotations !== "function") {
		return undefined;
	}
	let candidate: unknown;
	try {
		candidate = index.annotations();
	} catch {
		return undefined;
	}
	if (!candidate || typeof candidate !== "object") {
		return undefined;
	}
	const probe = candidate as Record<string, unknown>;
	for (const method of REQUIRED_METHODS) {
		if (typeof probe[method] !== "function") {
			return undefined;
		}
	}
	return candidate as AnnotationRegistryImpl;
}

/**
 * The registry, resolved lazily on every request.
 *
 * Providers are registered at activation, long before the index finishes its
 * first build, so they must never capture a registry reference. They hold one
 * of these instead and ask each time.
 */
export class AnnotationSource {
	constructor(
		private readonly index: ProtoIndex | undefined,
		private readonly fallback?: AnnotationRegistryImpl,
	) {}

	/**
	 * Current registry.
	 * @returns The registry, or undefined when there is none
	 */
	registry(): AnnotationRegistryImpl | undefined {
		return annotationRegistryOf(this.index) ?? this.fallback;
	}

	/**
	 * Whether anything has been indexed yet. Features that would produce false
	 * negatives on an empty registry — diagnostics above all — check this first.
	 * @returns True when at least one annotation is known
	 */
	ready(): boolean {
		const registry = this.registry();
		return registry !== undefined && registry.all().length > 0;
	}

	/**
	 * Subscribes to index rebuilds.
	 * @param listener - Called after the index changes contents
	 * @returns A disposable that unsubscribes
	 */
	onDidChange(listener: () => void): { dispose(): void } {
		return (
			this.index?.onDidChange(listener) ?? {
				dispose(): void {
					/* nothing to unsubscribe from */
				},
			}
		);
	}
}

/**
 * Resolves an option name as written to a known annotation.
 *
 * Applies protobuf's scoping rules in the order protoc does: an absolute name
 * first, then the enclosing package walked outwards, so `(tool)` inside
 * `package mcp.v1;` finds `mcp.v1.tool`.
 *
 * @param registry - The annotation registry
 * @param written - Dotted name exactly as it appears between the parentheses
 * @param packageName - Package of the file that wrote it
 * @returns The annotation, or undefined when nothing indexed matches
 */
export function resolveDescriptor(
	registry: AnnotationRegistryImpl,
	written: string,
	packageName: string,
): AnnotationDescriptor | undefined {
	const rooted = written.startsWith(".");
	const bare = rooted ? written.slice(1) : written;
	if (bare.length === 0) {
		return undefined;
	}
	const direct = registry.get(bare);
	if (direct) {
		return direct;
	}
	// A leading dot is protobuf's "from the root namespace": `.tool` names a
	// top-level `tool` and nothing else, so the scope walk below must not run.
	// Stripping the dot and walking anyway resolved `.tool` to `a.b.tool`,
	// which is the opposite of what the spelling asks for.
	//
	// Reaching this from a buffer additionally needs `analyzeProtoDocument` to
	// stop dropping the dot from `OptionReference.fqn`; today an author writing
	// `(.tool)` arrives here as `tool`, so this branch guards direct callers.
	if (rooted) {
		return undefined;
	}
	let scope = packageName;
	while (scope.length > 0) {
		const hit = registry.get(`${scope}.${bare}`);
		if (hit) {
			return hit;
		}
		const cut = scope.lastIndexOf(".");
		if (cut < 0) {
			break;
		}
		scope = scope.slice(0, cut);
	}
	return undefined;
}

/** Analysed buffers, keyed by document uri, newest last. */
const modelCache = new Map<
	string,
	{ version: number; model: ProtoDocumentModel }
>();

/** How many buffers stay analysed. Small: a keystroke invalidates the entry anyway. */
const MODEL_CACHE_SIZE = 8;

/**
 * Analyses a buffer, reusing the previous result while its version is unchanged.
 *
 * Four features ask about the same keystroke — semantic tokens, hover,
 * completion and diagnostics all run against one edit — and the scan is the
 * only non-trivial cost in any of them.
 *
 * @param key - Stable document identity, normally its uri string
 * @param version - Buffer version; any change discards the cached model
 * @param text - Full buffer contents
 * @returns The structural model
 */
export function analyzeCached(
	key: string,
	version: number,
	text: string,
): ProtoDocumentModel {
	const hit = modelCache.get(key);
	if (hit && hit.version === version) {
		return hit.model;
	}
	const model = analyzeProtoDocument(text);
	modelCache.delete(key);
	modelCache.set(key, { version, model });
	while (modelCache.size > MODEL_CACHE_SIZE) {
		const oldest = modelCache.keys().next();
		if (oldest.done) {
			break;
		}
		modelCache.delete(oldest.value);
	}
	return model;
}

/**
 * Drops a buffer's cached analysis.
 * @param key - Document identity previously passed to {@link analyzeCached}
 */
export function forgetAnalysis(key: string): void {
	modelCache.delete(key);
}

/** A file's transitive import set, and whether it could be computed in full. */
export interface ImportClosure {
	/** Every import path reachable from the file, transitively. */
	readonly paths: ReadonlySet<string>;
	/**
	 * False when an import was hit that the registry has never scanned. A partial
	 * closure can prove an import is *present*, never that one is *absent*, so
	 * every "missing import" judgement must check this flag first.
	 */
	readonly complete: boolean;
}

/**
 * Walks a file's imports transitively through the registry.
 * @param registry - The annotation registry, which remembers each scanned file's imports
 * @param imports - Import paths written by the file itself
 * @param limit - Hard ceiling on visited files
 * @returns The reachable set and whether it is authoritative
 */
export function importClosure(
	registry: AnnotationRegistryImpl,
	imports: readonly string[],
	limit = 1024,
): ImportClosure {
	const seen = new Set<string>();
	const queue: string[] = [...imports];
	let complete = true;
	while (queue.length > 0 && seen.size < limit) {
		const path = queue.pop();
		if (path === undefined || seen.has(path)) {
			continue;
		}
		seen.add(path);
		const next = registry.importsOf(path);
		if (!next) {
			complete = false;
			continue;
		}
		for (const child of next) {
			if (!seen.has(child)) {
				queue.push(child);
			}
		}
	}
	return { paths: seen, complete: complete && queue.length === 0 };
}

/**
 * Declaration site of an annotation, for the "defined in" footer.
 * @param registry - The annotation registry
 * @param descriptor - The annotation
 * @returns Its import path, absolute path and line
 */
export function definitionSite(
	registry: AnnotationRegistryImpl,
	descriptor: AnnotationDescriptor,
): DefinitionSite {
	const origin = registry.siteOf(descriptor);
	return {
		importPath: origin?.importPath ?? descriptor.importPath,
		path: origin?.path,
		line: descriptor.line,
	};
}

/**
 * Known namespace that an unresolved name was probably reaching for.
 * @param registry - The annotation registry
 * @param written - The name as written
 * @returns The longest known namespace that prefixes the name, if any
 */
export function knownNamespaceFor(
	registry: AnnotationRegistryImpl,
	written: string,
): string | undefined {
	let best: string | undefined;
	for (const namespace of registry.namespaces()) {
		if (
			written.startsWith(`${namespace}.`) &&
			(best === undefined || namespace.length > best.length)
		) {
			best = namespace;
		}
	}
	return best;
}

/**
 * Nearest known annotation to a misspelled one, for a "did you mean" hint.
 *
 * Restricted to a single namespace and to small edit distances, so a genuinely
 * absent annotation produces no suggestion rather than a misleading one.
 *
 * @param registry - The annotation registry
 * @param written - The name as written
 * @param namespace - Namespace to search within
 * @returns The suggested fully-qualified name, or undefined
 */
export function suggestAnnotation(
	registry: AnnotationRegistryImpl,
	written: string,
	namespace: string,
): string | undefined {
	const leaf = written.slice(namespace.length + 1);
	const budget = leaf.length <= 4 ? 1 : leaf.length <= 8 ? 2 : 3;
	let best: string | undefined;
	let bestScore = budget + 1;
	for (const descriptor of registry.all()) {
		if (descriptor.namespace !== namespace) {
			continue;
		}
		const score = editDistance(leaf, descriptor.name, bestScore);
		if (score < bestScore) {
			bestScore = score;
			best = descriptor.fqn;
		}
	}
	return best;
}

/**
 * Bounded Levenshtein distance.
 * @param a - First string
 * @param b - Second string
 * @param cap - Stop once the distance is known to reach this
 * @returns The distance, or `cap` when it is at least that large
 */
function editDistance(a: string, b: string, cap: number): number {
	if (Math.abs(a.length - b.length) >= cap) {
		return cap;
	}
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(
				previous[j] + 1,
				row[j - 1] + 1,
				previous[j - 1] + cost,
			);
			row.push(value);
			rowMin = Math.min(rowMin, value);
		}
		if (rowMin >= cap) {
			return cap;
		}
		previous = row;
	}
	return Math.min(previous[b.length], cap);
}
