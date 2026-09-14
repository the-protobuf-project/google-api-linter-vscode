/**
 * Tests for the annotation card renderer.
 *
 * Every line of a card is derived from the `extend` block and the option body:
 * the target from the extendee, the fields from the body message, the prose and
 * the example from the leading comment. A renderer that quietly drops one of
 * those still produces a plausible-looking card, which is how the enum value
 * hint went missing for options with no body message — `google.api.field_behavior`
 * hovered as a name and a number and nothing else.
 *
 * So the assertions here are about what reaches the card: the value set of an
 * enum-typed option, the values of an enum-typed body field resolved against
 * the *body's* namespace rather than the annotation's, the usage example kept
 * whole, and the elision once an enum outgrows the inline list.
 */

import { describe, expect, test } from "bun:test";
import { extractAnnotations } from "../../../annotations/extractor";
import {
	type DefinitionSite,
	enumValueHint,
	fieldType,
	namespaceOf,
	renderAnnotationCard,
	renderDeclarationCard,
	renderFieldCard,
	summaryLine,
	targetLabel,
} from "../../../annotations/markdown";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import type { AnnotationDescriptor } from "../../../index/types";
import { hasReferenceCorpus, referenceRegistry } from "../support/fixtures";

/** Feeds one file's source into a registry, the way the scanner does. */
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
function registryOf(text: string, importPath?: string, path?: string) {
	return load(new AnnotationRegistryImpl(), 1, text, importPath, path);
}

/** Looks an annotation up, failing loudly when the fixture does not declare it. */
function annotation(
	registry: AnnotationRegistryImpl,
	fqn: string,
): AnnotationDescriptor {
	const descriptor = registry.get(fqn);
	if (!descriptor) {
		throw new Error(`fixture does not declare ${fqn}`);
	}
	return descriptor;
}

/** An option with a body, a doc, an enum-typed field and an example. */
const CACHE = `syntax = "proto3";
package cache.v1;

extend google.protobuf.MessageOptions {
  // cache marks a resource as cached and configures how.
  //
  //\toption (cache.v1.cache) = {
  //\t  enabled: true
  //\t};
  CacheOptions cache = 52001;
}

message CacheOptions {
  // Turns caching on.
  bool enabled = 1;
  Strategy strategy = 2;
  Lease ttl = 3;
  repeated string tags = 4;
}

message Lease {
  // Whole seconds.
  int64 seconds = 1;
}

enum Strategy {
  STRATEGY_UNSPECIFIED = 0;
  STRATEGY_ASIDE = 1;
}
`;

describe("fieldType", () => {
	test("prefixes a repeated field with its label", () => {
		const registry = registryOf(CACHE);
		const body = registry.bodyOf("cache.v1.CacheOptions");
		const tags = body?.fields.find((f) => f.name === "tags");
		const enabled = body?.fields.find((f) => f.name === "enabled");
		if (!tags || !enabled) {
			throw new Error("fixture declares tags and enabled");
		}
		expect(fieldType(tags)).toBe("repeated string");
		expect(fieldType(enabled)).toBe("bool");
	});
});

describe("targetLabel", () => {
	test("names each target the way a proto author would", () => {
		expect(targetLabel("Method")).toBe("rpc");
		expect(targetLabel("EnumValue")).toBe("enum value");
		expect(targetLabel("File")).toBe("file");
	});
});

describe("namespaceOf", () => {
	test("takes the package part of a fully-qualified message name", () => {
		expect(namespaceOf("cache.v1.CacheOptions")).toBe("cache.v1");
		expect(namespaceOf("a.b.Outer.Inner")).toBe("a.b.Outer");
	});

	test("answers empty for a name with no package", () => {
		expect(namespaceOf("Body")).toBe("");
	});
});

describe("summaryLine", () => {
	test("reads target, body type and field number", () => {
		const registry = registryOf(CACHE);
		expect(summaryLine(annotation(registry, "cache.v1.cache"))).toBe(
			"message option · CacheOptions · field 52001",
		);
	});

	test("marks a repeated option", () => {
		const registry = registryOf(`package g.v1;
extend google.protobuf.FieldOptions {
  repeated Behavior field_behavior = 1052;
}
`);
		expect(summaryLine(annotation(registry, "g.v1.field_behavior"))).toBe(
			"field option · repeated Behavior · field 1052",
		);
	});
});

describe("enumValueHint", () => {
	/** An enum with `count` values, named so the elision is easy to read. */
	function enumWith(count: number): AnnotationRegistryImpl {
		const values = Array.from(
			{ length: count },
			(_, i) => `  VALUE_${i} = ${i};`,
		).join("\n");
		return registryOf(`package e.v1;
enum Size {
${values}
}
`);
	}

	test("renders every value when the enum is small", () => {
		const registry = registryOf(CACHE);
		expect(enumValueHint("Strategy", "cache.v1", registry)).toBe(
			"`STRATEGY_UNSPECIFIED` · `STRATEGY_ASIDE`",
		);
	});

	test("resolves the name against an enclosing scope", () => {
		const registry = registryOf(CACHE);
		expect(enumValueHint("Strategy", "cache.v1.sub.deeper", registry)).toBe(
			"`STRATEGY_UNSPECIFIED` · `STRATEGY_ASIDE`",
		);
	});

	test("shows the whole list at exactly the inline cap", () => {
		// Ten is the documented cap; the corpus has no enum that large attached
		// to an annotation, so the boundary needs a fixture.
		const hint = enumValueHint("Size", "e.v1", enumWith(10));
		expect(hint).toContain("`VALUE_9`");
		expect(hint).not.toContain("more");
		expect(hint?.split(" · ")).toHaveLength(10);
	});

	test("elides one past the cap", () => {
		const hint = enumValueHint("Size", "e.v1", enumWith(11));
		expect(hint).toContain("`VALUE_9`");
		expect(hint).not.toContain("`VALUE_10`");
		expect(hint?.endsWith("· _+1 more_")).toBe(true);
	});

	test("counts everything it left out", () => {
		const hint = enumValueHint("Size", "e.v1", enumWith(25));
		expect(hint?.endsWith("· _+15 more_")).toBe(true);
	});

	test("answers undefined for a type that is not an enum", () => {
		const registry = registryOf(CACHE);
		expect(enumValueHint("CacheOptions", "cache.v1", registry)).toBeUndefined();
		expect(enumValueHint("string", "cache.v1", registry)).toBeUndefined();
		expect(enumValueHint("Nothing", "cache.v1", registry)).toBeUndefined();
	});

	test("answers undefined for an enum that declares no values", () => {
		const registry = registryOf(`package e.v1;
enum Empty {
}
`);
		expect(registry.enumValues("e.v1.Empty")).toEqual([]);
		expect(enumValueHint("Empty", "e.v1", registry)).toBeUndefined();
	});
});

describe("renderAnnotationCard", () => {
	test("renders a bare option in full", () => {
		const registry = registryOf(
			`package x.v1;
extend google.protobuf.ServiceOptions {
  optional string default_host = 1049;
}
`,
			"x/v1/annotations.proto",
		);
		expect(
			renderAnnotationCard(annotation(registry, "x.v1.default_host"), registry),
		).toBe(`### \`(x.v1.default_host)\`
**service** option · \`string\` · field 1049

_Defined in_ \`x/v1/annotations.proto:3\``);
	});

	test("heads the card with the option name, target, type and number", () => {
		const registry = registryOf(CACHE);
		const lines = renderAnnotationCard(
			annotation(registry, "cache.v1.cache"),
			registry,
		).split("\n");
		expect(lines[0]).toBe("### `(cache.v1.cache)`");
		expect(lines[1]).toBe("**message** option · `CacheOptions` · field 52001");
	});

	test("carries the prose and every body field with its own doc", () => {
		const registry = registryOf(CACHE);
		const card = renderAnnotationCard(
			annotation(registry, "cache.v1.cache"),
			registry,
		);
		expect(card).toContain(
			"cache marks a resource as cached and configures how.",
		);
		expect(card).toContain("**Fields**");
		expect(card).toContain("- `enabled` — _bool_ · Turns caching on.");
		// A field with no doc gets no trailing separator.
		expect(card).toContain("- `ttl` — _Lease_\n");
		expect(card).toContain("- `tags` — _repeated string_");
	});

	test("hints the value set of an enum-typed body field", () => {
		const registry = registryOf(CACHE);
		const card = renderAnnotationCard(
			annotation(registry, "cache.v1.cache"),
			registry,
		);
		expect(card).toContain(
			"- `strategy` — _Strategy_\n  - `STRATEGY_UNSPECIFIED` · `STRATEGY_ASIDE`",
		);
		// A message-typed field is expanded by hovering it, not inline.
		expect(card).not.toContain("- `ttl` — _Lease_\n  - ");
	});

	test("shows a Values line for an option with an enum type and no body", () => {
		// The case that used to render nothing at all: the option is assigned an
		// enum member directly, so the members are the only thing worth knowing.
		const registry = registryOf(`package g.v1;
extend google.protobuf.FieldOptions {
  repeated Behavior field_behavior = 1052;
}
enum Behavior {
  BEHAVIOR_UNSPECIFIED = 0;
  REQUIRED = 2;
}
`);
		const card = renderAnnotationCard(
			annotation(registry, "g.v1.field_behavior"),
			registry,
		);
		expect(card).toContain("**Values** `BEHAVIOR_UNSPECIFIED` · `REQUIRED`");
		expect(card).not.toContain("**Fields**");
	});

	test("shows no Values line for an option with a scalar type", () => {
		const registry = registryOf(`package g.v1;
extend google.protobuf.ServiceOptions {
  optional string oauth_scopes = 1050;
}
`);
		expect(
			renderAnnotationCard(annotation(registry, "g.v1.oauth_scopes"), registry),
		).not.toContain("**Values**");
	});

	test("shows no Fields section for a body message with no fields", () => {
		const registry = registryOf(`package g.v1;
extend google.protobuf.MessageOptions {
  Marker marker = 1;
}
message Marker {
}
`);
		const card = renderAnnotationCard(
			annotation(registry, "g.v1.marker"),
			registry,
		);
		expect(card).not.toContain("**Fields**");
	});

	test("fences the usage example as proto", () => {
		const registry = registryOf(CACHE);
		const card = renderAnnotationCard(
			annotation(registry, "cache.v1.cache"),
			registry,
		);
		expect(card).toContain(
			"```proto\noption (cache.v1.cache) = {\n  enabled: true\n};\n```",
		);
	});

	test("links the footer when the absolute path is known", () => {
		const registry = registryOf(CACHE, "cache/v1/annotations.proto");
		const site: DefinitionSite = {
			importPath: "cache/v1/annotations.proto",
			path: "/repo/cache/v1/annotations.proto",
			line: 8,
		};
		const card = renderAnnotationCard(
			annotation(registry, "cache.v1.cache"),
			registry,
			site,
		);
		// Lines are 0-based internally and 1-based in the link.
		expect(card).toContain(
			"_Defined in_ [`cache/v1/annotations.proto:9`](file:///repo/cache/v1/annotations.proto#L9)",
		);
	});

	test("escapes a path and normalises Windows separators in the link", () => {
		const registry = registryOf(CACHE);
		const card = renderAnnotationCard(
			annotation(registry, "cache.v1.cache"),
			registry,
			{
				importPath: "cache/v1/annotations.proto",
				path: "C:\\my repo\\cache.proto",
				line: 0,
			},
		);
		expect(card).toContain("(file://C:/my%20repo/cache.proto#L1)");
	});

	test("falls back to the descriptor's own import path and line", () => {
		const registry = registryOf(CACHE, "cache/v1/annotations.proto");
		const descriptor = annotation(registry, "cache.v1.cache");
		const card = renderAnnotationCard(descriptor, registry);
		expect(card).toContain(
			`_Defined in_ \`cache/v1/annotations.proto:${descriptor.line + 1}\``,
		);
	});

	test("omits the footer when nothing knows where it came from", () => {
		const registry = registryOf(CACHE, "");
		expect(
			renderAnnotationCard(annotation(registry, "cache.v1.cache"), registry),
		).not.toContain("_Defined in_");
	});
});

describe("renderFieldCard", () => {
	const registry = registryOf(CACHE);
	const cache = annotation(registry, "cache.v1.cache");

	test("heads the card with the dotted path and the owning option", () => {
		const field = registry.fieldAt(cache, ["enabled"]);
		if (!field) {
			throw new Error("fixture declares enabled");
		}
		const lines = renderFieldCard(cache, ["enabled"], field, registry).split(
			"\n",
		);
		expect(lines[0]).toBe("### `enabled`");
		expect(lines[1]).toBe("`bool` · field 1 · in `(cache.v1.cache)`");
		expect(lines[3]).toBe("Turns caching on.");
	});

	test("writes a nested path as it was written in the option", () => {
		const field = registry.fieldAt(cache, ["ttl", "seconds"]);
		if (!field) {
			throw new Error("fixture declares ttl.seconds");
		}
		const card = renderFieldCard(cache, ["ttl", "seconds"], field, registry);
		expect(card.split("\n")[0]).toBe("### `ttl.seconds`");
		expect(card).toContain("Whole seconds.");
	});

	test("expands a message-typed field's own shape", () => {
		const field = registry.fieldAt(cache, ["ttl"]);
		if (!field) {
			throw new Error("fixture declares ttl");
		}
		const card = renderFieldCard(cache, ["ttl"], field, registry);
		expect(card).toContain("**`cache.v1.Lease` fields**");
		expect(card).toContain("- `seconds` — _int64_ · Whole seconds.");
		// A message has no value set of its own.
		expect(card).not.toContain("**Values**");
	});

	test("lists the values of an enum-typed field", () => {
		const field = registry.fieldAt(cache, ["strategy"]);
		if (!field) {
			throw new Error("fixture declares strategy");
		}
		const card = renderFieldCard(cache, ["strategy"], field, registry);
		expect(card).toContain(
			"**Values** `STRATEGY_UNSPECIFIED` · `STRATEGY_ASIDE`",
		);
	});

	test("resolves an enum against the body's namespace, not the option's", () => {
		// The option lives in `a.v1`, its body message and that body's enum live
		// in `b.v1`. Resolving `Kind` against the option's own package finds
		// nothing, which is how these value lists went missing.
		const split = new AnnotationRegistryImpl();
		load(
			split,
			1,
			`package a.v1;
extend google.protobuf.MessageOptions {
  b.v1.Body thing = 1;
}
`,
		);
		load(
			split,
			2,
			`package b.v1;
message Body {
  Kind kind = 1;
}
enum Kind {
  KIND_UNSPECIFIED = 0;
  KIND_A = 1;
}
`,
		);
		expect(split.resolveEnumFqn("Kind", "a.v1")).toBeUndefined();
		expect(split.resolveEnumFqn("Kind", "b.v1")).toBe("b.v1.Kind");

		const descriptor = annotation(split, "a.v1.thing");
		const field = split.fieldAt(descriptor, ["kind"]);
		if (!field) {
			throw new Error("fixture declares kind");
		}
		expect(renderFieldCard(descriptor, ["kind"], field, split)).toContain(
			"**Values** `KIND_UNSPECIFIED` · `KIND_A`",
		);
		expect(renderAnnotationCard(descriptor, split)).toContain(
			"  - `KIND_UNSPECIFIED` · `KIND_A`",
		);
	});

	test("falls back to the option's namespace when the body is unknown", () => {
		// Hovering inside an option whose body message was never indexed: there
		// is no body namespace to resolve against, so the option's own package
		// is the only thing left to try.
		const registryWithEnum = registryOf(`package q.v1;
extend google.protobuf.MessageOptions {
  Missing thing = 1;
}
enum Kind {
  KIND_UNSPECIFIED = 0;
}
`);
		const descriptor = annotation(registryWithEnum, "q.v1.thing");
		expect(registryWithEnum.body(descriptor)).toBeUndefined();
		const card = renderFieldCard(
			descriptor,
			["kind"],
			{ name: "kind", type: "Kind", number: 1, repeated: false },
			registryWithEnum,
		);
		expect(card).toContain("**Values** `KIND_UNSPECIFIED`");
	});

	test("renders a field with no doc and no nested shape", () => {
		const registry2 = registryOf(`package p.v1;
extend google.protobuf.FieldOptions {
  Body b = 1;
}
message Body {
  string name = 3;
}
`);
		const descriptor = annotation(registry2, "p.v1.b");
		const field = registry2.fieldAt(descriptor, ["name"]);
		if (!field) {
			throw new Error("fixture declares name");
		}
		expect(renderFieldCard(descriptor, ["name"], field, registry2)).toBe(
			"### `name`\n`string` · field 3 · in `(p.v1.b)`\n",
		);
	});
});

describe("renderDeclarationCard", () => {
	test("appends how the annotation is written at a use site", () => {
		const registry = registryOf(CACHE);
		const descriptor = annotation(registry, "cache.v1.cache");
		const card = renderDeclarationCard(descriptor, registry);
		expect(card).toContain(renderAnnotationCard(descriptor, registry));
		expect(
			card.endsWith("_Used as_ `option (cache.v1.cache) = …;` on a message."),
		).toBe(true);
	});

	test("names the target the annotation may decorate", () => {
		const registry = registryOf(`package m.v1;
extend google.protobuf.MethodOptions {
  optional string tool = 51001;
}
`);
		expect(
			renderDeclarationCard(annotation(registry, "m.v1.tool"), registry),
		).toContain("_Used as_ `option (m.v1.tool) = …;` on a rpc.");
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"renders a card for every annotation without losing its heading",
		async () => {
			const registry = await referenceRegistry();
			for (const descriptor of registry.all()) {
				const site = registry.siteOf(descriptor);
				const card = renderAnnotationCard(
					descriptor,
					registry,
					site && {
						importPath: site.importPath,
						path: site.path,
						line: descriptor.line,
					},
				);
				expect(card.startsWith(`### \`(${descriptor.fqn})\``)).toBe(true);
				expect(card).toContain(`field ${descriptor.number}`);
				expect(card).toContain(`**${targetLabel(descriptor.target)}** option`);
				// Scanned from disk, so every footer is a link.
				expect(card).toContain("_Defined in_ [`");
				expect(summaryLine(descriptor).length).toBeGreaterThan(0);
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"gives google.api.field_behavior a Values line",
		async () => {
			// An option with no body message but an enum type. It used to render
			// as a name and a number with nothing a reader could act on.
			const registry = await referenceRegistry();
			const descriptor = annotation(registry, "google.api.field_behavior");
			expect(registry.body(descriptor)).toBeUndefined();
			const card = renderAnnotationCard(descriptor, registry);
			expect(card).toContain("**Values**");
			expect(card).toContain("`REQUIRED`");
			expect(card).toContain("`OUTPUT_ONLY`");
			expect(card).not.toContain("more_");
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"keeps a tab-indented godoc example whole",
		async () => {
			// `cache/v1/annotations.proto` marks its example by indenting one tab
			// past the `//`. Eating that tab flattened the outermost lines to
			// column zero, so they were read as prose and the example survived as
			// a fragment without its `option (...) = { … };` wrapper.
			const registry = await referenceRegistry();
			const descriptor = annotation(registry, "cache.v1.cache");
			expect(descriptor.doc).toBe(
				"cache marks a resource as cached and configures how.",
			);
			expect(
				descriptor.example?.startsWith("option (cache.v1.cache) = {"),
			).toBe(true);
			expect(descriptor.example?.endsWith("};")).toBe(true);
			const card = renderAnnotationCard(descriptor, registry);
			expect(card).toContain(`\`\`\`proto\n${descriptor.example}\n\`\`\``);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"fences the example of every annotation that documents one",
		async () => {
			const registry = await referenceRegistry();
			const withExample = registry
				.all()
				.filter((descriptor) => descriptor.example);
			// Roughly a third of the corpus documents a usage example; a renderer
			// or extractor change that dropped them would leave this near zero.
			expect(withExample.length).toBeGreaterThanOrEqual(10);
			expect(withExample.length).toBeLessThan(registry.all().length);
			for (const descriptor of withExample) {
				const card = renderAnnotationCard(descriptor, registry);
				expect(card).toContain(`\`\`\`proto\n${descriptor.example}\n\`\`\``);
				// The example is code, so it must not have leaked into the prose.
				expect(descriptor.doc ?? "").not.toContain(descriptor.example ?? "");
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"lists the fields of every option that has a body",
		async () => {
			const registry = await referenceRegistry();
			let rendered = 0;
			for (const descriptor of registry.all()) {
				const body = registry.body(descriptor);
				if (!body || body.fields.length === 0) {
					continue;
				}
				rendered++;
				const card = renderAnnotationCard(descriptor, registry);
				expect(card).toContain("**Fields**");
				for (const field of body.fields) {
					expect(card).toContain(`- \`${field.name}\` — _${fieldType(field)}_`);
				}
			}
			expect(rendered).toBeGreaterThan(10);
		},
	);
});

/*
 * Suspected bug, left skipped deliberately. Symptom of the resolution problem
 * recorded in registry.test.ts.
 *
 * `buffers.v1.MethodOptions.transport` is typed `Transport`, an enum declared
 * beside it in `buffers.v1`. `resolveTypeFqn` finds no message of that name in
 * scope and falls through to its unique-suffix match, which lands on
 * `protobuf.fhir.base.workflow.v5.transport.Transport` — a FHIR resource. The
 * field therefore reports a `messageFqn`, which suppresses the enum value hint
 * and makes `renderFieldCard` expand a 60-field unrelated message instead.
 *
 * Expected: hovering `transport` lists the four `TRANSPORT_*` values.
 */
test.skip("lists the values of an enum-typed field whose name a message also uses", async () => {
	const registry = await referenceRegistry();
	const descriptor = annotation(registry, "buffers.v1.method");
	const field = registry.fieldAt(descriptor, ["transport"]);
	if (!field) {
		throw new Error("corpus declares buffers.v1.MethodOptions.transport");
	}
	expect(field.messageFqn).toBeUndefined();
	const card = renderFieldCard(descriptor, ["transport"], field, registry);
	expect(card).toContain("**Values** `TRANSPORT_UNSPECIFIED`");
	expect(card).not.toContain("protobuf.fhir");
});
