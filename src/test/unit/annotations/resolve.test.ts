/**
 * Tests for the resolution helpers every annotation provider shares.
 *
 * Four questions live here and none of them belong in a provider: which
 * registry is live right now, which annotation a name as written actually
 * means, whether a buffer can see the declaration at all, and whether the
 * buffer has already been analysed for this keystroke.
 *
 * Three of those have bitten before. The registry must be asked for on every
 * request, because providers are registered long before the index finishes its
 * first build. The analysis cache is keyed on uri plus version, which is what
 * makes a shared uri serve a stale model — the mistake `makeDocument` hands out
 * distinct uris to prevent. And an import closure computed from a registry that
 * has not scanned every file can prove an import *present* but never prove one
 * *absent*, so `complete` is asserted alongside `paths` throughout.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { analyzeProtoDocument } from "../../../annotations/document";
import { extractAnnotations } from "../../../annotations/extractor";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import {
	AnnotationSource,
	analyzeCached,
	annotationRegistryOf,
	definitionSite,
	forgetAnalysis,
	importClosure,
	knownNamespaceFor,
	resolveDescriptor,
	suggestAnnotation,
} from "../../../annotations/resolve";
import type { ProtoIndex } from "../../../index/types";
import {
	hasReferenceCorpus,
	listProtos,
	REFERENCE_PROTO_ROOT,
	referenceRegistry,
} from "../support/fixtures";

let nextFileId = 1;

/**
 * Builds a registry out of proto sources, one file at a time.
 * @param files - Import path and source text of each file to ingest
 * @returns A registry holding exactly those files
 */
function registryOf(
	...files: readonly { importPath: string; text: string }[]
): AnnotationRegistryImpl {
	const registry = new AnnotationRegistryImpl();
	for (const file of files) {
		registry.ingest(
			extractAnnotations(file.text, {
				fileId: nextFileId++,
				importPath: file.importPath,
				path: `/repo/${file.importPath}`,
			}),
		);
	}
	return registry;
}

/**
 * Source for a file that declares one annotation and imports nothing.
 * @param packageName - Package statement to write, or "" for none
 * @param name - Extension field name
 * @returns Proto source
 */
function declares(packageName: string, name: string): string {
	const header = packageName ? `package ${packageName};\n` : "";
	return `syntax = "proto3";
${header}extend google.protobuf.MessageOptions {
  optional string ${name} = 1;
}
`;
}

/**
 * Source for a file that only imports, for the closure walk.
 * @param paths - Import paths to write
 * @returns Proto source
 */
function imports(...paths: readonly string[]): string {
	return `syntax = "proto3";\n${paths
		.map((path) => `import "${path}";`)
		.join("\n")}\n`;
}

/** Methods `annotationRegistryOf` probes for, mirroring its own list. */
const REGISTRY_METHODS = [
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
	"enumMembers",
	"enumOf",
	"namespaces",
	"resolveEnumFqn",
	"resolveTypeFqn",
];

/**
 * An index whose `annotations()` returns whatever is handed to it.
 * @param annotations - Implementation of `annotations()`
 * @returns Something shaped enough like a `ProtoIndex` for these helpers
 */
function fakeIndex(annotations: () => unknown): ProtoIndex {
	return { annotations } as unknown as ProtoIndex;
}

describe("resolveDescriptor", () => {
	const registry = registryOf(
		{ importPath: "a/b/ann.proto", text: declares("a.b", "tool") },
		{ importPath: "a/ann.proto", text: declares("a", "outer") },
	);

	test("resolves a fully-qualified name from any package", () => {
		expect(resolveDescriptor(registry, "a.b.tool", "")?.fqn).toBe("a.b.tool");
		expect(resolveDescriptor(registry, "a.b.tool", "zz.yy")?.fqn).toBe(
			"a.b.tool",
		);
	});

	test("resolves a relative name against the file's own package", () => {
		expect(resolveDescriptor(registry, "tool", "a.b")?.fqn).toBe("a.b.tool");
	});

	test("walks the enclosing packages outwards", () => {
		// protoc tries `a.b.c.d.tool`, then `a.b.c.tool`, then `a.b.tool`.
		expect(resolveDescriptor(registry, "tool", "a.b.c.d")?.fqn).toBe(
			"a.b.tool",
		);
		expect(resolveDescriptor(registry, "outer", "a.b.c")?.fqn).toBe("a.outer");
	});

	test("resolves a partially-qualified name", () => {
		expect(resolveDescriptor(registry, "b.tool", "a")?.fqn).toBe("a.b.tool");
	});

	test("accepts a leading dot on a fully-qualified name", () => {
		expect(resolveDescriptor(registry, ".a.b.tool", "zz")?.fqn).toBe(
			"a.b.tool",
		);
	});

	test("resolves nothing a relative name cannot reach", () => {
		// `tool` lives in `a.b`; `a` and the root do not see it.
		expect(resolveDescriptor(registry, "tool", "a")).toBeUndefined();
		expect(resolveDescriptor(registry, "tool", "")).toBeUndefined();
	});

	test("matches names case-sensitively", () => {
		expect(resolveDescriptor(registry, "Tool", "a.b")).toBeUndefined();
	});

	test("returns undefined for an empty or dot-only name", () => {
		expect(resolveDescriptor(registry, "", "a.b")).toBeUndefined();
		expect(resolveDescriptor(registry, ".", "a.b")).toBeUndefined();
	});

	test("returns undefined for a name nothing declares", () => {
		expect(resolveDescriptor(registry, "a.b.nope", "a.b")).toBeUndefined();
	});
});

describe("analyzeCached", () => {
	test("returns the cached model while the version is unchanged", () => {
		// Keyed on version, not on text: the same key and version serve the first
		// model even when the text differs. This is the contract that makes a
		// shared uri in a test fixture silently serve a stale model.
		const first = analyzeCached("cache:same", 1, "message First {\n}\n");
		const second = analyzeCached("cache:same", 1, "message Second {\n}\n");
		expect(second).toBe(first);
		expect(second.blocks.map((b) => b.name)).toContain("First");
	});

	test("re-analyses when the version moves", () => {
		const first = analyzeCached("cache:bump", 1, "message First {\n}\n");
		const second = analyzeCached("cache:bump", 2, "message Second {\n}\n");
		expect(second).not.toBe(first);
		expect(second.blocks.map((b) => b.name)).toContain("Second");
	});

	test("keeps buffers apart by key", () => {
		const left = analyzeCached("cache:left", 1, "message Left {\n}\n");
		const right = analyzeCached("cache:right", 1, "message Right {\n}\n");
		expect(right).not.toBe(left);
		expect(analyzeCached("cache:left", 1, "")).toBe(left);
	});

	test("forgets a buffer on request", () => {
		const first = analyzeCached("cache:forget", 1, "message First {\n}\n");
		forgetAnalysis("cache:forget");
		const second = analyzeCached("cache:forget", 1, "message Second {\n}\n");
		expect(second).not.toBe(first);
		expect(second.blocks.map((b) => b.name)).toContain("Second");
	});

	test("forgetting an unknown key does nothing", () => {
		expect(() => {
			forgetAnalysis("cache:never-seen");
		}).not.toThrow();
	});

	test("holds eight buffers and drops the oldest past that", () => {
		// The documented cap. Eight distinct keys all stay resolvable; the ninth
		// evicts the first, which is fine because re-analysis is the only cost.
		const models = [];
		for (let i = 0; i < 8; i++) {
			models.push(analyzeCached(`cache:lru${i}`, 1, `message M${i} {\n}\n`));
		}
		for (let i = 0; i < 8; i++) {
			expect(analyzeCached(`cache:lru${i}`, 1, "")).toBe(models[i]);
		}
		analyzeCached("cache:lru8", 1, "message M8 {\n}\n");
		expect(analyzeCached("cache:lru0", 1, "message Fresh {\n}\n")).not.toBe(
			models[0],
		);
		expect(analyzeCached("cache:lru7", 1, "")).toBe(models[7]);
	});
});

describe("importClosure", () => {
	const registry = registryOf(
		{ importPath: "a.proto", text: imports("b.proto") },
		{ importPath: "b.proto", text: imports("c.proto") },
		{ importPath: "c.proto", text: 'syntax = "proto3";\n' },
		{ importPath: "loop1.proto", text: imports("loop2.proto") },
		{ importPath: "loop2.proto", text: imports("loop1.proto") },
	);

	test("reaches a file imported only transitively", () => {
		const closure = importClosure(registry, ["a.proto"]);
		expect([...closure.paths].sort()).toEqual([
			"a.proto",
			"b.proto",
			"c.proto",
		]);
		expect(closure.complete).toBe(true);
	});

	test("stays complete when a scanned file imports nothing", () => {
		// A file with no imports answers `[]`, which is not the same as never
		// having been scanned. Confusing the two would mark every closure partial.
		const closure = importClosure(registry, ["c.proto"]);
		expect([...closure.paths]).toEqual(["c.proto"]);
		expect(closure.complete).toBe(true);
	});

	test("reports incomplete when a link was never scanned", () => {
		const closure = importClosure(registry, ["unscanned.proto"]);
		// The path itself is still known to be imported — only what it pulls in is
		// unknown — so a "present" judgement stays safe.
		expect([...closure.paths]).toEqual(["unscanned.proto"]);
		expect(closure.complete).toBe(false);
	});

	test("does not let an incomplete closure imply an absence", () => {
		const closure = importClosure(registry, ["a.proto", "unscanned.proto"]);
		expect(closure.paths.has("c.proto")).toBe(true);
		expect(closure.paths.has("unscanned.proto")).toBe(true);
		// `c.proto` is provably reachable; anything missing from `paths` is not
		// provably unreachable, and `complete` is the flag that says so.
		expect(closure.complete).toBe(false);
	});

	test("terminates on an import cycle", () => {
		const closure = importClosure(registry, ["loop1.proto"]);
		expect([...closure.paths].sort()).toEqual(["loop1.proto", "loop2.proto"]);
		expect(closure.complete).toBe(true);
	});

	test("returns an empty complete closure for a file with no imports", () => {
		const closure = importClosure(registry, []);
		expect(closure.paths.size).toBe(0);
		expect(closure.complete).toBe(true);
	});

	test("stops at the visit limit and says so", () => {
		const stopped = importClosure(registry, ["a.proto"], 2);
		expect(stopped.paths.size).toBe(2);
		expect(stopped.complete).toBe(false);
		// A limit that exactly covers the closure is not a truncation.
		const exact = importClosure(registry, ["a.proto"], 3);
		expect(exact.paths.size).toBe(3);
		expect(exact.complete).toBe(true);
	});

	test("ignores a repeated import", () => {
		const closure = importClosure(registry, ["a.proto", "a.proto", "b.proto"]);
		expect([...closure.paths].sort()).toEqual([
			"a.proto",
			"b.proto",
			"c.proto",
		]);
		expect(closure.complete).toBe(true);
	});
});

describe("definitionSite", () => {
	const registry = registryOf({
		importPath: "a/b/ann.proto",
		text: declares("a.b", "tool"),
	});

	test("reports the declaring file's paths and the annotation's line", () => {
		const descriptor = registry.get("a.b.tool");
		expect(descriptor).toBeDefined();
		if (!descriptor) {
			return;
		}
		expect(definitionSite(registry, descriptor)).toEqual({
			importPath: "a/b/ann.proto",
			path: "/repo/a/b/ann.proto",
			line: descriptor.line,
		});
	});

	test("falls back to the descriptor when the file is no longer known", () => {
		const descriptor = registry.get("a.b.tool");
		expect(descriptor).toBeDefined();
		if (!descriptor) {
			return;
		}
		// An annotation held by a provider across a re-index can outlive its
		// file's entry; the footer still needs an import path to print.
		const orphan = { ...descriptor, fileId: -1 };
		expect(definitionSite(registry, orphan)).toEqual({
			importPath: descriptor.importPath,
			path: undefined,
			line: descriptor.line,
		});
	});
});

describe("annotationRegistryOf", () => {
	const registry = registryOf({
		importPath: "a/b/ann.proto",
		text: declares("a.b", "tool"),
	});

	test("returns nothing without an index", () => {
		expect(annotationRegistryOf(undefined)).toBeUndefined();
	});

	test("returns nothing when the index has no annotations method", () => {
		expect(annotationRegistryOf({} as unknown as ProtoIndex)).toBeUndefined();
	});

	test("returns nothing when the index throws", () => {
		expect(
			annotationRegistryOf(
				fakeIndex(() => {
					throw new Error("index not built");
				}),
			),
		).toBeUndefined();
	});

	test("returns nothing for a non-object", () => {
		expect(annotationRegistryOf(fakeIndex(() => undefined))).toBeUndefined();
		expect(annotationRegistryOf(fakeIndex(() => "registry"))).toBeUndefined();
	});

	test("rejects a registry missing any method the providers need", () => {
		// The probe is structural rather than an instanceof check, so that the
		// index may wrap or proxy the registry. Every method has to be there.
		for (const omitted of REGISTRY_METHODS) {
			const partial: Record<string, unknown> = {};
			for (const method of REGISTRY_METHODS) {
				if (method !== omitted) {
					partial[method] = () => undefined;
				}
			}
			expect(annotationRegistryOf(fakeIndex(() => partial))).toBeUndefined();
		}
	});

	test("passes a full registry through", () => {
		expect(annotationRegistryOf(fakeIndex(() => registry))).toBe(registry);
	});
});

describe("AnnotationSource", () => {
	const registry = registryOf({
		importPath: "a/b/ann.proto",
		text: declares("a.b", "tool"),
	});

	test("asks the index again on every request", () => {
		// Providers are registered at activation, long before the first build
		// finishes, so a captured registry would stay empty for ever.
		let built = false;
		const source = new AnnotationSource(
			fakeIndex(() => (built ? registry : new AnnotationRegistryImpl())),
		);
		expect(source.ready()).toBe(false);
		built = true;
		expect(source.registry()).toBe(registry);
		expect(source.ready()).toBe(true);
	});

	test("prefers the index over the fallback registry", () => {
		const fallback = new AnnotationRegistryImpl();
		const source = new AnnotationSource(
			fakeIndex(() => registry),
			fallback,
		);
		expect(source.registry()).toBe(registry);
	});

	test("uses the fallback when there is no index", () => {
		const source = new AnnotationSource(undefined, registry);
		expect(source.registry()).toBe(registry);
		expect(source.ready()).toBe(true);
	});

	test("is not ready with no registry at all", () => {
		const source = new AnnotationSource(undefined);
		expect(source.registry()).toBeUndefined();
		expect(source.ready()).toBe(false);
	});

	test("is not ready while the registry is empty", () => {
		// An empty registry means the index has not run, not that the workspace
		// declares no annotations — diagnostics must stay silent either way.
		const source = new AnnotationSource(
			undefined,
			new AnnotationRegistryImpl(),
		);
		expect(source.ready()).toBe(false);
	});

	test("subscribes through the index", () => {
		let listener: (() => void) | undefined;
		let disposed = false;
		const index = {
			annotations: () => registry,
			onDidChange: (fn: () => void) => {
				listener = fn;
				return {
					dispose: () => {
						disposed = true;
					},
				};
			},
		} as unknown as ProtoIndex;
		let fired = 0;
		const subscription = new AnnotationSource(index).onDidChange(() => {
			fired++;
		});
		listener?.();
		expect(fired).toBe(1);
		subscription.dispose();
		expect(disposed).toBe(true);
	});

	test("hands out a disposable even with no index to subscribe to", () => {
		const subscription = new AnnotationSource(undefined).onDidChange(() => {});
		expect(() => {
			subscription.dispose();
		}).not.toThrow();
	});
});

describe("knownNamespaceFor and suggestAnnotation", () => {
	const registry = registryOf(
		{ importPath: "a/b/ann.proto", text: declares("a.b", "tool") },
		{ importPath: "a/b/more.proto", text: declares("a.b", "toolkit") },
		{ importPath: "a/ann.proto", text: declares("a", "outer") },
	);

	test("picks the longest namespace that prefixes the name", () => {
		expect(knownNamespaceFor(registry, "a.b.typo")).toBe("a.b");
		expect(knownNamespaceFor(registry, "a.typo")).toBe("a");
	});

	test("finds no namespace for an unrelated name", () => {
		expect(knownNamespaceFor(registry, "zz.thing")).toBeUndefined();
		// A namespace is only a prefix when a dot follows it.
		expect(knownNamespaceFor(registry, "ab.thing")).toBeUndefined();
	});

	test("suggests a near miss inside the namespace", () => {
		expect(suggestAnnotation(registry, "a.b.tol", "a.b")).toBe("a.b.tool");
		expect(suggestAnnotation(registry, "a.b.toolki", "a.b")).toBe(
			"a.b.toolkit",
		);
	});

	test("suggests nothing for a name that is merely absent", () => {
		// The budget scales with the name's length, so a genuinely new name
		// produces no misleading hint.
		expect(suggestAnnotation(registry, "a.b.zzzzz", "a.b")).toBeUndefined();
	});

	test("searches only the namespace it was given", () => {
		expect(suggestAnnotation(registry, "a.oute", "a")).toBe("a.outer");
		expect(suggestAnnotation(registry, "a.tol", "a")).toBeUndefined();
	});
});

/*
 * Suspected defect, skipped rather than pinned, and reported for triage.
 */

// `resolveDescriptor` (resolve.ts:140) strips a leading dot and then walks the
// package scope anyway, so `.tool` resolves to `a.b.tool`. In protobuf a
// leading dot means fully qualified from the root namespace: `.tool` names a
// top-level `tool` and nothing else. The doc comment says as much ("an absolute
// name first"), and the branch exists for the case it then defeats.
//
// Fixing it also needs `analyzeProtoDocument`: `OptionReference.fqn` already
// drops the leading dot, so a buffer writing `(.tool)` reaches this function as
// `tool` and the fix would never fire. See the leading-dot test in
// document.test.ts.
// Expected: undefined, because nothing declares a top-level `tool`.
test("treats a leading dot as rooted at the root namespace", () => {
	const registry = registryOf({
		importPath: "a/b/ann.proto",
		text: declares("a.b", "tool"),
	});
	expect(resolveDescriptor(registry, ".tool", "a.b.c")).toBeUndefined();
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"resolves every option reference the corpus writes",
		async () => {
			const root = REFERENCE_PROTO_ROOT;
			if (!root) {
				return;
			}
			const registry = await referenceRegistry();
			// Not filtered to service.proto: those carry only `google.api.*`
			// options, which would leave the namespace assertion below vacuous.
			// A plain slice of the tree mixes service files with the type and
			// resource files that also carry `buf.validate.*`.
			const files = listProtos(root).sort().slice(0, 60);
			const namespaces = new Set<string>();
			let total = 0;
			for (const file of files) {
				const text = fs.readFileSync(file, "utf8");
				const model = analyzeProtoDocument(text);
				for (const reference of model.options) {
					total++;
					const descriptor = resolveDescriptor(
						registry,
						reference.fqn,
						model.packageName,
					);
					expect(descriptor).toBeDefined();
					if (descriptor) {
						namespaces.add(descriptor.namespace);
					}
				}
			}
			expect(total).toBeGreaterThan(100);
			// The corpus annotates with more than one vendor's options; a
			// resolution rule that only worked for one would collapse this.
			expect(namespaces.size).toBeGreaterThanOrEqual(2);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"walks a real file's imports transitively",
		async () => {
			const root = REFERENCE_PROTO_ROOT;
			if (!root) {
				return;
			}
			const registry = await referenceRegistry();
			const services = listProtos(root).filter((file) =>
				file.endsWith("service.proto"),
			);
			const file = services.find((candidate) =>
				fs
					.readFileSync(candidate, "utf8")
					.includes('import "google/api/annotations.proto"'),
			);
			expect(file).toBeDefined();
			if (!file) {
				return;
			}
			const model = analyzeProtoDocument(fs.readFileSync(file, "utf8"));
			const direct = model.imports.map((entry) => entry.path);
			const closure = importClosure(registry, direct);
			// `google/api/annotations.proto` re-exports the http rule, which is
			// exactly the shape a direct-import test would get wrong.
			expect(direct).toContain("google/api/annotations.proto");
			expect(direct).not.toContain("google/api/http.proto");
			expect(closure.paths.has("google/api/http.proto")).toBe(true);
			expect(closure.paths.has("google/protobuf/descriptor.proto")).toBe(true);
		},
	);
});
