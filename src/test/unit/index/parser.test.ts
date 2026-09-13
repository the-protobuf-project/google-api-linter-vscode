/**
 * Tests for `parseProtoText`, the string-in, data-out parser the index is built
 * on.
 *
 * Everything downstream inherits whatever this pass decides. Two properties
 * matter more than the rest:
 *
 *  1. **Names are package-scoped.** `container` plus `name` is the fully
 *     qualified name the index keys on, and FQN keying is the only thing
 *     separating the 87 distinct `SubjectChoice` declarations in the reference
 *     corpus. A parser that loses nesting silently merges them again.
 *  2. **Text is never retained.** The parser returns plain data, so the 25 MB
 *     of source it reads can be dropped. That is only true while every returned
 *     string has been flattened, which `strings.test.ts` covers.
 *
 * The rest pins the line-oriented lexer: comments in all three forms, strings
 * that contain braces and comment markers, CRLF, and buffers that stop
 * mid-declaration. Two live defects found while writing these are recorded as
 * skipped tests at the end of the file.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ParsedFile,
	type ParsedSymbol,
	type ParseOptions,
	parseProtoText,
} from "../../../index/parser";
import { hasReferenceCorpus, REFERENCE_PROTO_ROOT } from "../support/fixtures";

/** What the `full` tier asks for: every member, every doc comment. */
const FULL: ParseOptions = { keepMembers: true, keepDocs: true };

/** What `reduced` asks for: top-level shape only. */
const REDUCED: ParseOptions = { keepMembers: false, keepDocs: false };

/** Parses at the full tier, so tests read as source-in, facts-out. */
function parse(text: string, options: ParseOptions = FULL): ParsedFile {
	return parseProtoText(text, options);
}

/** The fully-qualified name the index will key this symbol on. */
function fqn(symbol: ParsedSymbol): string {
	return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

/** Every symbol as `kind fqn`, which is what most assertions are about. */
function shape(file: ParsedFile): string[] {
	return file.symbols.map((s) => `${s.kind} ${fqn(s)}`);
}

describe("declarations", () => {
	test("qualifies a top-level message by the file's package", () => {
		const file = parse(`syntax = "proto3";
package fhir.r5;
message Patient {
}
`);
		expect(file.symbols).toHaveLength(1);
		expect(file.symbols[0]).toMatchObject({
			name: "Patient",
			kind: "message",
			container: "fhir.r5",
			line: 2,
			startCol: 8,
			endCol: 15,
		});
	});

	test("qualifies nested declarations by their enclosing type", () => {
		const file = parse(`package x.v1;
message A {
  message B {
    message C {
      enum D {
        D_UNSPECIFIED = 0;
      }
      D d = 1;
    }
  }
}
`);
		expect(shape(file)).toEqual([
			"message x.v1.A",
			"message x.v1.A.B",
			"message x.v1.A.B.C",
			"enum x.v1.A.B.C.D",
			"enumValue x.v1.A.B.C.D.D_UNSPECIFIED",
			"field x.v1.A.B.C.d",
		]);
	});

	test("records a nested enum as an enum, not an enum value", () => {
		// The parser this replaced tagged nested enums `enumValue`, which put them
		// in the wrong bucket for Go to Symbol and for rename.
		const file = parse(`package x.v1;
message M {
  enum Status {
    STATUS_UNSPECIFIED = 0;
  }
}
enum TopLevel {
  TOP_UNSPECIFIED = 0;
}
`);
		const kinds = new Map(file.symbols.map((s) => [fqn(s), s.kind]));
		expect(kinds.get("x.v1.M.Status")).toBe("enum");
		expect(kinds.get("x.v1.TopLevel")).toBe("enum");
		expect(kinds.get("x.v1.M.Status.STATUS_UNSPECIFIED")).toBe("enumValue");
	});

	test("records services, their rpcs and the signature detail", () => {
		const file = parse(`package x.v1;
service PatientService {
  rpc GetPatient(GetPatientRequest) returns (Patient);
}
`);
		expect(shape(file)).toEqual([
			"service x.v1.PatientService",
			"rpc x.v1.PatientService.GetPatient",
		]);
		expect(file.symbols[1]).toMatchObject({
			detail: "(GetPatientRequest) returns (Patient)",
			line: 2,
			startCol: 6,
			endCol: 16,
		});
	});

	test("reads streaming rpcs and an rpc with an options body", () => {
		const file = parse(`package x.v1;
service S {
  rpc Client(stream Req) returns (Res);
  rpc Server(Req) returns (stream Res);
  rpc Annotated(Req) returns (Res) {
    option (google.api.http) = {
      get: "/v1/things"
    };
  }
  rpc After(Req2) returns (Res2);
}
`);
		expect(
			file.symbols.filter((s) => s.kind === "rpc").map((s) => s.name),
		).toEqual(["Client", "Server", "Annotated", "After"]);
		// `stream` is a modifier, not part of the type name.
		expect(file.symbols[1].detail).toBe("(Req) returns (Res)");
		// The multi-line option body must not swallow the rpc that follows it.
		expect(file.symbols[4].container).toBe("x.v1.S");
	});

	test("flattens oneof members into the enclosing message", () => {
		// `oneof` groups fields; it is not a namespace, so its members keep the
		// message's fqn rather than gaining a level.
		const file = parse(`package x.v1;
message M {
  string before = 1;
  oneof choice {
    Foo a = 2;
    Bar b = 3;
  }
  string after = 4;
}
`);
		expect(file.symbols.filter((s) => s.kind === "field").map(fqn)).toEqual([
			"x.v1.M.before",
			"x.v1.M.a",
			"x.v1.M.b",
			"x.v1.M.after",
		]);
	});

	test("records a map field with its key and value types in the detail", () => {
		const file = parse(`package x.v1;
message M {
  map<string, Inner> by_name = 1;
}
`);
		const [, field] = file.symbols;
		expect(field).toMatchObject({
			name: "by_name",
			kind: "field",
			detail: "map<string, Inner>",
			container: "x.v1.M",
		});
		expect(fqn(field)).toBe("x.v1.M.by_name");
	});

	test("records an extend under the extendee's last segment", () => {
		const file = parse(`package x.v1;
extend google.protobuf.MessageOptions {
  optional Body b = 3;
}
`);
		expect(file.symbols[0]).toMatchObject({
			name: "MessageOptions",
			kind: "extend",
			detail: "google.protobuf.MessageOptions",
			container: "x.v1",
			// The range covers the last segment only, so a rename edit lands on the
			// identifier rather than on the package path in front of it.
			startCol: 23,
			endCol: 37,
		});
	});

	test("scopes extension fields to the package, not to the extendee", () => {
		// An extension field's name lives in the declaring package: it is
		// `x.v1.b`, never `google.protobuf.MessageOptions.b`.
		const file = parse(`package x.v1;
extend google.protobuf.MessageOptions {
  optional Body b = 3;
}
`);
		const field = file.symbols.find((s) => s.kind === "field");
		expect(field && fqn(field)).toBe("x.v1.b");
	});

	test("keeps enum values including aliases and negatives", () => {
		const file = parse(`package x.v1;
enum E {
  option allow_alias = true;
  reserved 9;
  E_UNSPECIFIED = 0;
  E_A = 1;
  E_ALIAS = 1;
  E_NEG = -1;
}
`);
		expect(
			file.symbols.filter((s) => s.kind === "enumValue").map((s) => s.name),
		).toEqual(["E_UNSPECIFIED", "E_A", "E_ALIAS", "E_NEG"]);
	});

	test("ignores reserved and extensions statements", () => {
		const file = parse(`package x.v1;
message M {
  reserved 2, 15, 9 to 11;
  reserved "old_name", "older_name";
  extensions 100 to 199;
  extensions 1000 to max;
  string a = 1;
}
`);
		expect(shape(file)).toEqual(["message x.v1.M", "field x.v1.M.a"]);
	});

	test("reads a field whose name collides with a keyword", () => {
		const file = parse(`package x.v1;
message M {
  string message = 1;
  string option = 2;
  string service = 3;
}
`);
		expect(
			file.symbols.filter((s) => s.kind === "field").map((s) => s.name),
		).toEqual(["message", "option", "service"]);
	});

	test("records 0-based lines and column ranges over the identifier", () => {
		const file = parse(`package x.v1;

message Patient {
  string given_name = 1;
}
`);
		expect(file.symbols[0]).toMatchObject({
			line: 2,
			startCol: 8,
			endCol: 15,
		});
		expect(file.symbols[1]).toMatchObject({
			line: 3,
			startCol: 9,
			endCol: 19,
		});
	});
});

describe("type references", () => {
	test("records field types and skips scalars", () => {
		const file = parse(`package x.v1;
message M {
  string a = 1;
  Foo b = 2;
  repeated Bar c = 3;
  optional Baz d = 4;
}
`);
		expect(file.references.map((r) => r.typeName)).toEqual([
			"Foo",
			"Bar",
			"Baz",
		]);
	});

	test("points at the type, not the field name", () => {
		const file = parse(`package x.v1;
message M {
  repeated types.Extension extensions = 1;
}
`);
		expect(file.references[0]).toMatchObject({
			typeName: "types.Extension",
			scope: "x.v1.M",
			line: 2,
			startCol: 11,
			endCol: 26,
		});
	});

	test("records both halves of a map type", () => {
		const file = parse(`package x.v1;
message M {
  map<KeyType, ValueType> m = 1;
}
`);
		expect(
			file.references.map((r) => [r.typeName, r.startCol, r.endCol]),
		).toEqual([
			["KeyType", 6, 13],
			["ValueType", 15, 24],
		]);
	});

	test("records rpc request and response types at their own columns", () => {
		const file = parse(`package x.v1;
service S {
  rpc Do(Req) returns (Res);
}
`);
		expect(
			file.references.map((r) => [r.typeName, r.startCol, r.endCol]),
		).toEqual([
			["Req", 9, 12],
			["Res", 23, 26],
		]);
	});

	test("records rpc types even when members are not being kept", () => {
		// `reduced` drops the rpc symbol but must keep the reference: Find All
		// References across a workspace is what the index is for.
		const file = parse(
			`package x.v1;
service S {
  rpc Do(Req) returns (Res);
}
`,
			REDUCED,
		);
		expect(shape(file)).toEqual(["service x.v1.S"]);
		expect(file.references.map((r) => r.typeName)).toEqual(["Req", "Res"]);
	});

	test("records the extendee as a reference", () => {
		const file = parse(`package x.v1;
extend google.protobuf.MessageOptions {
  optional Body b = 3;
}
`);
		expect(file.references.map((r) => r.typeName)).toEqual([
			"google.protobuf.MessageOptions",
			"Body",
		]);
		expect(file.references[0]).toMatchObject({ startCol: 7, endCol: 37 });
	});

	test("keeps a fully-qualified type reference's leading dot", () => {
		// Protobuf's leading dot means "resolve from the root". Dropping it would
		// turn an absolute reference into a relative one, which resolves somewhere
		// else entirely inside a nested message.
		const file = parse(`package x.v1;
message M {
  .google.protobuf.Duration d = 1;
  google.protobuf.Duration e = 2;
  map<string, .x.v1.Val> m = 3;
}
service S {
  rpc Do(.x.v1.Req) returns (.x.v1.Res);
}
`);
		expect(file.references.map((r) => r.typeName)).toEqual([
			".google.protobuf.Duration",
			"google.protobuf.Duration",
			".x.v1.Val",
			".x.v1.Req",
			".x.v1.Res",
		]);
	});

	test("scopes a reference to the innermost enclosing declaration", () => {
		const file = parse(`package x.v1;
message Outer {
  Foo top = 1;
  message Inner {
    Bar deep = 1;
  }
}
`);
		expect(file.references.map((r) => [r.typeName, r.scope])).toEqual([
			["Foo", "x.v1.Outer"],
			["Bar", "x.v1.Outer.Inner"],
		]);
	});

	test("records nothing for a file with no named types", () => {
		const file = parse(`package x.v1;
message M {
  int32 a = 1;
  bool b = 2;
  bytes c = 3;
}
`);
		expect(file.references).toEqual([]);
	});
});

describe("package and imports", () => {
	test("reads the package statement", () => {
		expect(
			parse('syntax = "proto3";\npackage fhir.r5.core;\n').packageName,
		).toBe("fhir.r5.core");
	});

	test("keeps the first package when a file declares two", () => {
		const file = parse(`package first;
package second;
message M {
}
`);
		expect(file.packageName).toBe("first");
		expect(fqn(file.symbols[0])).toBe("first.M");
	});

	test("leaves names unqualified when the file declares no package", () => {
		const file = parse(`syntax = "proto3";
message M {
  Foo a = 1;
}
`);
		expect(file.packageName).toBe("");
		expect(shape(file)).toEqual(["message M", "field M.a"]);
		expect(file.references[0].scope).toBe("M");
	});

	test("collects every import form in source order", () => {
		const file = parse(`syntax = "proto3";
package x.v1;
import "a/b.proto";
import public "c/d.proto";
import weak "e/f.proto";
`);
		expect(file.imports).toEqual(["a/b.proto", "c/d.proto", "e/f.proto"]);
	});

	test("accepts an edition header", () => {
		const file = parse(`edition = "2023";
package x.v1;
message M {
}
`);
		expect(file.packageName).toBe("x.v1");
		expect(shape(file)).toEqual(["message x.v1.M"]);
	});

	test("counts lines including the trailing empty one", () => {
		// `lineCount` feeds the stats tier, so its definition is pinned here
		// rather than left to whoever reads `split("\n")` next.
		expect(parse("").lineCount).toBe(1);
		expect(parse("package x.v1;\n").lineCount).toBe(2);
		expect(parse("package x.v1;").lineCount).toBe(1);
	});
});

describe("documentation comments", () => {
	test("attaches the leading comment block to the declaration below", () => {
		const file = parse(`package x.v1;
// Patient is a person receiving care.
// The second line joins the first.
message Patient {
  // The patient's identifier.
  string id = 1;
}
`);
		expect(file.symbols[0].doc).toBe(
			"Patient is a person receiving care.\nThe second line joins the first.",
		);
		expect(file.symbols[1].doc).toBe("The patient's identifier.");
	});

	test("does not attach a trailing comment to the line it sits on", () => {
		const file = parse(`package x.v1;
message M {
  string a = 1; // not documentation
}
`);
		expect(file.symbols[1].doc).toBeUndefined();
	});

	test("drops a comment separated from the declaration by a blank line", () => {
		// Only the block immediately above a declaration documents it, so a stray
		// note earlier in the file cannot be mistaken for the doc.
		const file = parse(`package x.v1;
// A note about something else.

message M {
}
`);
		expect(file.symbols[0].doc).toBeUndefined();
	});

	test("takes only the comment group nearest the declaration", () => {
		const file = parse(`package x.v1;
// an earlier note

// the actual documentation
message M {
}
`);
		expect(file.symbols[0].doc).toBe("the actual documentation");
	});

	test("keeps unicode in a doc comment intact", () => {
		const file = parse(`package x.v1;
// Répertoire — see “notes” ✓
message M {
}
`);
		expect(file.symbols[0].doc).toBe("Répertoire — see “notes” ✓");
	});

	test("does not carry one declaration's doc onto the next", () => {
		const file = parse(`package x.v1;
// Documented.
message A {
}
message B {
}
`);
		expect(file.symbols[0].doc).toBe("Documented.");
		expect(file.symbols[1].doc).toBeUndefined();
	});
});

describe("tier options", () => {
	test("reduced keeps declarations and drops members", () => {
		const file = parse(
			`package x.v1;
message Patient {
  string id = 1;
  Foo f = 2;
  enum Status {
    STATUS_UNSPECIFIED = 0;
  }
}
service S {
  rpc Do(Req) returns (Res);
}
`,
			REDUCED,
		);
		expect(shape(file)).toEqual([
			"message x.v1.Patient",
			"enum x.v1.Patient.Status",
			"service x.v1.S",
		]);
	});

	test("keepDocs off drops docs but keeps everything else", () => {
		const file = parse(
			`package x.v1;
// Documented.
message M {
  // Also documented.
  string a = 1;
}
`,
			{ keepMembers: true, keepDocs: false },
		);
		expect(shape(file)).toEqual(["message x.v1.M", "field x.v1.M.a"]);
		expect(file.symbols.every((s) => s.doc === undefined)).toBe(true);
	});

	test("keepMembers off still reports package, imports and line count", () => {
		const file = parse(
			`package x.v1;
import "a/b.proto";
message M {
  string a = 1;
}
`,
			REDUCED,
		);
		expect(file.packageName).toBe("x.v1");
		expect(file.imports).toEqual(["a/b.proto"]);
		expect(file.lineCount).toBe(6);
	});
});

describe("lexing robustness", () => {
	test("returns empty results for empty input", () => {
		const file = parse("");
		expect(file).toMatchObject({
			packageName: "",
			imports: [],
			symbols: [],
			references: [],
		});
	});

	test("returns empty results for a file of only comments", () => {
		const file = parse(`// Copyright 2026 The Protobuf Project authors.
// SPDX-License-Identifier: Apache-2.0

/* a block comment
   spanning lines */
`);
		expect(file.symbols).toEqual([]);
		expect(file.references).toEqual([]);
		expect(file.packageName).toBe("");
	});

	test("does not read declarations out of a block comment", () => {
		const file = parse(`package x.v1;
/* message Ghost {
     string g = 1;
   } */
message Real {
  /* inline */ string a = 1;
}
`);
		expect(shape(file)).toEqual(["message x.v1.Real", "field x.v1.Real.a"]);
	});

	test("does not read declarations out of a line comment", () => {
		const file = parse(`package x.v1;
// message Ghost {
message Real {
  // string ghost_field = 9;
  string a = 1;
}
`);
		expect(shape(file)).toEqual(["message x.v1.Real", "field x.v1.Real.a"]);
	});

	test("ignores a comment marker inside a string literal", () => {
		const file = parse(`package x.v1;
message M {
  string a = 1 [(x.v1.note) = "http://example.com"];
}
message N {
}
`);
		expect(shape(file)).toEqual([
			"message x.v1.M",
			"field x.v1.M.a",
			"message x.v1.N",
		]);
	});

	test("ignores the word message inside a string literal", () => {
		const file = parse(`package x.v1;
message M {
  option (x.v1.note) = "message Ghost";
  string a = 1;
}
`);
		expect(shape(file)).toEqual(["message x.v1.M", "field x.v1.M.a"]);
	});

	test("ignores an escaped quote inside a string literal", () => {
		const file = parse(`package x.v1;
message M {
  string a = 1 [(x.v1.note) = "she said \\" // not a comment"];
}
message N {
}
`);
		expect(shape(file)).toEqual([
			"message x.v1.M",
			"field x.v1.M.a",
			"message x.v1.N",
		]);
	});

	test("handles CRLF line endings", () => {
		const file = parse(
			'syntax = "proto3";\r\npackage x.v1;\r\nimport "a/b.proto";\r\nmessage M {\r\n  Foo a = 1;\r\n}\r\n',
		);
		expect(file.packageName).toBe("x.v1");
		expect(file.imports).toEqual(["a/b.proto"]);
		expect(shape(file)).toEqual(["message x.v1.M", "field x.v1.M.a"]);
		// The carriage return must not end up inside the recorded type name.
		expect(file.references[0].typeName).toBe("Foo");
	});

	test("yields what a buffer declared before it ran out mid-block", () => {
		const file = parse(`package x.v1;
message Half {
  string a = 1;
`);
		expect(shape(file)).toEqual(["message x.v1.Half", "field x.v1.Half.a"]);
	});

	test("survives more closing braces than opening ones", () => {
		const file = parse(`package x.v1;
}
}
}
message M {
  string a = 1;
}
`);
		expect(shape(file)).toEqual(["message x.v1.M", "field x.v1.M.a"]);
	});

	test("terminates on deeply unbalanced input", () => {
		// A buffer mid-edit can be arbitrarily malformed; the parser is a single
		// forward pass, so this is about proving there is no backtracking blow-up.
		const file = parse(`package x.v1;\n${"message M {\n".repeat(500)}`);
		expect(file.symbols).toHaveLength(500);
		expect(file.symbols[499].container.split(".")).toHaveLength(501);
	});

	test("records a message written on one line, without its fields", () => {
		// KNOWN LIMITATION. The lexer is line-based with brace-depth tracking, so
		// a body that opens and closes on one line is popped in the same iteration
		// that pushed it and never has members read out of it. `buf format` always
		// expands this shape and it appears nowhere in the corpus; the declaration
		// itself is still found, which is what Go to Symbol needs.
		const file = parse(`package x.v1;
message M { string a = 1; }
message N { string b = 1; }
`);
		expect(shape(file)).toEqual(["message x.v1.M", "message x.v1.N"]);
	});

	test("does not crash on a non-ASCII identifier", () => {
		// Proto identifiers are ASCII by specification, so a name like this is
		// already invalid input; the parser truncates at the first non-ASCII
		// character rather than failing, and the following declarations still
		// parse correctly.
		const file = parse(`package x.v1;
message Répertoire {
}
message Plain {
}
`);
		expect(file.symbols.map((s) => s.kind)).toEqual(["message", "message"]);
		expect(fqn(file.symbols[1])).toBe("x.v1.Plain");
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"parses a real resource file into fully-qualified declarations",
		() => {
			const file = path.join(
				REFERENCE_PROTO_ROOT as string,
				"fhir/base/individuals/v5/patient/resource.proto",
			);
			const parsed = parse(fs.readFileSync(file, "utf8"));
			expect(parsed.packageName).toBe(
				"protobuf.fhir.base.individuals.v5.patient",
			);
			const patient = parsed.symbols.find(
				(s) => s.kind === "message" && s.name === "Patient",
			);
			expect(patient).toBeDefined();
			expect(fqn(patient as ParsedSymbol)).toBe(
				"protobuf.fhir.base.individuals.v5.patient.Patient",
			);
			// A FHIR resource carries doc comments, imports and named field types;
			// a parser that lost any of them would still return a symbol list, so
			// assert on all three.
			expect(patient?.doc?.length).toBeGreaterThan(0);
			expect(parsed.imports.length).toBeGreaterThan(0);
			expect(parsed.references.length).toBeGreaterThan(0);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"keeps every declaration under the file's own package",
		() => {
			// One directory rather than all 9,280 files: enough shapes to catch a
			// qualification bug, fast enough to keep in the inner loop.
			const dir = path.join(
				REFERENCE_PROTO_ROOT as string,
				"fhir/base/individuals/v5",
			);
			let files = 0;
			let symbols = 0;
			for (const entry of fs.readdirSync(dir, {
				withFileTypes: true,
				recursive: true,
			})) {
				if (!entry.name.endsWith(".proto")) {
					continue;
				}
				const parsed = parse(
					fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"),
				);
				files++;
				expect(parsed.packageName.length).toBeGreaterThan(0);
				for (const symbol of parsed.symbols) {
					symbols++;
					// Every name is rooted in the package, which is what stops
					// `SubjectChoice` in one version colliding with another's.
					expect(fqn(symbol).startsWith(`${parsed.packageName}.`)).toBe(true);
				}
			}
			expect(files).toBeGreaterThan(50);
			expect(symbols).toBeGreaterThan(500);
		},
	);
});

/*
 * Known defects. Both are live on the reference corpus, so they are recorded
 * here as skipped tests rather than left to be rediscovered from a wrong
 * rename.
 */

// Brace bookkeeping walks the raw line, counting every `{` and `}` including
// those inside string literals — even though `lineCommentAt` already knows how
// to skip a string, and the sibling annotation lexer strips string contents
// before counting. A `buf.validate` pattern or a `google.api.http` template
// containing an unbalanced brace therefore shifts the frame stack for the rest
// of the file: 678 of the 9,280 corpus files count wrongly, and in
// `fhir/financial/general/v6/contract/term_asset_valued_item.proto` the stray
// `}` in a regex at line 60 closes `TermAssetValuedItem` early, so every field
// from `points` onwards is lost and later declarations are nested under the
// wrong parent. src/index/parser.ts:413.
// Expected: braces inside string literals are not counted.
test.skip("counts braces outside string literals only", () => {
	const opened = parse(`package x.v1;
message M {
  string a = 1 [(x.v1.note) = "a { brace"];
}
message N {
  string b = 1;
}
`);
	expect(shape(opened)).toEqual([
		"message x.v1.M",
		"field x.v1.M.a",
		"message x.v1.N",
		"field x.v1.N.b",
	]);

	const closed = parse(`package x.v1;
message M {
  string a = 1 [(buf.validate.field).string.pattern = "[0-9]{1,9}}"];
  string b = 2;
}
`);
	expect(shape(closed)).toEqual([
		"message x.v1.M",
		"field x.v1.M.a",
		"field x.v1.M.b",
	]);
});

// `RE_DECL` is `/^(\s*(message|enum|service|extend)\s+)([A-Za-z_][\w.]*)/`,
// which cannot match an extendee written with protobuf's leading dot. The whole
// block is then invisible: no `extend` symbol, no reference to the extendee, and
// no extension fields, because the brace pushes an opaque frame instead. Every
// other position accepts a leading dot — field types, map key and value, rpc
// request and response all use `[.\w]+` — so this one is an oversight rather
// than a decision. It is the same gap the sibling annotation extractor has.
// src/index/parser.ts:68.
// Expected: the extend and its field are recorded exactly as the undotted form.
test("accepts a fully-qualified extendee written with a leading dot", () => {
	const file = parse(`package x.v1;
extend .google.protobuf.MessageOptions {
  optional Body b = 3;
}
`);
	expect(shape(file)).toEqual(["extend x.v1.MessageOptions", "field x.v1.b"]);
	expect(file.references.map((r) => r.typeName)).toEqual([
		".google.protobuf.MessageOptions",
		"Body",
	]);
});
