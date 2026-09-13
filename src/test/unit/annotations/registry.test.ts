/**
 * Tests for `AnnotationRegistryImpl`, the store every annotation feature reads.
 *
 * Three properties are load-bearing and each has a way of failing silently.
 *
 * **Lazy bodies.** The walk records an option's type *name*; resolving it to a
 * message happens on first ask and is memoised. A broken cache costs memory on
 * a 9,280-proto workspace rather than producing a wrong answer, so the tests
 * assert object identity across repeat calls as well as content.
 *
 * **Scope resolution.** A type name in a `.proto` resolves innermost-scope
 * first, and a leading `.` means rooted at the global namespace. Getting this
 * wrong points a hover at the wrong message, which reads as a documentation bug
 * rather than a resolution one.
 *
 * **Incremental upkeep.** `ingest` replaces one file's contribution and
 * `removeFile` drops it; both must invalidate every derived cache, or the
 * editor keeps offering annotations from a file that no longer exists.
 *
 * Anything about scale, real collisions or real package layout runs against the
 * reference corpus rather than a fixture chosen to suit the assertion.
 */

import { describe, expect, test } from "bun:test";
import { extractAnnotations } from "../../../annotations/extractor";
import {
	AnnotationRegistryImpl,
	isScalar,
} from "../../../annotations/registry";
import type { AnnotationTarget } from "../../../index/types";
import { hasReferenceCorpus, referenceRegistry } from "../support/fixtures";

/**
 * Feeds one file's source into a registry, deriving the descriptors the same
 * way the scanner and the index walk do.
 */
function load(
	registry: AnnotationRegistryImpl,
	fileId: number,
	text: string,
	importPath = `f${fileId}/v1/annotations.proto`,
	path?: string,
): AnnotationRegistryImpl {
	registry.ingest(extractAnnotations(text, { fileId, importPath, path }));
	return registry;
}

/** A registry holding a single file. */
function registryOf(text: string, importPath?: string): AnnotationRegistryImpl {
	return load(new AnnotationRegistryImpl(), 1, text, importPath);
}

/** One annotation per target, a body message, and a nested body. */
const CACHE = `syntax = "proto3";
package cache.v1;

import "cache/v1/cache.proto";
import "google/protobuf/descriptor.proto";

extend google.protobuf.MessageOptions {
  // cache marks a resource as cached.
  CacheOptions cache = 52001;
}

extend google.protobuf.FileOptions {
  CacheDefaults cache_defaults = 52000;
}

message CacheOptions {
  bool enabled = 1;
  Strategy strategy = 2;
  Lease ttl = 3;
}

message Lease {
  int64 seconds = 1;
  int32 nanos = 2;
}

message CacheDefaults {
  Strategy strategy = 1;
}

enum Strategy {
  STRATEGY_UNSPECIFIED = 0;
  STRATEGY_ASIDE = 1;
}
`;

describe("lookup", () => {
	test("sorts all() by fully-qualified name", () => {
		const registry = registryOf(`package z.v1;
extend google.protobuf.FileOptions {
  optional string zebra = 1;
  optional string apple = 2;
  optional string mango = 3;
}
`);
		expect(registry.all().map((a) => a.fqn)).toEqual([
			"z.v1.apple",
			"z.v1.mango",
			"z.v1.zebra",
		]);
	});

	test("looks one up by exact fqn", () => {
		const registry = registryOf(CACHE);
		expect(registry.get("cache.v1.cache")?.number).toBe(52001);
		expect(registry.get("cache")).toBeUndefined();
		expect(registry.get("cache.v1.CACHE")).toBeUndefined();
	});

	test("groups by the element each may decorate", () => {
		const registry = registryOf(CACHE);
		expect(registry.byTarget("Message").map((a) => a.fqn)).toEqual([
			"cache.v1.cache",
		]);
		expect(registry.byTarget("File").map((a) => a.fqn)).toEqual([
			"cache.v1.cache_defaults",
		]);
		// A target nothing decorates answers empty rather than undefined, so
		// completion can iterate without a guard.
		expect(registry.byTarget("Oneof")).toEqual([]);
	});

	test("lists the namespaces that declare an annotation, sorted and deduped", () => {
		const registry = new AnnotationRegistryImpl();
		load(
			registry,
			1,
			`package z.v1;
extend google.protobuf.FileOptions {
  optional string a = 1;
  optional string b = 2;
}
`,
		);
		load(
			registry,
			2,
			`package a.v1;
extend google.protobuf.FileOptions {
  optional string c = 3;
}
`,
		);
		// A file with messages but no extend block contributes no namespace.
		load(
			registry,
			3,
			`package m.v1;
message Body {
  string s = 1;
}
`,
		);
		expect(registry.namespaces()).toEqual(["a.v1", "z.v1"]);
	});

	test("counts the option-body shapes it knows", () => {
		const registry = registryOf(CACHE);
		expect(registry.messageCount()).toBe(3);
		registry.clear();
		expect(registry.messageCount()).toBe(0);
	});

	test("reports where a file and an annotation were declared", () => {
		const registry = new AnnotationRegistryImpl();
		load(registry, 4, CACHE, "cache/v1/annotations.proto", "/abs/cache.proto");
		const descriptor = registry.get("cache.v1.cache");
		if (!descriptor) {
			throw new Error("fixture declares cache.v1.cache");
		}
		expect(registry.siteOf(descriptor)).toEqual({
			path: "/abs/cache.proto",
			importPath: "cache/v1/annotations.proto",
			packageName: "cache.v1",
		});
		expect(registry.origin(4)).toEqual(registry.siteOf(descriptor));
		expect(registry.origin(99)).toBeUndefined();
	});

	test("remembers what a scanned file imports", () => {
		const registry = registryOf(CACHE, "cache/v1/annotations.proto");
		expect(registry.importsOf("cache/v1/annotations.proto")).toEqual([
			"cache/v1/cache.proto",
			"google/protobuf/descriptor.proto",
		]);
		// Never scanned is distinct from scanned-and-imports-nothing.
		expect(registry.importsOf("cache/v1/cache.proto")).toBeUndefined();
	});

	test("keeps the first declaration when a fqn arrives twice", () => {
		const registry = new AnnotationRegistryImpl();
		const source = `package dup.v1;
extend google.protobuf.MessageOptions {
  optional Body thing = 7;
}
`;
		// The buf module cache holds several commits of one module, so the same
		// annotation is scanned repeatedly under different file ids.
		load(registry, 1, source, "dup/v1/annotations.proto");
		load(registry, 2, source, "dup/v1/annotations.proto");
		expect(registry.all()).toHaveLength(1);
		expect(registry.get("dup.v1.thing")?.fileId).toBe(1);
	});
});

describe("lazy bodies", () => {
	test("resolves a body on demand and returns the same object thereafter", () => {
		const registry = registryOf(CACHE);
		const descriptor = registry.get("cache.v1.cache");
		if (!descriptor) {
			throw new Error("fixture declares cache.v1.cache");
		}
		const first = registry.body(descriptor);
		expect(first?.fqn).toBe("cache.v1.CacheOptions");
		expect(first?.fields.map((f) => f.name)).toEqual([
			"enabled",
			"strategy",
			"ttl",
		]);
		// Identity, not just equality: a body rebuilt per hover would resolve
		// every field type again on a registry holding 10,000 messages.
		expect(registry.body(descriptor)).toBe(first);
		expect(registry.bodyOf("cache.v1.CacheOptions")).toBe(first);
	});

	test("carries each body field's type, number, repeatedness and doc", () => {
		const registry = registryOf(`package b.v1;
extend google.protobuf.FieldOptions {
  Body b = 1;
}
message Body {
  // What it is for.
  repeated string names = 4;
  int32 count = 5;
}
`);
		const body = registry.bodyOf("b.v1.Body");
		expect(body?.fields[0]).toEqual({
			name: "names",
			type: "string",
			number: 4,
			repeated: true,
			doc: "What it is for.",
			messageFqn: undefined,
		});
		expect(body?.fields[1].doc).toBeUndefined();
		expect(body?.fields[1].repeated).toBe(false);
	});

	test("resolves a body field's own message type", () => {
		const registry = registryOf(CACHE);
		const body = registry.bodyOf("cache.v1.CacheOptions");
		const ttl = body?.fields.find((f) => f.name === "ttl");
		expect(ttl?.messageFqn).toBe("cache.v1.Lease");
		// A scalar and an enum both resolve to no message.
		expect(
			body?.fields.find((f) => f.name === "enabled")?.messageFqn,
		).toBeUndefined();
		expect(
			body?.fields.find((f) => f.name === "strategy")?.messageFqn,
		).toBeUndefined();
	});

	test("answers undefined for an option assigned a scalar directly", () => {
		const registry = registryOf(`package s.v1;
extend google.protobuf.ServiceOptions {
  optional string default_host = 1049;
}
`);
		const descriptor = registry.get("s.v1.default_host");
		if (!descriptor) {
			throw new Error("fixture declares s.v1.default_host");
		}
		expect(registry.body(descriptor)).toBeUndefined();
	});

	test("answers undefined when the body message was never indexed", () => {
		const registry = registryOf(`package u.v1;
extend google.protobuf.MessageOptions {
  Missing thing = 1;
}
`);
		const descriptor = registry.get("u.v1.thing");
		if (!descriptor) {
			throw new Error("fixture declares u.v1.thing");
		}
		expect(registry.body(descriptor)).toBeUndefined();
		// Asking twice must not start answering differently: the miss is cached
		// as a miss rather than as an absent cache entry.
		expect(registry.body(descriptor)).toBeUndefined();
		expect(registry.bodyOf("u.v1.Missing")).toBeUndefined();
	});
});

describe("walking a body by path", () => {
	const registry = registryOf(CACHE);
	const cache = registry.get("cache.v1.cache");
	if (!cache) {
		throw new Error("fixture declares cache.v1.cache");
	}

	test("finds a field at the body root", () => {
		expect(registry.fieldAt(cache, ["enabled"])).toMatchObject({
			name: "enabled",
			type: "bool",
			number: 1,
		});
	});

	test("hops through a nested message", () => {
		expect(registry.fieldAt(cache, ["ttl", "seconds"])).toMatchObject({
			name: "seconds",
			type: "int64",
			number: 1,
		});
	});

	test("answers undefined for an unknown segment at any depth", () => {
		expect(registry.fieldAt(cache, ["nope"])).toBeUndefined();
		expect(registry.fieldAt(cache, ["ttl", "nope"])).toBeUndefined();
		// `enabled` is a bool, so there is nothing to walk into.
		expect(registry.fieldAt(cache, ["enabled", "seconds"])).toBeUndefined();
	});

	test("answers undefined for an empty path", () => {
		expect(registry.fieldAt(cache, [])).toBeUndefined();
	});

	test("returns the body itself for an empty path", () => {
		expect(registry.bodyAt(cache, [])?.fqn).toBe("cache.v1.CacheOptions");
	});

	test("returns the message a path leads into", () => {
		expect(registry.bodyAt(cache, ["ttl"])?.fqn).toBe("cache.v1.Lease");
		expect(registry.bodyAt(cache, ["ttl"])?.fields.map((f) => f.name)).toEqual([
			"seconds",
			"nanos",
		]);
	});

	test("returns undefined where the path ends on a non-message", () => {
		expect(registry.bodyAt(cache, ["enabled"])).toBeUndefined();
		expect(registry.bodyAt(cache, ["nope"])).toBeUndefined();
	});
});

describe("type resolution", () => {
	/** Two messages named `Foo`, so a suffix match alone is ambiguous. */
	const TWO_FOOS = new AnnotationRegistryImpl();
	load(
		TWO_FOOS,
		1,
		`package a.b;
message Foo {
  string s = 1;
}
`,
	);
	load(
		TWO_FOOS,
		2,
		`package z.q;
message Foo {
  string s = 1;
}
`,
	);

	test("takes a name already fully qualified", () => {
		expect(TWO_FOOS.resolveTypeFqn("a.b.Foo", "z.q")).toBe("a.b.Foo");
	});

	test("strips protobuf's leading dot", () => {
		expect(TWO_FOOS.resolveTypeFqn(".a.b.Foo", "unrelated.v1")).toBe("a.b.Foo");
	});

	test("walks outwards from the declaring package", () => {
		// Both `a.b.Foo` and `z.q.Foo` exist, so only the scope walk can pick one.
		expect(TWO_FOOS.resolveTypeFqn("Foo", "a.b.c.d")).toBe("a.b.Foo");
		expect(TWO_FOOS.resolveTypeFqn("Foo", "z.q")).toBe("z.q.Foo");
	});

	test("refuses an ambiguous suffix match", () => {
		expect(TWO_FOOS.resolveTypeFqn("Foo", "unrelated.v1")).toBeUndefined();
	});

	test("falls back to a unique suffix match", () => {
		const registry = registryOf(`package only.here;
message Solo {
  string s = 1;
}
`);
		expect(registry.resolveTypeFqn("Solo", "somewhere.else")).toBe(
			"only.here.Solo",
		);
	});

	test("never resolves a scalar or a map", () => {
		const registry = registryOf(CACHE);
		for (const scalar of ["string", "bool", "int32", "bytes", "double"]) {
			expect(registry.resolveTypeFqn(scalar, "cache.v1")).toBeUndefined();
			expect(isScalar(scalar)).toBe(true);
		}
		expect(
			registry.resolveTypeFqn("map<string,CacheOptions>", "cache.v1"),
		).toBeUndefined();
		expect(isScalar("CacheOptions")).toBe(false);
	});

	test("answers undefined for a name nothing declares", () => {
		expect(TWO_FOOS.resolveTypeFqn("Nothing", "a.b")).toBeUndefined();
	});
});

describe("enum resolution", () => {
	const registry = new AnnotationRegistryImpl();
	load(
		registry,
		1,
		`package a.b;
enum Kind {
  KIND_UNSPECIFIED = 0;
  KIND_A = 1;
}
`,
	);
	load(
		registry,
		2,
		`package a.b.c;
message Outer {
  enum Inner {
    INNER_UNSPECIFIED = 0;
  }
  string s = 1;
}
`,
	);

	test("finds an enum declared in an enclosing scope", () => {
		// `a.b.c.d` sees `a.b.Kind` by walking out one package at a time.
		expect(registry.resolveEnumFqn("Kind", "a.b.c.d")).toBe("a.b.Kind");
		expect(registry.resolveEnumFqn("Kind", "a.b")).toBe("a.b.Kind");
	});

	test("treats a leading dot as rooted at the global namespace", () => {
		expect(registry.resolveEnumFqn(".a.b.Kind", "somewhere.else")).toBe(
			"a.b.Kind",
		);
	});

	test("resolves an enum nested inside a message", () => {
		expect(registry.resolveEnumFqn("Outer.Inner", "a.b.c")).toBe(
			"a.b.c.Outer.Inner",
		);
		expect(registry.resolveEnumFqn("a.b.c.Outer.Inner", "")).toBe(
			"a.b.c.Outer.Inner",
		);
	});

	test("does not guess by suffix the way message resolution does", () => {
		// Unlike `resolveTypeFqn` there is no last-resort unique-suffix match:
		// a wrong enum silently offers wrong completion values.
		expect(registry.resolveEnumFqn("Kind", "unrelated.v1")).toBeUndefined();
	});

	test("never resolves a scalar", () => {
		expect(registry.resolveEnumFqn("string", "a.b")).toBeUndefined();
	});

	test("lists the values of a known enum", () => {
		expect(registry.enumValues("a.b.Kind")).toEqual([
			"KIND_UNSPECIFIED",
			"KIND_A",
		]);
		expect(registry.enumValues("a.b.Missing")).toBeUndefined();
	});
});

describe("incremental upkeep", () => {
	/** Two files declaring disjoint vocabulary. */
	function twoFiles(): AnnotationRegistryImpl {
		const registry = new AnnotationRegistryImpl();
		load(
			registry,
			1,
			`package one.v1;
extend google.protobuf.FileOptions {
  One one = 1;
}
message One {
  string s = 1;
}
enum OneKind {
  ONE_KIND_UNSPECIFIED = 0;
}
`,
			"one/v1/annotations.proto",
		);
		load(
			registry,
			2,
			`package two.v1;
extend google.protobuf.MessageOptions {
  Two two = 2;
}
message Two {
  string s = 1;
}
enum TwoKind {
  TWO_KIND_UNSPECIFIED = 0;
}
`,
			"two/v1/annotations.proto",
		);
		return registry;
	}

	test("drops exactly the removed file's descriptors", () => {
		const registry = twoFiles();
		registry.removeFile(1);
		expect(registry.all().map((a) => a.fqn)).toEqual(["two.v1.two"]);
		expect(registry.bodyOf("one.v1.One")).toBeUndefined();
		expect(registry.enumValues("one.v1.OneKind")).toBeUndefined();
		expect(registry.origin(1)).toBeUndefined();
		expect(registry.importsOf("one/v1/annotations.proto")).toBeUndefined();
		// Everything the other file contributed survives untouched.
		expect(registry.bodyOf("two.v1.Two")?.fields).toHaveLength(1);
		expect(registry.enumValues("two.v1.TwoKind")).toEqual([
			"TWO_KIND_UNSPECIFIED",
		]);
		expect(registry.origin(2)?.importPath).toBe("two/v1/annotations.proto");
		expect(registry.messageCount()).toBe(1);
	});

	test("ignores removal of a file it never saw", () => {
		const registry = twoFiles();
		registry.removeFile(404);
		expect(registry.all()).toHaveLength(2);
	});

	test("replaces a file's contribution when it is ingested again", () => {
		const registry = twoFiles();
		load(
			registry,
			1,
			`package one.v1;
extend google.protobuf.FileOptions {
  One renamed = 1;
}
message One {
  string s = 1;
  string added = 2;
}
`,
			"one/v1/annotations.proto",
		);
		expect(registry.all().map((a) => a.fqn)).toEqual([
			"one.v1.renamed",
			"two.v1.two",
		]);
		expect(registry.get("one.v1.one")).toBeUndefined();
		expect(registry.bodyOf("one.v1.One")?.fields.map((f) => f.name)).toEqual([
			"s",
			"added",
		]);
		// The enum the earlier revision declared is gone with it.
		expect(registry.enumValues("one.v1.OneKind")).toBeUndefined();
	});

	test("empties everything on clear", () => {
		const registry = twoFiles();
		registry.clear();
		expect(registry.all()).toEqual([]);
		expect(registry.namespaces()).toEqual([]);
		expect(registry.byTarget("File")).toEqual([]);
		expect(registry.collisions()).toEqual([]);
		expect(registry.messageCount()).toBe(0);
		expect(registry.origin(1)).toBeUndefined();
		expect(registry.importsOf("one/v1/annotations.proto")).toBeUndefined();
		// Ingesting after a clear works: `clear` must not leave the file-key map
		// claiming ids it no longer holds.
		load(registry, 1, CACHE);
		expect(registry.get("cache.v1.cache")).toBeDefined();
	});

	test("invalidates the derived caches on ingest", () => {
		const registry = twoFiles();
		// Warm every cache before changing anything.
		expect(registry.all()).toHaveLength(2);
		expect(registry.byTarget("Message")).toHaveLength(1);
		expect(registry.collisions()).toEqual([]);
		expect(registry.namespaces()).toEqual(["one.v1", "two.v1"]);

		load(
			registry,
			3,
			`package three.v1;
extend google.protobuf.MessageOptions {
  optional string three = 2;
}
`,
		);
		expect(registry.all()).toHaveLength(3);
		expect(registry.byTarget("Message").map((a) => a.fqn)).toEqual([
			"three.v1.three",
			"two.v1.two",
		]);
		expect(registry.namespaces()).toEqual(["one.v1", "three.v1", "two.v1"]);
		// `two.v1.two` and `three.v1.three` both claim Message slot 2.
		expect(registry.collisions()).toHaveLength(1);
	});

	test("invalidates a resolved body when the message that backs it goes", () => {
		const registry = twoFiles();
		expect(registry.bodyOf("two.v1.Two")?.fields).toHaveLength(1);
		registry.removeFile(2);
		expect(registry.bodyOf("two.v1.Two")).toBeUndefined();
	});

	test("invalidates a cached type resolution when a nearer message appears", () => {
		const registry = new AnnotationRegistryImpl();
		load(
			registry,
			1,
			`package far.away;
message Body {
  string s = 1;
}
`,
		);
		// Resolved by the unique-suffix fallback, and cached.
		expect(registry.resolveTypeFqn("Body", "near.v1")).toBe("far.away.Body");
		load(
			registry,
			2,
			`package near.v1;
message Body {
  string s = 1;
}
`,
		);
		expect(registry.resolveTypeFqn("Body", "near.v1")).toBe("near.v1.Body");
	});
});

describe("collisions", () => {
	test("reports one slot claimed by two annotations", () => {
		const registry = new AnnotationRegistryImpl();
		load(
			registry,
			1,
			`package old.v1;
extend google.protobuf.MessageOptions {
  TableOptions table = 51001;
}
`,
		);
		load(
			registry,
			2,
			`package new.v1;
extend google.protobuf.MessageOptions {
  TableOptions table = 51001;
}
`,
		);
		const collisions = registry.collisions();
		expect(collisions).toHaveLength(1);
		expect(collisions[0].target).toBe("Message");
		expect(collisions[0].number).toBe(51001);
		expect(collisions[0].claimants.map((c) => c.fqn).sort()).toEqual([
			"new.v1.table",
			"old.v1.table",
		]);
	});

	test("does not collide across different extendees", () => {
		// Extension numbers are unique per extendee, so the same number on a
		// message and on a field is legal and must not be reported.
		const registry = registryOf(`package x.v1;
extend google.protobuf.MessageOptions {
  optional string a = 51001;
}
extend google.protobuf.FieldOptions {
  optional string b = 51001;
}
`);
		expect(registry.collisions()).toEqual([]);
	});

	test("reports nothing when every slot is claimed once", () => {
		expect(registryOf(CACHE).collisions()).toEqual([]);
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"holds a well-formed descriptor for every annotation",
		async () => {
			const registry = await referenceRegistry();
			const all = registry.all();
			// Loose bounds: the corpus tracks upstream modules, so an exact count
			// would fail on a `buf dep update` rather than on a regression.
			expect(all.length).toBeGreaterThan(30);
			expect(all.length).toBeLessThan(500);

			const seen = new Set<string>();
			let previous = "";
			for (const descriptor of all) {
				expect(seen.has(descriptor.fqn)).toBe(false);
				seen.add(descriptor.fqn);
				expect(descriptor.fqn >= previous).toBe(true);
				previous = descriptor.fqn;
				expect(descriptor.namespace.length).toBeGreaterThan(0);
				expect(descriptor.number).toBeGreaterThan(0);
				expect(registry.get(descriptor.fqn)).toBe(descriptor);
				expect(registry.byTarget(descriptor.target)).toContain(descriptor);
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"spreads annotations over many independent namespaces",
		async () => {
			const registry = await referenceRegistry();
			const namespaces = registry.namespaces();
			expect(namespaces.length).toBeGreaterThanOrEqual(8);
			expect([...namespaces].sort()).toEqual([...namespaces]);
			// Every namespace an annotation reports is one this list knows about,
			// and vice versa.
			expect(new Set(registry.all().map((a) => a.namespace))).toEqual(
				new Set(namespaces),
			);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"reports the known protokit/entity migration collisions",
		async () => {
			const registry = await referenceRegistry();
			const collisions = registry.collisions();
			expect(collisions.length).toBeGreaterThanOrEqual(3);

			for (const collision of collisions) {
				expect(collision.claimants.length).toBeGreaterThan(1);
				for (const claimant of collision.claimants) {
					expect(claimant.target).toBe(collision.target);
					expect(claimant.number).toBe(collision.number);
				}
			}

			// `protokit.v1` is the successor of `entity.v1` and reuses its slots,
			// which is exactly the overlap a file importing both would trip over.
			const pairs = collisions.map((c) =>
				c.claimants.map((claimant) => claimant.fqn).sort(),
			);
			expect(pairs).toContainEqual(["entity.v1.column", "protokit.v1.column"]);
			expect(pairs).toContainEqual([
				"entity.v1.datasource",
				"protokit.v1.datasource",
			]);
			expect(pairs).toContainEqual(["entity.v1.table", "protokit.v1.table"]);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"resolves every option body identically on repeat asks",
		async () => {
			const registry = await referenceRegistry();
			let resolved = 0;
			for (const descriptor of registry.all()) {
				const body = registry.body(descriptor);
				if (!body) {
					continue;
				}
				resolved++;
				expect(registry.body(descriptor)).toBe(body);
				expect(body.fqn.endsWith(descriptor.type.replace(/^\./, ""))).toBe(
					true,
				);
				for (const field of body.fields) {
					expect(field.name.length).toBeGreaterThan(0);
					expect(field.number).toBeGreaterThan(0);
					if (field.messageFqn) {
						expect(registry.bodyOf(field.messageFqn)?.fqn).toBe(
							field.messageFqn,
						);
					}
				}
			}
			// Most annotations in the corpus carry a message body; a run that
			// resolved none would mean type resolution had stopped working.
			expect(resolved).toBeGreaterThan(10);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"knows the declaration site of every annotation",
		async () => {
			const registry = await referenceRegistry();
			for (const descriptor of registry.all()) {
				const site = registry.siteOf(descriptor);
				expect(site?.packageName).toBe(descriptor.namespace);
				expect(site?.importPath).toBe(descriptor.importPath);
				// Scanned from disk, so the absolute path is always known and the
				// "defined in" footer can link.
				expect(site?.path?.endsWith(descriptor.importPath)).toBe(true);
				expect(registry.importsOf(descriptor.importPath)).toBeDefined();
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"answers byTarget for every target without a gap",
		async () => {
			const registry = await referenceRegistry();
			const targets: AnnotationTarget[] = [
				"File",
				"Message",
				"Field",
				"Oneof",
				"Enum",
				"EnumValue",
				"Service",
				"Method",
			];
			let total = 0;
			for (const target of targets) {
				total += registry.byTarget(target).length;
			}
			expect(total).toBe(registry.all().length);
		},
	);
});

/*
 * Suspected bug, left skipped deliberately.
 *
 * `resolveTypeFqn`'s last-resort unique-suffix match runs even when the name
 * resolves to an *enum* in an enclosing scope of the declaring package, so an
 * enum-typed body field is handed the fqn of an unrelated message that happens
 * to share its last segment. `messageFqn` being set then suppresses the enum
 * value hint in `renderAnnotationCard` and `renderFieldCard`, and
 * `renderFieldCard` expands the unrelated message's fields instead.
 *
 * The real corpus hits this: `buffers.v1.MethodOptions.transport` is a
 * `buffers.v1.Transport` enum, and resolution returns
 * `protobuf.fhir.base.workflow.v5.transport.Transport`, so hovering `transport`
 * renders a 60-field FHIR resource. See the matching skip in markdown.test.ts.
 *
 * Expected: a name that resolves to an enum by the scope walk is not a message,
 * so `messageFqn` stays undefined and the value hint survives.
 */
test.skip("prefers an in-scope enum over a far-away message of the same name", () => {
	const registry = new AnnotationRegistryImpl();
	load(
		registry,
		1,
		`package rpc.v1;
extend google.protobuf.MethodOptions {
  MethodOptions method = 1;
}
message MethodOptions {
  Transport transport = 3;
}
enum Transport {
  TRANSPORT_UNSPECIFIED = 0;
  TRANSPORT_CALL = 1;
}
`,
	);
	load(
		registry,
		2,
		`package unrelated.v9;
message Transport {
  string name = 1;
}
`,
	);
	const field = registry.bodyOf("rpc.v1.MethodOptions")?.fields[0];
	expect(field?.messageFqn).toBeUndefined();
	expect(registry.resolveEnumFqn("Transport", "rpc.v1")).toBe(
		"rpc.v1.Transport",
	);
});

/*
 * Suspected bug, left skipped deliberately.
 *
 * `ingest` records a fqn under the *first* file that declared it, so a second
 * file declaring the same annotation records nothing. Removing the first file
 * then deletes the descriptor even though the second file still declares it,
 * and the annotation disappears until a full rescan. The buf module cache makes
 * this routine: it holds several commits of one module, each declaring the same
 * vocabulary, and `removeFile` is how the incremental re-index retires a file.
 *
 * Expected: the annotation survives, backed by the file that still declares it.
 */
test.skip("keeps an annotation a second file still declares", () => {
	const registry = new AnnotationRegistryImpl();
	const source = `package dup.v1;
extend google.protobuf.MessageOptions {
  optional string thing = 7;
}
`;
	load(registry, 1, source, "a/dup/v1/annotations.proto");
	load(registry, 2, source, "b/dup/v1/annotations.proto");
	registry.removeFile(1);
	expect(registry.get("dup.v1.thing")).toBeDefined();
});
