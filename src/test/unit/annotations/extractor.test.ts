/**
 * Tests for `extractAnnotations`, the one place the annotation vocabulary comes
 * from.
 *
 * The rule these tests defend is that nothing about a specific annotation is
 * ever written down in the extension: the fully-qualified name, the legal
 * target, the body type, the docs, the example and the field number all come
 * out of the `extend google.protobuf.*Options` block. Hardcoding `mcp.protobuf.*`
 * is what left completion and snippets two generations stale and silently dead,
 * so the corpus assertions below check derivation rather than any particular
 * name.
 *
 * The rest pins the line-based parser: brace counting through strings and
 * comments, nesting, oneofs, CRLF, a buffer that ends mid-block.
 */

import { describe, expect, test } from "bun:test";
import {
	ALL_TARGETS,
	type ExtractContext,
	extractAnnotations,
	TARGET_LABELS,
} from "../../../annotations/extractor";
import type { AnnotationTarget } from "../../../index/types";
import { hasReferenceCorpus, referenceRegistry } from "../support/fixtures";

const CTX: ExtractContext = {
	fileId: 7,
	importPath: "x/v1/annotations.proto",
	path: "/repo/x/v1/annotations.proto",
};

/** Extracts with the shared context, so tests read as source-in, facts-out. */
function extract(text: string) {
	return extractAnnotations(text, CTX);
}

/** Every extendee protobuf defines, one block each. */
const ALL_EXTENDS = `syntax = "proto3";
package x.v1;

extend google.protobuf.FileOptions {
  optional string on_file = 1;
}
extend google.protobuf.MessageOptions {
  optional string on_message = 2;
}
extend google.protobuf.FieldOptions {
  optional string on_field = 3;
}
extend google.protobuf.OneofOptions {
  optional string on_oneof = 4;
}
extend google.protobuf.EnumOptions {
  optional string on_enum = 5;
}
extend google.protobuf.EnumValueOptions {
  optional string on_enum_value = 6;
}
extend google.protobuf.ServiceOptions {
  optional string on_service = 7;
}
extend google.protobuf.MethodOptions {
  optional string on_method = 8;
}
`;

describe("target derivation", () => {
	test("maps every extendee to the element it may decorate", () => {
		const byName = new Map(
			extract(ALL_EXTENDS).annotations.map((a) => [a.name, a.target]),
		);
		expect(byName.get("on_file")).toBe("File");
		expect(byName.get("on_message")).toBe("Message");
		expect(byName.get("on_field")).toBe("Field");
		expect(byName.get("on_oneof")).toBe("Oneof");
		expect(byName.get("on_enum")).toBe("Enum");
		expect(byName.get("on_enum_value")).toBe("EnumValue");
		expect(byName.get("on_service")).toBe("Service");
		expect(byName.get("on_method")).toBe("Method");
	});

	test("covers the whole target vocabulary from one file", () => {
		const seen = new Set(extract(ALL_EXTENDS).annotations.map((a) => a.target));
		expect([...seen].sort()).toEqual([...ALL_TARGETS].sort());
	});

	test("labels every target", () => {
		for (const target of ALL_TARGETS) {
			expect(TARGET_LABELS[target].length).toBeGreaterThan(0);
		}
		expect(Object.keys(TARGET_LABELS).sort()).toEqual([...ALL_TARGETS].sort());
	});

	test("ignores an extend block whose extendee is not an options message", () => {
		const file = extract(`package x.v1;
extend some.other.Message {
  optional string not_an_option = 9;
}
`);
		expect(file.annotations).toEqual([]);
		// An extend frame is not a message declaration either.
		expect(file.messages).toEqual([]);
	});

	test("ignores a message that merely looks like an options block", () => {
		const file = extract(`package x.v1;
message FileOptions {
  string name = 1;
}
`);
		expect(file.annotations).toEqual([]);
		expect(file.messages.map((m) => m.fqn)).toEqual(["x.v1.FileOptions"]);
	});
});

describe("descriptor fields", () => {
	test("derives fqn, namespace, number, type and source location", () => {
		const [annotation] = extract(`syntax = "proto3";
package cache.v1;

extend google.protobuf.MessageOptions {
  CacheOptions cache = 52001;
}
`).annotations;
		expect(annotation).toMatchObject({
			fqn: "cache.v1.cache",
			name: "cache",
			namespace: "cache.v1",
			target: "Message",
			type: "CacheOptions",
			number: 52001,
			repeated: false,
			importPath: CTX.importPath,
			fileId: CTX.fileId,
			line: 4,
		});
	});

	test("records repeated-ness", () => {
		const byName = new Map(
			extract(`package x.v1;
extend google.protobuf.MethodOptions {
  repeated string many = 1;
  optional string one = 2;
  string implicit = 3;
}
`).annotations.map((a) => [a.name, a.repeated]),
		);
		expect(byName.get("many")).toBe(true);
		expect(byName.get("one")).toBe(false);
		expect(byName.get("implicit")).toBe(false);
	});

	test("keeps the option body type exactly as written", () => {
		const byName = new Map(
			extract(`package x.v1;
extend google.protobuf.FieldOptions {
  optional x.v1.Deep deep = 1;
  optional .x.v1.Rooted rooted = 2;
  optional bool scalar = 3;
}
`).annotations.map((a) => [a.name, a.type]),
		);
		expect(byName.get("deep")).toBe("x.v1.Deep");
		expect(byName.get("rooted")).toBe(".x.v1.Rooted");
		expect(byName.get("scalar")).toBe("bool");
	});

	test("reads a field whose options bracket wraps onto later lines", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.EnumValueOptions {
  optional string wrapped = 4 [
    deprecated = true
  ];
}
`).annotations;
		expect(annotation).toMatchObject({ name: "wrapped", number: 4 });
	});

	test("collects every extend block in one file", () => {
		const file = extract(`package x.v1;
extend google.protobuf.FileOptions {
  optional string a = 1;
}

extend google.protobuf.MethodOptions {
  optional string b = 2;
  optional string c = 3;
}
`);
		expect(file.annotations.map((a) => a.fqn)).toEqual([
			"x.v1.a",
			"x.v1.b",
			"x.v1.c",
		]);
		expect(file.annotations.map((a) => a.target)).toEqual([
			"File",
			"Method",
			"Method",
		]);
	});

	test("skips option and reserved statements inside an extend block", () => {
		const file = extract(`package x.v1;
extend google.protobuf.MethodOptions {
  option deprecated = true;
  reserved 5, 6;
  reserved "old_name";
  optional string real = 11;
}
`);
		expect(file.annotations.map((a) => a.name)).toEqual(["real"]);
	});

	test("yields nothing for an extend block with no fields", () => {
		const file = extract(`package x.v1;
extend google.protobuf.FileOptions {
}
`);
		expect(file.annotations).toEqual([]);
		expect(file.messages).toEqual([]);
	});
});

describe("documentation and examples", () => {
	test("splits prose from an indented godoc example", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FieldOptions {
  // column overrides column-level structure.
  // A second prose line joins the first.
  //
  //     string id = 1 [(x.v1.column) = {name: "id"}];
  optional ColumnOptions column = 51002;
}
`).annotations;
		expect(annotation.doc).toBe(
			"column overrides column-level structure. A second prose line joins the first.",
		);
		expect(annotation.example).toBe(
			'string id = 1 [(x.v1.column) = {name: "id"}];',
		);
	});

	test("dedents a two-space example block", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FileOptions {
  // doc
  //
  //   option (x.v1.thing) = {};
  optional string thing = 1;
}
`).annotations;
		expect(annotation.example).toBe("option (x.v1.thing) = {};");
	});

	test("falls back to the extend block's own comment", () => {
		const byName = new Map(
			extract(`package x.v1;
// Block documentation for the whole extend.
//
//     option (x.v1.one) = {};
extend google.protobuf.MethodOptions {
  optional One one = 11;
  // Its own documentation.
  optional Two two = 12;
}
`).annotations.map((a) => [a.name, a]),
		);
		expect(byName.get("one")?.doc).toBe(
			"Block documentation for the whole extend.",
		);
		expect(byName.get("two")?.doc).toBe("Its own documentation.");
		// The block's example belongs to the block, so a field with its own prose
		// but no example of its own still shows it.
		expect(byName.get("two")?.example).toBe("option (x.v1.one) = {};");
	});

	test("leaves doc and example undefined when nothing is written", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FileOptions {
  optional string bare = 1;
}
`).annotations;
		expect(annotation.doc).toBeUndefined();
		expect(annotation.example).toBeUndefined();
	});

	test("takes only the comment group nearest the declaration", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FileOptions {
  // An unrelated note about something above.

  // The actual documentation.
  optional string thing = 1;
}
`).annotations;
		expect(annotation.doc).toBe("The actual documentation.");
	});

	test("reaches across a blank line directly above the declaration", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FileOptions {
  // Documentation separated by a blank line.

  optional string thing = 1;
}
`).annotations;
		expect(annotation.doc).toBe("Documentation separated by a blank line.");
	});

	test("stops at a line that is not a // comment", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FileOptions {
  // This is above the divider and is not picked up.
  /* a block comment breaks the chain */
  optional string thing = 1;
}
`).annotations;
		expect(annotation.doc).toBeUndefined();
	});

	test("documents body message fields too", () => {
		const [message] = extract(`package x.v1;
message ColumnOptions {
  // Physical column name.
  string name = 1;
  string type = 2;
}
`).messages;
		expect(message.fields[0].doc).toBe("Physical column name.");
		expect(message.fields[1].doc).toBeUndefined();
	});
});

describe("declarations", () => {
	test("scopes nested messages and enums by their enclosing type", () => {
		const file = extract(`package x.v1;
message Outer {
  message Inner {
    enum Kind {
      KIND_UNSPECIFIED = 0;
      KIND_A = 1;
    }
    Kind kind = 1;
  }
  Inner inner = 1;
}
`);
		expect(file.messages.map((m) => m.fqn).sort()).toEqual([
			"x.v1.Outer",
			"x.v1.Outer.Inner",
		]);
		expect(file.enums.map((e) => e.fqn)).toEqual(["x.v1.Outer.Inner.Kind"]);
		expect(file.enums[0].values.map((v) => v.name)).toEqual([
			"KIND_UNSPECIFIED",
			"KIND_A",
		]);
	});

	test("flattens oneof members into the enclosing message", () => {
		const [message] = extract(`package x.v1;
message M {
  string before = 1;
  oneof choice {
    string a = 2;
    int32 b = 3;
  }
  string after = 4;
}
`).messages;
		expect(message.fields.map((f) => f.name)).toEqual([
			"before",
			"a",
			"b",
			"after",
		]);
	});

	test("normalises whitespace inside a map type", () => {
		const [message] = extract(`package x.v1;
message M {
  map<string, Inner> by_name = 1;
}
`).messages;
		expect(message.fields[0].type).toBe("map<string,Inner>");
		expect(message.fields[0].repeated).toBe(false);
	});

	test("keeps the doc comment written on each enum value", () => {
		const [enumType] = extract(`package x.v1;
enum Element {
  // Not specified.
  ELEMENT_UNSPECIFIED = 0;

  // A property whose value is dynamic, readable and writable.
  ELEMENT_ACTUATOR = 4;

  ELEMENT_UNDOCUMENTED = 5;
}
`).enums;
		expect(enumType.values.map((v) => v.doc)).toEqual([
			"Not specified.",
			"A property whose value is dynamic, readable and writable.",
			undefined,
		]);
		expect(enumType.values.map((v) => v.line)).toEqual([3, 6, 8]);
	});

	test("keeps enum values including aliases and negatives", () => {
		const [enumType] = extract(`package x.v1;
enum Kind {
  option allow_alias = true;
  reserved 9;
  KIND_UNSPECIFIED = 0;
  KIND_A = 1;
  KIND_ALIAS = 1;
  KIND_NEG = -1;
}
`).enums;
		expect(enumType.values.map((v) => v.name)).toEqual([
			"KIND_UNSPECIFIED",
			"KIND_A",
			"KIND_ALIAS",
			"KIND_NEG",
		]);
		// The number is read, not counted: an alias repeats one and a negative
		// is not an index.
		expect(enumType.values.map((v) => v.number)).toEqual([0, 1, 1, -1]);
	});

	test("does not mistake rpc declarations for fields", () => {
		const file = extract(`package x.v1;
service S {
  rpc Do(Req) returns (Res) {}
  rpc Stream(Req) returns (stream Res);
}
message Req {
  string a = 1;
}
`);
		expect(file.messages.map((m) => m.fqn)).toEqual(["x.v1.Req"]);
		expect(file.messages[0].fields.map((f) => f.name)).toEqual(["a"]);
	});

	test("records 0-based declaration lines", () => {
		const file = extract(`package x.v1;

message M {
  string a = 1;
}
`);
		expect(file.messages[0].line).toBe(2);
		expect(file.messages[0].fields[0].line).toBe(3);
	});
});

describe("file identity", () => {
	test("carries the caller's identity through unchanged", () => {
		const file = extract("package x.v1;\n");
		expect(file.fileId).toBe(CTX.fileId);
		expect(file.importPath).toBe(CTX.importPath);
		expect(file.path).toBe(CTX.path);
		expect(file.packageName).toBe("x.v1");
	});

	test("tolerates a file with no package statement", () => {
		const file = extract(`syntax = "proto3";
extend google.protobuf.MethodOptions {
  optional string thing = 5;
}
message Body {
  string a = 1;
}
`);
		expect(file.packageName).toBe("");
		expect(file.annotations[0]).toMatchObject({
			fqn: "thing",
			namespace: "",
			target: "Method",
		});
		expect(file.messages[0].fqn).toBe("Body");
	});

	test("keeps the first package when a file declares two", () => {
		const file = extract(`package first;
package second;
message M {
  string a = 1;
}
`);
		expect(file.packageName).toBe("first");
		expect(file.messages[0].fqn).toBe("first.M");
	});

	test("returns empty results for empty input", () => {
		const file = extract("");
		expect(file.packageName).toBe("");
		expect(file.annotations).toEqual([]);
		expect(file.messages).toEqual([]);
		expect(file.enums).toEqual([]);
		expect(file.imports).toEqual([]);
	});
});

describe("lexing robustness", () => {
	test("counts braces outside string literals only", () => {
		const file = extract(`package x.v1;
extend google.protobuf.FileOptions {
  optional string s = 1 [(x.v1.note) = "a { brace } in a string"];
}
message After {
  string a = 1;
}
`);
		expect(file.annotations.map((a) => a.name)).toEqual(["s"]);
		expect(file.messages.map((m) => m.fqn)).toEqual(["x.v1.After"]);
	});

	test("ignores braces inside comments", () => {
		const file = extract(`package x.v1;
message M {
  // a stray { in a comment
  string a = 1;
}
message N {
  string b = 1;
}
`);
		expect(file.messages.map((m) => m.fqn).sort()).toEqual([
			"x.v1.M",
			"x.v1.N",
		]);
	});

	test("ignores an escaped quote inside a string literal", () => {
		const file = extract(`package x.v1;
message M {
  string a = 1 [(x.v1.note) = "she said \\" { "];
}
message N {
  string b = 1;
}
`);
		expect(file.messages.map((m) => m.fqn).sort()).toEqual([
			"x.v1.M",
			"x.v1.N",
		]);
	});

	test("handles CRLF line endings", () => {
		const file = extractAnnotations(
			'syntax = "proto3";\r\npackage x.v1;\r\nextend google.protobuf.EnumOptions {\r\n  optional string e = 9;\r\n}\r\n',
			CTX,
		);
		expect(file.packageName).toBe("x.v1");
		expect(file.annotations[0]).toMatchObject({
			fqn: "x.v1.e",
			target: "Enum",
			number: 9,
		});
	});

	test("yields what a buffer declared before it ran out mid-block", () => {
		const file = extract(`package x.v1;
message Half {
  string a = 1;
`);
		expect(file.messages).toHaveLength(1);
		expect(file.messages[0].fields.map((f) => f.name)).toEqual(["a"]);
	});

	test("yields the annotations of an extend block still being typed", () => {
		const file = extract(`package x.v1;
extend google.protobuf.MethodOptions {
  optional string typed_so_far = 1;
`);
		expect(file.annotations.map((a) => a.fqn)).toEqual(["x.v1.typed_so_far"]);
	});

	test("survives a stray closing brace", () => {
		const file = extract(`package x.v1;
}
message M {
  string a = 1;
}
`);
		expect(file.messages.map((m) => m.fqn)).toEqual(["x.v1.M"]);
	});

	test("keeps unicode in documentation intact", () => {
		const [annotation] = extract(`package x.v1;
extend google.protobuf.FileOptions {
  // Répertoire — see “notes” ✓
  optional string thing = 1;
}
`).annotations;
		expect(annotation.doc).toBe("Répertoire — see “notes” ✓");
	});
});

/*
 * Known gaps. Each of these silently drops vocabulary, which is the exact
 * failure mode the self-describing design exists to prevent, so they are
 * recorded here rather than left to be rediscovered.
 */

// `imports` is always empty: `stripLine` blanks string contents to `""` before
// `RE_IMPORT` runs, and that regex requires `"([^"]+)"`. Nothing a scanned file
// imports is ever recorded, so `AnnotationRegistryImpl.importsOf` can only ever
// answer `[]`, and the import-closure check it exists for is dead.
// Expected: the three import forms below are collected in source order.
test("collects import statements", () => {
	const file = extract(`syntax = "proto3";
package x.v1;
import "a/b.proto";
import public "c/d.proto";
import weak "e/f.proto";
`);
	expect(file.imports).toEqual(["a/b.proto", "c/d.proto", "e/f.proto"]);
});

// `RE_EXTEND` is `/^\s*extend\s+([A-Za-z_][\w.]*)/`, which cannot match a
// fully-qualified extendee written with protobuf's leading dot. The very next
// line strips `^\.?google\.protobuf\.`, so the leading dot was clearly meant to
// work; the regex just never lets it through.
// Expected: `.google.protobuf.ServiceOptions` resolves to the Service target.
test("accepts a fully-qualified extendee written with a leading dot", () => {
	const file = extract(`package x.v1;
extend .google.protobuf.ServiceOptions {
  optional string thing = 1;
}
`);
	expect(file.annotations[0]).toMatchObject({
		fqn: "x.v1.thing",
		target: "Service",
	});
});

// KNOWN LIMITATION, left skipped deliberately. The scanner is line-based with
// brace-depth tracking, so a block that opens and closes on one line never has a
// body to walk. Supporting it means parsing several declarations per line, which
// is a structural change for a shape `buf format` always expands and which does
// not occur anywhere in the corpus. Revisit only if a hand-written proto hits it.
//
// A whole extend block on one line opens and closes at the same brace depth, so
// the frame is popped in the same iteration that pushed it and its fields are
// never seen. `buf format` never writes this, but a buffer mid-edit does, and
// the annotation disappears from completion with no diagnostic.
// Expected: the annotation is extracted exactly as the multi-line form is.
test.skip("reads an extend block written on a single line", () => {
	const file = extract(`package x.v1;
extend google.protobuf.MessageOptions { optional Body b = 3; }
`);
	expect(file.annotations[0]).toMatchObject({
		fqn: "x.v1.b",
		target: "Message",
		number: 3,
	});
});

// Same cause, seen from the message side: a single-line message or enum is
// registered but loses every field or value it declared, so its option body
// hovers and completes as empty.
// Expected: both bodies below carry their members.
test.skip("reads a message and an enum written on a single line", () => {
	const file = extract(`package x.v1;
message Body { string s = 1; }
enum Kind { KIND_UNSPECIFIED = 0; }
`);
	expect(file.messages[0].fields.map((f) => f.name)).toEqual(["s"]);
	expect(file.enums[0].values.map((v) => v.name)).toEqual(["KIND_UNSPECIFIED"]);
});

// `leadingComment` strips `^\/\/+\s?`, which eats the tab that godoc — and the
// corpus, see `cache/v1/annotations.proto` — uses to mark example code. The
// outermost lines of the example therefore fail `splitComment`'s indent test and
// are appended to the prose instead, leaving the example a fragment without its
// `option (...) = { … };` wrapper. Against the real corpus `cache.v1.cache`
// currently documents as "cache marks a resource as cached and configures how.
// option (cache.v1.cache) = { };" with an example of just the three inner lines.
// Expected: strip `//` plus at most one space, so a tab still marks code.
test("treats a tab-indented comment block as example code", () => {
	const [annotation] = extract(`package x.v1;
extend google.protobuf.MessageOptions {
  // cache marks a resource as cached and configures how.
  //
  //\toption (x.v1.cache) = {
  //\t  enabled: true
  //\t};
  CacheOptions cache = 52001;
}
`).annotations;
	expect(annotation.doc).toBe(
		"cache marks a resource as cached and configures how.",
	);
	expect(annotation.example).toBe(
		"option (x.v1.cache) = {\n  enabled: true\n};",
	);
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"derives every descriptor from its own extend block",
		async () => {
			const registry = await referenceRegistry();
			const all = registry.all();
			expect(all.length).toBeGreaterThan(30);

			const seen = new Set<string>();
			for (const descriptor of all) {
				// The fqn is the declaring file's package plus the field name, never a
				// string written into the extension.
				const expected = descriptor.namespace
					? `${descriptor.namespace}.${descriptor.name}`
					: descriptor.name;
				expect(descriptor.fqn).toBe(expected);
				expect(registry.siteOf(descriptor)?.packageName).toBe(
					descriptor.namespace,
				);
				expect(registry.siteOf(descriptor)?.importPath).toBe(
					descriptor.importPath,
				);
				expect(ALL_TARGETS).toContain(descriptor.target);
				expect(descriptor.number).toBeGreaterThan(0);
				expect(descriptor.type.length).toBeGreaterThan(0);
				expect(descriptor.line).toBeGreaterThanOrEqual(0);
				expect(seen.has(descriptor.fqn)).toBe(false);
				seen.add(descriptor.fqn);
			}
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"finds annotations on more than one kind of element",
		async () => {
			const registry = await referenceRegistry();
			const targets = new Set<AnnotationTarget>(
				registry.all().map((a) => a.target),
			);
			// The corpus declares options on files, messages, fields and rpcs at the
			// very least; a parser that lost the extendee would collapse this set.
			expect(targets.has("File")).toBe(true);
			expect(targets.has("Message")).toBe(true);
			expect(targets.has("Field")).toBe(true);
			expect(targets.has("Method")).toBe(true);
			expect(targets.size).toBeGreaterThanOrEqual(4);
		},
	);
});
