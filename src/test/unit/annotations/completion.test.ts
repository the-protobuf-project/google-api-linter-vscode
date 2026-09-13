/**
 * Tests for `AnnotationCompletionProvider`.
 *
 * Four behaviours carry the feature and none of them can be eyeballed from the
 * source:
 *
 * **Value completion.** At `(google.api.field_behavior) = ▮` the provider used
 * to offer annotation *names* — every option legal on the element, not one of
 * which is legal to type after the `=`. The fix reads the option's own type and
 * offers only closed value sets, so the tests below pin both the enum members
 * that must appear and the string- and int-typed fields that must stay silent.
 *
 * **Target awareness.** `byTarget` decides what is offered, so a field option
 * must never appear at file level and vice versa.
 *
 * **Generated snippets.** The inserted text is derived from the message the
 * `extend` block names, including enum choices taken from the enum's own
 * values, so the caps on expansion and on choice count are worth pinning.
 *
 * **Import fix-up.** An option whose declaring file is not in the import
 * closure does not compile however well it is spelled, so accepting the
 * completion has to insert the import too — and must not insert one that is
 * already reachable.
 *
 * The corpus-backed tests use the real annotations rather than invented ones:
 * `google.api.field_behavior` is a bare enum-valued option, `buf.validate.field`
 * a 26-field body, `orm.v1.table` and `cache.v1.cache` message options. Hand
 * written registries appear only where the corpus has no example of a
 * threshold, such as an enum with more values than a snippet choice may hold.
 */

import { describe, expect, test } from "bun:test";
import {
	AnnotationCompletionProvider,
	ANNOTATION_TRIGGER_CHARACTERS,
} from "../../../annotations/completion";
import { extractAnnotations } from "../../../annotations/extractor";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import { AnnotationSource } from "../../../annotations/resolve";
import {
	atCursor,
	hasReferenceCorpus,
	referenceRegistry,
} from "../support/fixtures";
import { CancellationTokenNone, CompletionItemKind } from "../support/vscode";

/** Runs only where the sibling protobuf checkout and buf cache exist. */
const corpusTest = test.skipIf(!hasReferenceCorpus());

/** A provider over a registry, wired the way activation wires it. */
function providerFor(
	registry: AnnotationRegistryImpl,
): AnnotationCompletionProvider {
	return new AnnotationCompletionProvider(
		new AnnotationSource(undefined, registry),
	);
}

/**
 * Completes at the `▮` of a fixture.
 * @param registry - Registry to complete against
 * @param marked - Proto source with exactly one cursor marker
 * @param token - Cancellation token, defaulting to a live one
 * @returns Whatever the provider offers there
 */
function completeAt(
	registry: AnnotationRegistryImpl,
	marked: string,
	token: { isCancellationRequested: boolean } = CancellationTokenNone,
) {
	const { document, position } = atCursor(marked);
	return providerFor(registry).provideCompletionItems(
		document,
		position,
		token as never,
	);
}

/** Labels of an offer, in the order the provider returned them. */
function labels(items: { label: string }[] | undefined): string[] {
	return (items ?? []).map((item) => item.label);
}

/** Labels sorted the way a client sorts them, by `sortText`. */
function sorted(
	items: { label: string; sortText?: string }[] | undefined,
): string[] {
	return [...(items ?? [])]
		.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label))
		.map((item) => item.label);
}

/** The nine members of `google.api.FieldBehavior`, in declaration order. */
const FIELD_BEHAVIOR = [
	"FIELD_BEHAVIOR_UNSPECIFIED",
	"OPTIONAL",
	"REQUIRED",
	"OUTPUT_ONLY",
	"INPUT_ONLY",
	"IMMUTABLE",
	"UNORDERED_LIST",
	"NON_EMPTY_DEFAULT",
	"IDENTIFIER",
];

describe("value completion", () => {
	corpusTest("offers the option's own enum after `=`", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`syntax = "proto3";
package x.v1;
import "google/api/field_behavior.proto";

message M {
  string name = 1 [(google.api.field_behavior) = ▮];
}
`,
		);
		expect(labels(items)).toEqual(FIELD_BEHAVIOR);
		for (const item of items ?? []) {
			expect(item.kind).toBe(CompletionItemKind.EnumMember);
			expect(item.detail).toBe("google.api.FieldBehavior");
		}
	});

	corpusTest("keeps offering them once the value is half typed", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string name = 1 [(google.api.field_behavior) = REQ▮];
}
`,
		);
		expect(labels(items)).toEqual(FIELD_BEHAVIOR);
		// The replaced range covers the typed text and nothing else: widening it
		// would eat the `]`, narrowing it would leave `REQREQUIRED`.
		const range = items?.[0].range;
		expect(range?.start.line).toBe(2);
		expect(range?.end.line).toBe(2);
		expect(range?.end.character).toBe(range ? range.start.character + 3 : -1);
	});

	corpusTest("offers a body field's enum inside a text-format body", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string s = 1 [(buf.validate.field) = { ignore: ▮ }];
}
`,
		);
		expect(labels(items)).toEqual([
			"IGNORE_UNSPECIFIED",
			"IGNORE_IF_ZERO_VALUE",
			"IGNORE_ALWAYS",
		]);
		expect(items?.[0].detail).toBe("buf.validate.Ignore");
	});

	corpusTest("resolves a body field split across lines", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string s = 1 [(buf.validate.field) = {
    ignore: ▮
  }];
}
`,
		);
		expect(labels(items)).toEqual([
			"IGNORE_UNSPECIFIED",
			"IGNORE_IF_ZERO_VALUE",
			"IGNORE_ALWAYS",
		]);
	});

	corpusTest("resolves the `.accessor = value` form", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string s = 1 [(buf.validate.field).ignore = ▮];
}
`,
		);
		expect(labels(items)).toEqual([
			"IGNORE_UNSPECIFIED",
			"IGNORE_IF_ZERO_VALUE",
			"IGNORE_ALWAYS",
		]);
		expect(items?.[0].detail).toBe("buf.validate.Ignore");
	});

	corpusTest("offers exactly true and false for a bool field", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string s = 1 [(buf.validate.field) = { required: ▮ }];
}
`,
		);
		expect(labels(items)).toEqual(["true", "false"]);
		expect(items?.map((item) => item.kind)).toEqual([
			CompletionItemKind.Keyword,
			CompletionItemKind.Keyword,
		]);
		expect(items?.map((item) => item.detail)).toEqual(["bool", "bool"]);
		// `true` first: a bool option is almost always being switched on.
		expect(sorted(items)).toEqual(["true", "false"]);
	});

	corpusTest("sorts `_UNSPECIFIED` last and the rest as declared", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string name = 1 [(google.api.field_behavior) = ▮];
}
`,
		);
		expect(sorted(items)).toEqual([
			...FIELD_BEHAVIOR.slice(1),
			"FIELD_BEHAVIOR_UNSPECIFIED",
		]);
		const unspecified = items?.find((item) =>
			item.label.endsWith("_UNSPECIFIED"),
		);
		expect(unspecified?.sortText).toBe("zzzz");
		// The one item that needs explaining carries its own note without a
		// `resolveCompletionItem` round trip.
		expect(String(unspecified?.documentation?.value)).toContain(
			"proto3 default",
		);
	});

	corpusTest("offers nothing for a string-typed field", async () => {
		expect(
			completeAt(
				await referenceRegistry(),
				`package x.v1;
message M {
  option (orm.v1.table) = { table: ▮ };
}
`,
			),
		).toBeUndefined();
	});

	corpusTest("offers nothing for an int-typed field", async () => {
		expect(
			completeAt(
				await referenceRegistry(),
				`package x.v1;
message M {
  string s = 1 [(orm.v1.column) = { max_length: ▮ }];
}
`,
			),
		).toBeUndefined();
	});

	corpusTest("offers nothing for a message-typed field", async () => {
		// `indexes` is a repeated `IndexDef`; its own fields complete once the
		// `{` is open, but the field itself has no closed value set.
		expect(
			completeAt(
				await referenceRegistry(),
				`package x.v1;
message M {
  option (orm.v1.table) = { indexes: ▮ };
}
`,
			),
		).toBeUndefined();
	});

	corpusTest("offers nothing for an unknown field name", async () => {
		expect(
			completeAt(
				await referenceRegistry(),
				`package x.v1;
message M {
  string s = 1 [(buf.validate.field) = { soft_delete: ▮ }];
}
`,
			),
		).toBeUndefined();
	});

	corpusTest("offers nothing for an unknown annotation", async () => {
		expect(
			completeAt(
				await referenceRegistry(),
				`package x.v1;
message M {
  string s = 1 [(nowhere.v1.absent) = ▮];
}
`,
			),
		).toBeUndefined();
	});

	corpusTest("still offers names in bracket name position", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string name = 1 [▮];
}
`,
		);
		expect((items ?? []).length).toBeGreaterThan(0);
		for (const item of items ?? []) {
			expect(item.label.startsWith("(")).toBe(true);
		}
	});

	corpusTest("still offers names in statement name position", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect((items ?? []).length).toBeGreaterThan(0);
		for (const item of items ?? []) {
			expect(item.label.startsWith("(")).toBe(true);
		}
	});
});

describe("cancellation", () => {
	corpusTest("returns nothing once the token is cancelled", async () => {
		expect(
			completeAt(
				await referenceRegistry(),
				`package x.v1;
message M {
  string name = 1 [▮];
}
`,
				{ isCancellationRequested: true },
			),
		).toBeUndefined();
	});

	test("returns nothing when no registry exists yet", () => {
		const provider = new AnnotationCompletionProvider(
			new AnnotationSource(undefined, undefined),
		);
		const { document, position } = atCursor("message M {\n  string s = 1 [▮];\n}");
		expect(
			provider.provideCompletionItems(
				document,
				position,
				CancellationTokenNone as never,
			),
		).toBeUndefined();
	});
});

describe("trigger characters", () => {
	test("includes the assignment characters value completion needs", () => {
		// `=` and `:` are what put the cursor in value position; without them the
		// popup only appears if the author happens to keep typing.
		expect(ANNOTATION_TRIGGER_CHARACTERS).toContain("=");
		expect(ANNOTATION_TRIGGER_CHARACTERS).toContain(":");
		expect(ANNOTATION_TRIGGER_CHARACTERS).toContain("(");
	});
});

/**
 * Builds a registry from one hand-written file, for thresholds the corpus has
 * no example of.
 * @param text - Proto source declaring the annotations
 * @param importPath - Import path the file is reachable by
 * @returns A registry holding exactly that file
 */
function registryFrom(
	text: string,
	importPath = "x/v1/annotations.proto",
): AnnotationRegistryImpl {
	const registry = new AnnotationRegistryImpl();
	registry.ingest(extractAnnotations(text, { fileId: 1, importPath }));
	return registry;
}

/** `(fqn)` labels of every annotation the registry allows on a target. */
function offeredFor(
	registry: AnnotationRegistryImpl,
	target: Parameters<AnnotationRegistryImpl["byTarget"]>[0],
): string[] {
	return registry.byTarget(target).map((d) => `(${d.fqn})`);
}

describe("target-aware name completion", () => {
	corpusTest("offers field options inside a field's brackets", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  string name = 1 [▮];
}
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "Field").sort());
		expect(labels(items)).toContain("(google.api.field_behavior)");
		// A message option in field brackets would not compile.
		expect(labels(items)).not.toContain("(orm.v1.table)");
	});

	corpusTest("offers file options at file level", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`syntax = "proto3";
package x.v1;

option ▮
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "File").sort());
		expect(labels(items)).not.toContain("(google.api.field_behavior)");
	});

	corpusTest("offers method options inside an rpc", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
service S {
  rpc Get(GetRequest) returns (GetResponse) {
    option ▮
  }
}
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "Method").sort());
		expect(labels(items)).toContain("(google.api.http)");
	});

	corpusTest("offers message options on a message", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "Message").sort());
		expect(labels(items)).toContain("(orm.v1.table)");
	});

	corpusTest("offers service options on a service", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
service S {
  option ▮
}
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "Service").sort());
	});

	corpusTest("offers enum options on an enum", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
enum E {
  option ▮
}
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "Enum").sort());
	});

	corpusTest("offers enum value options in an enum member's brackets", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
enum E {
  E_UNSPECIFIED = 0 [▮];
}
`,
		);
		expect(labels(items).sort()).toEqual(
			offeredFor(registry, "EnumValue").sort(),
		);
	});

	corpusTest("offers oneof options inside a oneof", async () => {
		const registry = await referenceRegistry();
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  oneof choice {
    option ▮
  }
}
`,
		);
		expect(labels(items).sort()).toEqual(offeredFor(registry, "Oneof").sort());
	});

	corpusTest("sorts the file's own package ahead of its dependencies", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package orm.v1;
message M {
  option ▮
}
`,
		);
		const own = items?.find((item) => item.label === "(orm.v1.table)");
		const other = items?.find((item) => item.label === "(cache.v1.cache)");
		expect(own?.sortText?.startsWith("0")).toBe(true);
		expect(other?.sortText?.startsWith("1")).toBe(true);
	});
});

/** Snippet text of one offered annotation, or undefined when it was not offered. */
function snippetOf(
	items: { label: string; insertText?: unknown }[] | undefined,
	fqn: string,
): string | undefined {
	const item = (items ?? []).find((entry) => entry.label === `(${fqn})`);
	const insert = item?.insertText as { value?: string } | undefined;
	return typeof insert === "string" ? insert : insert?.value;
}

describe("generated snippets", () => {
	corpusTest("offers the enum's own values for a bare enum option", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string name = 1 [▮];
}
`,
		);
		expect(snippetOf(items, "google.api.field_behavior")).toBe(
			`(google.api.field_behavior) = \${1|${FIELD_BEHAVIOR.join(",")}|}`,
		);
	});

	corpusTest("expands a body of exactly MAX_EXPANDED_FIELDS fields", async () => {
		// `mcp.field` has four: the boundary that still expands inline.
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string name = 1 [▮];
}
`,
		);
		expect(snippetOf(items, "mcp.field")).toBe(
			'(mcp.field) = {\n\tdescription: "${1:value}"\n' +
				'\texamples: ["${2:value}"]\n' +
				"\tdeprecated: ${3|true,false|}\n" +
				'\tformat: "${4:value}"\n}',
		);
	});

	corpusTest("inserts an empty body past the expansion cap", async () => {
		// `orm.v1.table` has five fields, one past the cap.
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect(snippetOf(items, "orm.v1.table")).toBe(
			"(orm.v1.table) = {\n\t$1\n};",
		);
	});

	corpusTest("wraps a repeated message field in brackets", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string name = 1 [▮];
}
`,
		);
		expect(snippetOf(items, "google.api.field_info")).toBe(
			"(google.api.field_info) = {\n\tformat: ${1:value}\n" +
				"\treferenced_types: [{\n\t\t$2\n\t}]\n}",
		);
	});

	test("renders scalar placeholders by type", () => {
		const registry = registryFrom(`syntax = "proto3";
package x.v1;

message Body {
  string s = 1;
  int32 n = 2;
  bool b = 3;
  bytes raw = 4;
}

extend google.protobuf.MessageOptions {
  Body thing = 50001;
}
`);
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect(snippetOf(items, "x.v1.thing")).toBe(
			'(x.v1.thing) = {\n\ts: "${1:value}"\n\tn: ${2:0}\n' +
				'\tb: ${3|true,false|}\n\traw: "${4:value}"\n};',
		);
	});

	test("offers a choice for an enum of exactly MAX_ENUM_CHOICES values", () => {
		const values = Array.from({ length: 12 }, (_, i) => `V${i}`);
		const registry = registryFrom(`syntax = "proto3";
package x.v1;

enum Kind {
${values.map((v, i) => `  ${v} = ${i};`).join("\n")}
}

extend google.protobuf.MessageOptions {
  Kind kind = 50001;
}
`);
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect(snippetOf(items, "x.v1.kind")).toBe(
			`(x.v1.kind) = \${1|${values.join(",")}|};`,
		);
	});

	test("falls back to a placeholder one value past the cap", () => {
		const values = Array.from({ length: 13 }, (_, i) => `V${i}`);
		const registry = registryFrom(`syntax = "proto3";
package x.v1;

enum Kind {
${values.map((v, i) => `  ${v} = ${i};`).join("\n")}
}

extend google.protobuf.MessageOptions {
  Kind kind = 50001;
}
`);
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  option ▮
}
`,
		);
		// A thirteen-way choice is a scrolling menu, so the first value goes in as
		// an editable placeholder instead.
		expect(snippetOf(items, "x.v1.kind")).toBe("(x.v1.kind) = ${1:V0};");
	});

	test("falls back to a placeholder for a type it cannot resolve", () => {
		const registry = registryFrom(`syntax = "proto3";
package x.v1;

extend google.protobuf.MessageOptions {
  some.other.Thing thing = 50001;
}
`);
		const items = completeAt(
			registry,
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect(snippetOf(items, "x.v1.thing")).toBe("(x.v1.thing) = ${1:value};");
	});
});

describe("insert shape", () => {
	corpusTest("writes the option keyword and semicolon in statement position", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  ▮
}
`,
		);
		expect(snippetOf(items, "store.v1.table")).toBe(
			"option (store.v1.table) = {\n\toutbox: ${1|true,false|}\n};",
		);
	});

	corpusTest("writes neither inside a field's brackets", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  string s = 1 [▮];
}
`,
		);
		expect(snippetOf(items, "orm.v1.query")).toBe(
			"(orm.v1.query) = {\n\tfilterable: ${1|true,false|}\n" +
				"\tsortable: ${2|true,false|}\n\tsearch: ${3|true,false|}\n}",
		);
	});

	corpusTest("does not repeat an `option` keyword already typed", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  option ▮
}
`,
		);
		expect(snippetOf(items, "store.v1.table")?.startsWith("(")).toBe(true);
	});

	corpusTest("replaces an existing open paren rather than nesting one", async () => {
		const { document, position } = atCursor(`package x.v1;
message M {
  option (▮)
}
`);
		const registry = await referenceRegistry();
		const items = providerFor(registry).provideCompletionItems(
			document,
			position,
			CancellationTokenNone as never,
		);
		const item = items?.find((entry) => entry.label === "(store.v1.table)");
		// The range starts on the `(` and ends past the `)`, so accepting swaps
		// the whole pair instead of producing `((store.v1.table))`.
		expect(item?.range?.start.character).toBe(position.character - 1);
		expect(item?.range?.end.character).toBe(position.character + 1);
		// The filter text keeps the paren so the typed `(` still matches.
		expect(item?.filterText).toBe("(store.v1.table");
		expect((item?.insertText as { value: string }).value.startsWith("(")).toBe(
			true,
		);
	});

	corpusTest("does not repeat a value the option already has", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  option (store.v1.tab▮) = { outbox: true };
}
`,
		);
		// Retyping the name of an assigned option inserts the name alone: no
		// second `= {...}`, no second `;`.
		expect(snippetOf(items, "store.v1.table")).toBe("(store.v1.table)");
	});

	corpusTest("does not repeat a semicolon already present", async () => {
		const items = completeAt(
			await referenceRegistry(),
			`package x.v1;
message M {
  option ▮;
}
`,
		);
		expect(snippetOf(items, "store.v1.table")).toBe(
			"(store.v1.table) = {\n\toutbox: ${1|true,false|}\n}",
		);
	});

	corpusTest("replaces only the partially typed name", async () => {
		const { document, position } = atCursor(`package x.v1;
message M {
  option orm.v1.ta▮
}
`);
		const registry = await referenceRegistry();
		const items = providerFor(registry).provideCompletionItems(
			document,
			position,
			CancellationTokenNone as never,
		);
		const item = items?.find((entry) => entry.label === "(orm.v1.table)");
		expect(item?.range?.start.character).toBe(position.character - 9);
		expect(item?.range?.end.character).toBe(position.character);
		expect(item?.filterText).toBe("orm.v1.table");
	});
});
