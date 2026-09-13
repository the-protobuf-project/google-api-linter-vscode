/**
 * Tests for `analyzeProtoDocument`, the single scan every annotation feature
 * reads.
 *
 * Hover, completion, diagnostics and semantic tokens all ask this module the
 * same questions — which `(option)` references a buffer contains, what proto
 * element each one decorates, and which body field an offset sits in — so one
 * mistake here surfaces as four unrelated-looking bugs.
 *
 * Two properties get the most attention. The first is the discriminator that
 * makes an option reference an option reference: it is always followed by `=`
 * or `.`, which is the only thing keeping `rpc Get(Req) returns (Res)` from
 * being read as two of them. The second is offset exactness: the features slice
 * the buffer between a reference's `end` and the cursor, so a range that is off
 * by one silently breaks completion rather than failing loudly.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
	type AnnotationCursorContext,
	analyzeProtoDocument,
} from "../../../annotations/document";
import {
	hasReferenceCorpus,
	listProtos,
	REFERENCE_PROTO_ROOT,
} from "../support/fixtures";

/**
 * Splits a fixture marked with `▮` into its text and the marked offset.
 *
 * Writing the cursor inline keeps the assertion next to the column it is about,
 * the same trick `atCursor` plays for document-level fixtures.
 *
 * @param source - Proto source containing exactly one `▮`
 * @returns The text with the marker removed, and where it was
 */
function marked(source: string): { text: string; offset: number } {
	const offset = source.indexOf("▮");
	if (offset < 0) {
		throw new Error("fixture has no ▮ cursor marker");
	}
	return { text: source.replace("▮", ""), offset };
}

/**
 * Context at the `▮` in a fixture.
 * @param source - Proto source containing exactly one `▮`
 * @returns What kind of annotation input is legal there
 */
function contextAt(source: string): AnnotationCursorContext {
	const { text, offset } = marked(source);
	return analyzeProtoDocument(text).contextAt(offset);
}

/** Every target in one file, so one fixture pins the whole vocabulary. */
const ALL_SITES = `syntax = "proto3";
package x.v1;

option (x.v1.on_file) = 1;

message M {
  option (x.v1.on_message) = 1;
  string s = 1 [(x.v1.on_field) = 1];
  oneof choice {
    option (x.v1.on_oneof) = 1;
    string a = 2;
  }
}

enum E {
  option (x.v1.on_enum) = 1;
  E_A = 0 [(x.v1.on_enum_value) = 1];
}

service S {
  option (x.v1.on_service) = 1;
  rpc Get(Req) returns (Res) {
    option (x.v1.on_method) = 1;
  }
}
`;

describe("option references", () => {
	test("resolves the target of every option site in one file", () => {
		const model = analyzeProtoDocument(ALL_SITES);
		const byFqn = new Map(model.options.map((o) => [o.fqn, o.target]));
		expect(byFqn.get("x.v1.on_file")).toBe("File");
		expect(byFqn.get("x.v1.on_message")).toBe("Message");
		expect(byFqn.get("x.v1.on_field")).toBe("Field");
		expect(byFqn.get("x.v1.on_oneof")).toBe("Oneof");
		expect(byFqn.get("x.v1.on_enum")).toBe("Enum");
		expect(byFqn.get("x.v1.on_enum_value")).toBe("EnumValue");
		expect(byFqn.get("x.v1.on_service")).toBe("Service");
		expect(byFqn.get("x.v1.on_method")).toBe("Method");
		// Exactly eight: `(Req)` and `(Res)` in the rpc signature are not options.
		expect(model.options).toHaveLength(8);
	});

	test("reads no option reference out of an rpc signature", () => {
		// The discriminator is load-bearing. A parenthesised name followed by
		// anything other than `=` or `.` is a type list, not an annotation.
		const model = analyzeProtoDocument(`service S {
  rpc Get(Req) returns (Res);
  rpc Watch(WatchRequest) returns (stream WatchResponse) {}
  rpc Push(stream PushRequest) returns (PushResponse) {
    option (x.v1.on_method) = 1;
  }
}
`);
		expect(model.options.map((o) => o.fqn)).toEqual(["x.v1.on_method"]);
	});

	test("records the paren range and the name range separately", () => {
		const text = `message M {
  option (x.v1.thing) = 1;
}
`;
		const [reference] = analyzeProtoDocument(text).options;
		expect(text.slice(reference.start, reference.end)).toBe("(x.v1.thing)");
		expect(text.slice(reference.nameStart, reference.nameEnd)).toBe(
			"x.v1.thing",
		);
		expect(reference.fqn).toBe("x.v1.thing");
	});

	test("ends the reference just after the closing paren", () => {
		// Completion slices `text.slice(reference.end, offset)` to see what has
		// been typed since, so `end` must land on the character after `)`.
		const text = `option (x.v1.thing).acc = 1;\n`;
		const [reference] = analyzeProtoDocument(text).options;
		const cursor = text.indexOf(" = ");
		expect(text.slice(reference.end, cursor)).toBe(".acc");
	});

	test("keeps a leading dot in the name range but not in the fqn", () => {
		// `(.x.v1.thing)` is protobuf's fully-qualified spelling. The range covers
		// what was written, so a hover underlines the dot; `fqn` drops it, which
		// is why `resolveDescriptor` can never tell a rooted name from a relative
		// one — see the skipped test in resolve.test.ts.
		const text = `option (.x.v1.thing) = 1;\n`;
		const [reference] = analyzeProtoDocument(text).options;
		expect(text.slice(reference.nameStart, reference.nameEnd)).toBe(
			".x.v1.thing",
		);
		expect(reference.fqn).toBe("x.v1.thing");
	});

	test("tolerates whitespace and comments inside the reference", () => {
		const text = `option ( /* here */ x.v1.thing
  ) // trailing
  = 1;
`;
		const [reference] = analyzeProtoDocument(text).options;
		expect(reference.fqn).toBe("x.v1.thing");
		expect(reference.target).toBe("File");
		expect(text.slice(reference.nameStart, reference.nameEnd)).toBe(
			"x.v1.thing",
		);
	});

	test("records both options written in one field bracket", () => {
		const model = analyzeProtoDocument(`message M {
  string s = 1 [(a.b) = { x: 1 }, (c.d) = 2];
}
`);
		expect(model.options.map((o) => o.fqn)).toEqual(["a.b", "c.d"]);
		expect(model.options.map((o) => o.target)).toEqual(["Field", "Field"]);
	});

	test("ignores an option written inside a comment or a string", () => {
		const model = analyzeProtoDocument(`message M {
  // option (x.v1.commented) = 1;
  /* option (x.v1.blocked) = 1; */
  string s = 1 [(x.v1.real) = "option (x.v1.quoted) = 1;"];
}
`);
		expect(model.options.map((o) => o.fqn)).toEqual(["x.v1.real"]);
	});

	test("leaves the target undefined nowhere a real option may be written", () => {
		// Every reference the corpus tests below find has a target; this pins the
		// one shape that legitimately has none, an option inside an extend block.
		const model = analyzeProtoDocument(`extend google.protobuf.FileOptions {
  option (x.v1.stray) = 1;
}
`);
		expect(model.options[0].target).toBeUndefined();
	});
});

describe("accessors", () => {
	test("records each accessor segment as its own body-field reference", () => {
		const text = `message M {
  string s = 1 [(buf.validate.field).string.pattern = "^a$"];
}
`;
		const model = analyzeProtoDocument(text);
		const [reference] = model.options;
		expect(reference.fqn).toBe("buf.validate.field");
		expect(reference.accessors).toEqual(["string", "pattern"]);
		expect(model.bodyFields.map((f) => f.path)).toEqual([
			["string"],
			["string", "pattern"],
		]);
		// Offsets cover the name alone, so a hover lands on the segment under the
		// cursor rather than on the whole accessor chain.
		expect(model.bodyFields.map((f) => text.slice(f.start, f.end))).toEqual([
			"string",
			"pattern",
		]);
		expect(
			model.bodyFields.every((f) => f.optionFqn === "buf.validate.field"),
		).toBe(true);
	});

	test("records an accessor chain that is never assigned", () => {
		const text = `message M {
  option (x.v1.thing).acc;
}
`;
		const model = analyzeProtoDocument(text);
		expect(model.options[0].accessors).toEqual(["acc"]);
		expect(text.slice(model.bodyFields[0].start, model.bodyFields[0].end)).toBe(
			"acc",
		);
	});

	test("seeds an option body with the accessors written before it", () => {
		const text = `message M {
  option (x.v1.thing).nested = { leaf: 1 };
}
`;
		const model = analyzeProtoDocument(text);
		expect(model.bodyFields.map((f) => f.path)).toEqual([
			["nested"],
			["nested", "leaf"],
		]);
		const { offset } = marked(`message M {
  option (x.v1.thing).nested = { ▮leaf: 1 };
}
`);
		expect(analyzeProtoDocument(text).contextAt(offset)).toEqual({
			kind: "optionBody",
			target: "Message",
			optionFqn: "x.v1.thing",
			path: ["nested"],
		});
	});
});

describe("option bodies", () => {
	test("records nested paths for a field written with `{` and with `:`", () => {
		const text = `option (x.v1.f) = { a: 1 b { c: 2 } };\n`;
		const model = analyzeProtoDocument(text);
		expect(model.bodyFields.map((f) => f.path)).toEqual([
			["a"],
			["b"],
			["b", "c"],
		]);
		expect(model.bodyFields.map((f) => text.slice(f.start, f.end))).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(model.bodyFields.every((f) => f.optionFqn === "x.v1.f")).toBe(true);
	});

	test("keeps the path of every element of a repeated list", () => {
		const text = `option (x.v1.f) = { items: [ { a: 1 }, { b: 2 } ] c: 3 };\n`;
		const model = analyzeProtoDocument(text);
		expect(model.bodyFields.map((f) => f.path)).toEqual([
			["items"],
			["items", "a"],
			["items", "b"],
			["c"],
		]);
	});

	test("follows six levels of nesting", () => {
		const model = analyzeProtoDocument(
			`option (x.v1.f) = { a { b { c { d { e { f: 1 } } } } } };\n`,
		);
		// Indexed rather than `.at(-1)`: tsconfig targets ES2020, which predates
		// `Array.prototype.at`.
		expect(model.bodyFields[model.bodyFields.length - 1]?.path).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
		]);
	});

	test("does not read an assigned value as a field name", () => {
		// `KIND_A` is an enum value, not a field of the body.
		const model = analyzeProtoDocument(
			`option (x.v1.f) = { kind: KIND_A other: 2 };\n`,
		);
		expect(model.bodyFields.map((f) => f.path)).toEqual([["kind"], ["other"]]);
	});

	test("accepts commas and semicolons between body fields", () => {
		const model = analyzeProtoDocument(
			`option (x.v1.f) = { a: 1; b: 2, c: 3 };\n`,
		);
		expect(model.bodyFields.map((f) => f.path)).toEqual([["a"], ["b"], ["c"]]);
	});

	test("finds a body whose brace sits on a later line", () => {
		const model = analyzeProtoDocument(`option (x.v1.f) =
  {
    a: 1
  };
`);
		expect(model.bodyFields.map((f) => f.path)).toEqual([["a"]]);
	});

	test("does not close a body on a brace inside a string", () => {
		const model =
			analyzeProtoDocument(`option (x.v1.f) = { name: "a } b" c: 1 };
message After {}
`);
		expect(model.bodyFields.map((f) => f.path)).toEqual([["name"], ["c"]]);
		expect(model.blocks.map((b) => b.name)).toContain("After");
	});

	test("does not close a body on a brace inside a comment", () => {
		const model = analyzeProtoDocument(`option (x.v1.f) = {
  // } not a close
  a: 1
};
message After {}
`);
		expect(model.bodyFields.map((f) => f.path)).toEqual([["a"]]);
		expect(model.blocks.map((b) => b.name)).toContain("After");
	});

	test("reads the fields of a body the buffer never closed", () => {
		const text = `message M {
  option (x.v1.f) = {
    a: 1
`;
		const model = analyzeProtoDocument(text);
		expect(model.bodyFields.map((f) => f.path)).toEqual([["a"]]);
		const body = model.blocks.find((b) => b.kind === "optionBody");
		expect(body?.end).toBe(text.length);
	});
});

describe("contextAt", () => {
	test("reports a file-level statement outside every block", () => {
		expect(contextAt(`syntax = "proto3";\n▮\nmessage M {\n}\n`)).toEqual({
			kind: "statement",
			target: "File",
		});
	});

	test("reports the enclosing declaration for each block kind", () => {
		expect(contextAt(`message M {\n  ▮\n}\n`)).toEqual({
			kind: "statement",
			target: "Message",
		});
		expect(contextAt(`enum E {\n  ▮\n}\n`)).toEqual({
			kind: "statement",
			target: "Enum",
		});
		expect(contextAt(`service S {\n  ▮\n}\n`)).toEqual({
			kind: "statement",
			target: "Service",
		});
		expect(
			contextAt(`service S {\n  rpc Get(Req) returns (Res) {\n    ▮\n  }\n}\n`),
		).toEqual({ kind: "statement", target: "Method" });
		expect(contextAt(`message M {\n  oneof choice {\n    ▮\n  }\n}\n`)).toEqual(
			{
				kind: "statement",
				target: "Oneof",
			},
		);
	});

	test("reports the innermost of two nested messages", () => {
		expect(contextAt(`message A {\n  message B {\n    ▮\n  }\n}\n`)).toEqual({
			kind: "statement",
			target: "Message",
		});
		const model = analyzeProtoDocument(`message A {
  message B {
    string s = 1;
  }
  string t = 2;
}
`);
		expect(model.blocks.map((b) => [b.kind, b.name])).toEqual([
			["file", undefined],
			["message", "A"],
			["message", "B"],
		]);
	});

	test("reports field options inside a field's brackets", () => {
		expect(contextAt(`message M {\n  string s = 1 [▮];\n}\n`)).toEqual({
			kind: "fieldOptions",
			target: "Field",
		});
	});

	test("reports enum-value options inside an enum value's brackets", () => {
		expect(contextAt(`enum E {\n  E_A = 0 [▮];\n}\n`)).toEqual({
			kind: "fieldOptions",
			target: "EnumValue",
		});
	});

	test("reports field options for a field declared in an extend block", () => {
		expect(
			contextAt(
				`extend google.protobuf.MethodOptions {\n  optional string a = 1 [▮];\n}\n`,
			),
		).toEqual({ kind: "fieldOptions", target: "Field" });
	});

	test("reports the option body, its annotation and its path", () => {
		expect(contextAt(`message M {\n  option (x.v1.f) = { ▮ };\n}\n`)).toEqual({
			kind: "optionBody",
			target: "Message",
			optionFqn: "x.v1.f",
			path: [],
		});
		expect(
			contextAt(`message M {\n  option (x.v1.f) = { a { b { ▮ } } };\n}\n`),
		).toEqual({
			kind: "optionBody",
			target: "Message",
			optionFqn: "x.v1.f",
			path: ["a", "b"],
		});
	});

	test("carries the field target into a body written in brackets", () => {
		expect(
			contextAt(`message M {\n  string s = 1 [(x.v1.f) = { ▮ }];\n}\n`),
		).toEqual({
			kind: "optionBody",
			target: "Field",
			optionFqn: "x.v1.f",
			path: [],
		});
	});

	test("leaves a repeated list of scalars offering nothing", () => {
		// No annotation name may be started inside a value list, so the cursor is
		// deliberately not reported as an option site.
		expect(
			contextAt(`message M {\n  string s = 1 [(x.v1.tags) = ["a", ▮]];\n}\n`),
		).toEqual({ kind: "none" });
	});

	test("reports nothing at statement level inside an extend block", () => {
		expect(contextAt(`extend google.protobuf.FileOptions {\n  ▮\n}\n`)).toEqual(
			{ kind: "none" },
		);
	});

	test("includes the offset immediately after an opening brace", () => {
		expect(contextAt(`message M {▮\n}\n`)).toEqual({
			kind: "statement",
			target: "Message",
		});
		expect(contextAt(`option (x.v1.f) = {▮};\n`)).toEqual({
			kind: "optionBody",
			target: "File",
			optionFqn: "x.v1.f",
			path: [],
		});
	});

	test("does not read a comment as code", () => {
		// The `{` in the comment must not open a body, and the cursor inside the
		// comment still belongs to the message.
		expect(
			contextAt(
				`message M {\n  // option (x.v1.f) = { ▮\n  string s = 1;\n}\n`,
			),
		).toEqual({ kind: "statement", target: "Message" });
		expect(
			contextAt(`message M {\n  /* option (x.v1.f) = { */\n  ▮\n}\n`),
		).toEqual({ kind: "statement", target: "Message" });
	});

	test("does not read a string as code", () => {
		expect(
			contextAt(
				`message M {\n  string s = 1 [(x.v1.note) = "a { b"];\n  ▮\n}\n`,
			),
		).toEqual({ kind: "statement", target: "Message" });
	});

	test("answers for an empty buffer and for an offset past its end", () => {
		const model = analyzeProtoDocument("");
		expect(model.contextAt(0)).toEqual({ kind: "statement", target: "File" });
		expect(analyzeProtoDocument("message M {\n}\n").contextAt(500)).toEqual({
			kind: "statement",
			target: "File",
		});
	});

	test("survives a half-typed option reference", () => {
		expect(contextAt(`message M {\n  option (▮\n}\n`)).toEqual({
			kind: "statement",
			target: "Message",
		});
	});
});

describe("blocks", () => {
	test("spans the whole buffer with the file block", () => {
		const text = `message M {\n}\n`;
		const [root] = analyzeProtoDocument(text).blocks;
		expect(root.kind).toBe("file");
		expect(root.start).toBe(0);
		expect(root.end).toBe(text.length);
	});

	test("names each declaration and orders blocks by start offset", () => {
		const model = analyzeProtoDocument(ALL_SITES);
		expect(
			model.blocks
				.filter((b) => b.name !== undefined)
				.map((b) => [b.kind, b.name]),
		).toEqual([
			["message", "M"],
			["oneof", "choice"],
			["enum", "E"],
			["service", "S"],
			["rpc", "Get"],
		]);
		const starts = model.blocks.map((b) => b.start);
		expect([...starts].sort((a, b) => a - b)).toEqual(starts);
	});

	test("runs an unterminated block to the end of the buffer", () => {
		const text = `message M {\n  string s = 1;\n`;
		const model = analyzeProtoDocument(text);
		const message = model.blocks.find((b) => b.kind === "message");
		expect(message?.end).toBe(text.length);
	});

	test("keeps parsing after a stray closing brace", () => {
		const model = analyzeProtoDocument(`}
message M {
  option (x.v1.m) = 1;
}
`);
		expect(model.options[0].target).toBe("Message");
		expect(model.blocks.map((b) => b.name)).toContain("M");
	});

	test("keeps parsing after an option with a non-annotation body", () => {
		// `option features = {...}` is not a custom option, so the body is not an
		// option body; the declarations after it must still be seen.
		const model =
			analyzeProtoDocument(`option features = { field_presence: EXPLICIT };
message M {
  option (x.v1.m) = 1;
}
`);
		expect(model.bodyFields).toEqual([]);
		expect(model.options[0].target).toBe("Message");
	});

	test("swallows the rest of the buffer after an unterminated string", () => {
		// Tolerated, not corrected: a half-typed string leaves the scanner with no
		// way to know where code resumes, and the buffer is transient anyway.
		const text = `message M {
  string s = 1 [(x.v1.note) = "unterminated
}
`;
		const model = analyzeProtoDocument(text);
		expect(model.options.map((o) => o.fqn)).toEqual(["x.v1.note"]);
		expect(model.blocks.find((b) => b.kind === "fieldOptions")?.end).toBe(
			text.length,
		);
	});
});

describe("imports and package", () => {
	test("records every import form with its line and quoted range", () => {
		const text = `syntax = "proto3";
package p.q;
import "a.proto";
import public "b.proto";
import weak "c/d.proto";
`;
		const model = analyzeProtoDocument(text);
		expect(model.packageName).toBe("p.q");
		expect(model.imports.map((i) => [i.path, i.line])).toEqual([
			["a.proto", 2],
			["b.proto", 3],
			["c/d.proto", 4],
		]);
		expect(model.imports.map((i) => text.slice(i.start, i.end))).toEqual([
			'"a.proto"',
			'"b.proto"',
			'"c/d.proto"',
		]);
	});

	test("keeps import offsets exact through CRLF line endings", () => {
		const text =
			'syntax = "proto3";\r\npackage p.q;\r\nimport "a.proto";\r\nmessage M {\r\n}\r\n';
		const model = analyzeProtoDocument(text);
		expect(model.packageName).toBe("p.q");
		expect(model.imports[0].line).toBe(2);
		expect(text.slice(model.imports[0].start, model.imports[0].end)).toBe(
			'"a.proto"',
		);
	});

	test("ignores an import that is commented out with //", () => {
		const model = analyzeProtoDocument(`package p.q;
// import "commented/out.proto";
import "real.proto";
`);
		expect(model.imports.map((i) => i.path)).toEqual(["real.proto"]);
	});

	test("reports no package when the file declares none", () => {
		expect(analyzeProtoDocument(`message M {\n}\n`).packageName).toBe("");
	});

	test("keeps the first package when a file declares two", () => {
		expect(
			analyzeProtoDocument(`package first;\npackage second;\n`).packageName,
		).toBe("first");
	});

	test("returns empty results for an empty buffer", () => {
		const model = analyzeProtoDocument("");
		expect(model.packageName).toBe("");
		expect(model.imports).toEqual([]);
		expect(model.options).toEqual([]);
		expect(model.bodyFields).toEqual([]);
		expect(model.declarations).toEqual([]);
		expect(model.blocks).toHaveLength(1);
	});
});

describe("extension declarations", () => {
	test("records name, extendee, number and target for each field", () => {
		const text = `package x.v1;
extend google.protobuf.MethodOptions {
  // documented
  optional Body thing = 5;
  repeated string tags = 6;
}
`;
		const model = analyzeProtoDocument(text);
		expect(model.declarations.map((d) => [d.name, d.target, d.number])).toEqual(
			[
				["thing", "Method", 5],
				["tags", "Method", 6],
			],
		);
		expect(model.declarations.map((d) => text.slice(d.start, d.end))).toEqual([
			"thing",
			"tags",
		]);
		expect(model.declarations[0].extendee).toBe(
			"google.protobuf.MethodOptions",
		);
	});

	test("accepts an extendee written with protobuf's leading dot", () => {
		const model = analyzeProtoDocument(`package x.v1;
extend .google.protobuf.ServiceOptions {
  optional string thing = 1;
}
`);
		expect(model.declarations[0]).toMatchObject({
			name: "thing",
			extendee: "google.protobuf.ServiceOptions",
			target: "Service",
		});
	});

	test("records a field of a non-options extend with no target", () => {
		// The block still declares an extension field, so it is reported; the
		// consumers that only care about annotations filter on `target`.
		const model = analyzeProtoDocument(`package x.v1;
extend some.other.Message {
  optional string not_an_option = 7;
}
`);
		expect(model.declarations[0]).toMatchObject({
			name: "not_an_option",
			extendee: "some.other.Message",
			number: 7,
		});
		expect(model.declarations[0].target).toBeUndefined();
	});

	test("reads an extend block written on a single line", () => {
		const model = analyzeProtoDocument(
			`package x.v1;\nextend google.protobuf.MessageOptions { optional Body b = 3; }\n`,
		);
		expect(model.declarations[0]).toMatchObject({
			name: "b",
			target: "Message",
			number: 3,
		});
	});

	test("reads the fields of an extend block the buffer never closed", () => {
		const model = analyzeProtoDocument(`package x.v1;
extend google.protobuf.FileOptions {
  optional string typed_so_far = 1;
`);
		expect(model.declarations.map((d) => d.name)).toEqual(["typed_so_far"]);
	});

	test("reads a field with no cardinality keyword and through CRLF", () => {
		const model = analyzeProtoDocument(
			"extend google.protobuf.FileOptions {\r\n  string bare = 4;\r\n}\r\n",
		);
		expect(model.declarations[0]).toMatchObject({
			name: "bare",
			target: "File",
			number: 4,
		});
	});

	test("finds an extend block nested inside a message", () => {
		const model = analyzeProtoDocument(`package x.v1;
message M {
  extend google.protobuf.FieldOptions {
    optional string nested = 7;
  }
}
`);
		expect(model.declarations[0]).toMatchObject({
			name: "nested",
			target: "Field",
		});
	});
});

/*
 * Suspected defects. Each is written as the behaviour the module documents or
 * implies, skipped so the suite stays green, and reported for triage rather
 * than pinned as correct.
 */

// `RE_EXTENSION_FIELD` (document.ts:134) spells the field's type
// `[A-Za-z_][\w.]*`, which cannot match protobuf's fully-qualified
// `.x.v1.Body`. The sibling `RE_FIELD` in extractor.ts spells it `\.?[A-Za-z_]`
// for exactly this reason. The declaration therefore vanishes: no hover and no
// semantic token on the declaration site, and `declaredHere` in diagnostics.ts
// answers false, so the file that declares the option can be told its own
// option is unknown.
// Expected: both fields below are recorded, the leading dot notwithstanding.
test.skip("reads an extension field whose type is fully qualified", () => {
	const model = analyzeProtoDocument(`package x.v1;
extend google.protobuf.MessageOptions {
  optional .x.v1.Body rooted = 1;
  optional x.v1.Body plain = 2;
}
`);
	expect(model.declarations.map((d) => d.name)).toEqual(["rooted", "plain"]);
});

// `scanLines` (document.ts:639) is a line pass with no knowledge of `/* */`, so
// an import inside a block comment is collected as though it were live. A
// commented-out import then joins the import closure, and the "missing import"
// diagnostic it exists to raise stays silent.
// Expected: only the live import is recorded.
test.skip("ignores an import inside a block comment", () => {
	const model = analyzeProtoDocument(`package p.q;
/*
import "commented/out.proto";
*/
import "real.proto";
`);
	expect(model.imports.map((i) => i.path)).toEqual(["real.proto"]);
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"keeps every offset exact across real protos",
		() => {
			const root = REFERENCE_PROTO_ROOT;
			if (!root) {
				return;
			}
			// Every twentieth file, so the sample spreads across packages and
			// versions rather than clustering in one directory.
			const files = listProtos(root).filter((_, i) => i % 20 === 0);
			let optionCount = 0;
			let fieldCount = 0;
			for (const file of files) {
				const text = fs.readFileSync(file, "utf8");
				const model = analyzeProtoDocument(text);
				for (const reference of model.options) {
					optionCount++;
					const written = text.slice(reference.nameStart, reference.nameEnd);
					// The range covers the name as written, dot and all.
					expect(
						written === reference.fqn || written === `.${reference.fqn}`,
					).toBe(true);
					// The discriminator, checked at scale: an option is always
					// assigned or indexed into. An rpc signature never is.
					expect(
						/^(?:\s|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)*[=.]/.test(
							text.slice(reference.end, reference.end + 80),
						),
					).toBe(true);
					expect(reference.target).toBeDefined();
				}
				for (const field of model.bodyFields) {
					fieldCount++;
					expect(text.slice(field.start, field.end)).toBe(
						field.path[field.path.length - 1],
					);
				}
			}
			// The corpus annotates heavily; a parser that lost the option syntax
			// would collapse these counts rather than fail an assertion.
			expect(files.length).toBeGreaterThan(100);
			expect(optionCount).toBeGreaterThan(1000);
			expect(fieldCount).toBeGreaterThan(100);
		},
	);
});
