/**
 * Tests for the line-oriented proto parser.
 *
 * Six providers — document symbols, folding, hover, code actions, rename and
 * references — are built on these five functions, so a silent mis-parse here
 * surfaces as an outline missing an entry or, worse, as a rename that rewrites
 * the wrong span. The parser is deliberately regex-and-brace-counting rather
 * than a real grammar, so the tests pin where that approximation holds and
 * mark, as skips, the places where it demonstrably does not.
 *
 * The leading dot gets its own attention. A fully-qualified reference written
 * `.google.protobuf.Duration` is legal proto and appears throughout the FHIR
 * tree; four other parsers in this extension have already had to be fixed for
 * dropping it.
 */

import { describe, expect, test } from "bun:test";
import {
	collectTypeReferences,
	flattenSymbols,
	getSymbolAtPosition,
	type ProtoSymbol,
	parseMessageBody,
	parseProtoDocument,
} from "../../../utils/protoParser";
import { makeDocument } from "../support/fixtures";
import { Position } from "../support/vscode";

/** Names and kinds only: the shape most assertions here care about. */
function outline(symbols: ProtoSymbol[]): string[] {
	return symbols.map((s) => `${s.kind} ${s.name}`);
}

/* ------------------------------------------------------------------ *
 * parseProtoDocument
 * ------------------------------------------------------------------ */

describe("parseProtoDocument", () => {
	test("returns nothing for an empty document", () => {
		expect(parseProtoDocument(makeDocument(""))).toEqual([]);
	});

	test("returns nothing for a document with no declarations", () => {
		const document = makeDocument(
			'syntax = "proto3";\n\npackage example.v1;\n\nimport "google/protobuf/any.proto";\n',
		);
		expect(parseProtoDocument(document)).toEqual([]);
	});

	test("spans a message from its header to its closing brace", () => {
		const document = makeDocument("message Book {\n  string name = 1;\n}\n");
		const [book] = parseProtoDocument(document);
		expect(book.kind).toBe("message");
		expect(book.name).toBe("Book");
		expect(book.range.start.line).toBe(0);
		expect(book.range.start.character).toBe(0);
		expect(book.range.end.line).toBe(2);
		expect(book.selectionRange.start.character).toBe(8);
		expect(book.selectionRange.end.character).toBe(12);
	});

	test("reads fields of a message as children", () => {
		const document = makeDocument(
			"message Book {\n  string name = 1;\n  int32 pages = 2;\n}\n",
		);
		const [book] = parseProtoDocument(document);
		expect(outline(book.children ?? [])).toEqual(["field name", "field pages"]);
		expect(book.children?.[0].detail).toBe("string");
		expect(book.children?.[1].detail).toBe("int32");
	});

	test("keeps the leading dot on a fully-qualified field type", () => {
		const document = makeDocument(
			"message Book {\n  .google.protobuf.Duration loan = 1;\n}\n",
		);
		const [book] = parseProtoDocument(document);
		// The detail is the source text, dot included; consumers that match it
		// against a symbol name are the ones that have to strip it.
		expect(book.children?.[0].detail).toBe(".google.protobuf.Duration");
		expect(book.children?.[0].name).toBe("loan");
	});

	test("reads rpcs of a service as children with a signature detail", () => {
		const document = makeDocument(
			"service Library {\n" +
				"  rpc GetBook(GetBookRequest) returns (Book);\n" +
				"  rpc ListBooks(ListBooksRequest) returns (stream Book);\n" +
				"}\n",
		);
		const [service] = parseProtoDocument(document);
		expect(service.kind).toBe("service");
		expect(outline(service.children ?? [])).toEqual([
			"rpc GetBook",
			"rpc ListBooks",
		]);
		expect(service.children?.[0].detail).toBe(
			"(GetBookRequest) returns (Book)",
		);
		// `stream` belongs to the signature, not to the type name.
		expect(service.children?.[1].detail).toBe(
			"(ListBooksRequest) returns (Book)",
		);
	});

	test("reads a multi-line rpc declaration as a plain service body", () => {
		const document = makeDocument(
			"service Library {\n" +
				"  rpc GetBook(GetBookRequest)\n" +
				"      returns (Book) {\n" +
				'    option (google.api.http) = { get: "/v1/books" };\n' +
				"  }\n" +
				"}\n",
		);
		const [service] = parseProtoDocument(document);
		// The rpc regex is single-line, so a wrapped signature yields no child.
		expect(service.name).toBe("Library");
		expect(service.children).toBeUndefined();
	});

	test("parses a top-level enum without descending into its values", () => {
		const document = makeDocument(
			"enum State {\n  STATE_UNSPECIFIED = 0;\n  ACTIVE = 1;\n}\n",
		);
		const [state] = parseProtoDocument(document);
		expect(state.kind).toBe("enum");
		expect(state.name).toBe("State");
		expect(state.range.end.line).toBe(3);
		expect(state.children).toBeUndefined();
	});

	test("parses an extend block as a message", () => {
		const document = makeDocument(
			"extend google.protobuf.MessageOptions {\n" +
				"  string resource = 50000;\n" +
				"}\n",
		);
		const [extended] = parseProtoDocument(document);
		expect(extended.kind).toBe("message");
		expect(extended.name).toBe("google.protobuf.MessageOptions");
		expect(outline(extended.children ?? [])).toEqual(["field resource"]);
	});

	test("parses several top-level declarations in order", () => {
		const document = makeDocument(
			'syntax = "proto3";\n\n' +
				"message Book {\n}\n\n" +
				"enum State {\n}\n\n" +
				"service Library {\n}\n",
		);
		expect(
			outline(parseProtoDocument(makeDocument(document.getText()))),
		).toEqual(["message Book", "enum State", "service Library"]);
	});

	test("descends into a nested message", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  message Author {\n" +
				"    string name = 1;\n" +
				"  }\n" +
				"  string title = 2;\n" +
				"}\n",
		);
		const [book] = parseProtoDocument(document);
		expect(outline(book.children ?? [])).toEqual([
			"message Author",
			"field title",
		]);
		// Nesting is one level deep by design: the nested message's own fields
		// are not walked, so the outline stays shallow.
		expect(book.children?.[0].children).toBeUndefined();
		expect(book.children?.[0].range.end.line).toBe(3);
	});

	test("skips a oneof body rather than listing its fields", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  oneof source {\n" +
				"    string isbn = 1;\n" +
				"    string doi = 2;\n" +
				"  }\n" +
				"  string title = 3;\n" +
				"}\n",
		);
		const [book] = parseProtoDocument(document);
		expect(outline(book.children ?? [])).toEqual(["field title"]);
	});

	test("ignores a commented-out declaration", () => {
		const document = makeDocument(
			"// message Ghost {\n" +
				"//   string name = 1;\n" +
				"// }\n" +
				"message Real {\n}\n",
		);
		expect(outline(parseProtoDocument(document))).toEqual(["message Real"]);
	});

	test("ignores a single-line block comment", () => {
		const document = makeDocument(
			"/* message Ghost {} */\nmessage Real {\n}\n",
		);
		expect(outline(parseProtoDocument(document))).toEqual(["message Real"]);
	});

	test("ignores a commented-out field inside a message", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  // string removed = 1;\n" +
				"  /* string alsoRemoved = 2; */\n" +
				"  string kept = 3;\n" +
				"}\n",
		);
		const [book] = parseProtoDocument(document);
		expect(outline(book.children ?? [])).toEqual(["field kept"]);
	});

	test("keeps a trailing comment out of the parsed declaration", () => {
		const document = makeDocument(
			"message Book { // the book\n  string name = 1; // its name\n}\n",
		);
		const [book] = parseProtoDocument(document);
		expect(book.name).toBe("Book");
		expect(outline(book.children ?? [])).toEqual(["field name"]);
	});

	test.skip("ignores declarations inside a multi-line block comment", () => {
		// Expected: only `Real`. Actual: `Ghost` is reported too, because
		// RE_COMMENT (protoParser.ts:24) only tests whether a line *starts* a
		// comment; there is no block-comment state, so every line between `/*`
		// and `*/` is parsed as live source. Unskip once the parser tracks
		// block-comment depth.
		const document = makeDocument(
			"/*\n" +
				"message Ghost {\n" +
				"  string name = 1;\n" +
				"}\n" +
				"*/\n" +
				"message Real {\n}\n",
		);
		expect(outline(parseProtoDocument(document))).toEqual(["message Real"]);
	});

	test.skip("ignores a brace that only appears inside a string literal", () => {
		// Expected: `Holder` spans lines 0-3 and keeps its field. Actual:
		// findMatchingBrace (protoParser.ts:34) counts every `{` in the line
		// text, so the `"{"` in the option value opens a depth that is never
		// closed; the search falls off the end of the file, returns the start
		// line, and the message collapses to one line with no children.
		const document = makeDocument(
			"message Holder {\n" +
				'  option (custom) = "{";\n' +
				"  string name = 1;\n" +
				"}\n" +
				"message After {\n}\n",
		);
		const [holder] = parseProtoDocument(document);
		expect(holder.range.end.line).toBe(3);
		expect(outline(holder.children ?? [])).toEqual(["field name"]);
	});

	test("does not confuse a keyword inside a string with a declaration", () => {
		const document = makeDocument(
			"message Book {\n" +
				'  string note = 1 [(doc) = "message Ghost is not real"];\n' +
				"}\n",
		);
		expect(outline(parseProtoDocument(document))).toEqual(["message Book"]);
	});

	test("parses CRLF source to the same outline as LF source", () => {
		const lf =
			"message Book {\n  string name = 1;\n}\nservice Library {\n  rpc GetBook(GetBookRequest) returns (Book);\n}\n";
		const crlf = lf.replace(/\n/g, "\r\n");
		const fromLf = parseProtoDocument(makeDocument(lf));
		const fromCrlf = parseProtoDocument(makeDocument(crlf));
		expect(outline(fromCrlf)).toEqual(outline(fromLf));
		expect(outline(fromCrlf[0].children ?? [])).toEqual(["field name"]);
		expect(outline(fromCrlf[1].children ?? [])).toEqual(["rpc GetBook"]);
		expect(fromCrlf[1].children?.[0].detail).toBe(
			"(GetBookRequest) returns (Book)",
		);
	});

	test("terminates on an unclosed message", () => {
		const document = makeDocument("message Book {\n  string name = 1;\n");
		const symbols = parseProtoDocument(document);
		// No closing brace means no body: the symbol collapses to its header.
		expect(outline(symbols)).toEqual(["message Book"]);
		expect(symbols[0].range.end.line).toBe(0);
		expect(symbols[0].children).toBeUndefined();
	});

	test("terminates on a stray closing brace", () => {
		const document = makeDocument("}\nmessage Book {\n}\n");
		expect(outline(parseProtoDocument(document))).toEqual(["message Book"]);
	});

	test("terminates on deeply unbalanced input", () => {
		const document = makeDocument(`${"message M {\n".repeat(200)}\n`);
		// 200 unclosed headers: each one collapses to its own line, and the walk
		// still finishes rather than rescanning the tail for every header.
		expect(parseProtoDocument(document)).toHaveLength(200);
	});

	test("handles a declaration with no body brace at all", () => {
		const document = makeDocument("message Book\nmessage Author {\n}\n");
		expect(outline(parseProtoDocument(document))).toEqual([
			"message Book",
			"message Author",
		]);
	});

	test("accepts a brace opened on the following line", () => {
		const document = makeDocument("message Book\n{\n  string name = 1;\n}\n");
		const [book] = parseProtoDocument(document);
		// The header line carries no brace, so the symbol ends where it starts
		// and the body is not walked.
		expect(book.name).toBe("Book");
		expect(book.range.end.line).toBe(0);
		expect(book.children).toBeUndefined();
	});

	test("parses unicode inside comments and option values", () => {
		const document = makeDocument(
			"// Grüße — a message about naïve café identifiers\n" +
				"message Café {\n" +
				'  string naïve = 1 [(doc) = "日本語"];\n' +
				"}\n",
		);
		const symbols = parseProtoDocument(document);
		// Identifiers outside ASCII are not proto3-legal and the regexes match
		// only the ASCII head, which is what the outline shows.
		expect(symbols).toHaveLength(1);
		expect(symbols[0].name).toBe("Caf");
	});
});

/* ------------------------------------------------------------------ *
 * parseMessageBody
 * ------------------------------------------------------------------ */

describe("parseMessageBody", () => {
	test("lists fields with their types, numbers and name ranges", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  string name = 1;\n" +
				"  repeated Author authors = 2;\n" +
				"  .google.protobuf.Timestamp created = 3;\n" +
				"}\n",
		);
		const { fields } = parseMessageBody(document, 0);
		expect(fields.map((f) => [f.type, f.name, f.number])).toEqual([
			["string", "name", "1"],
			["Author", "authors", "2"],
			[".google.protobuf.Timestamp", "created", "3"],
		]);
		expect(fields[0].range.start.line).toBe(1);
		expect(fields[0].range.start.character).toBe(9);
		expect(fields[0].range.end.character).toBe(13);
	});

	test("finds the body when the brace is on the next line", () => {
		const document = makeDocument("message Book\n{\n  string name = 1;\n}\n");
		expect(parseMessageBody(document, 0).fields.map((f) => f.name)).toEqual([
			"name",
		]);
	});

	test("lists a nested enum and skips its values", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  enum State {\n" +
				"    STATE_UNSPECIFIED = 0;\n" +
				"    ACTIVE = 1;\n" +
				"  }\n" +
				"  State state = 1;\n" +
				"}\n",
		);
		const { fields, enums } = parseMessageBody(document, 0);
		expect(enums.map((e) => e.name)).toEqual(["State"]);
		expect(enums[0].range.start.line).toBe(1);
		// Enum values look like fields to the field regex; jumping past the enum
		// body is what keeps them out.
		expect(fields.map((f) => f.name)).toEqual(["state"]);
	});

	test("skips commented-out fields but keeps trailing-commented ones", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  // string removed = 1;\n" +
				"    // string alsoRemoved = 2;\n" +
				"  string kept = 3; // still a field\n" +
				"}\n",
		);
		expect(parseMessageBody(document, 0).fields.map((f) => f.name)).toEqual([
			"kept",
		]);
	});

	test("returns nothing for an empty body", () => {
		const document = makeDocument("message Book {\n}\n");
		expect(parseMessageBody(document, 0)).toEqual({ fields: [], enums: [] });
	});

	test("returns nothing for a line past the end of the document", () => {
		const document = makeDocument("message Book {\n}\n");
		expect(parseMessageBody(document, 99)).toEqual({ fields: [], enums: [] });
	});

	test("returns nothing when the message is never closed", () => {
		const document = makeDocument("message Book {\n  string name = 1;\n");
		expect(parseMessageBody(document, 0)).toEqual({ fields: [], enums: [] });
	});

	test("reads fields from CRLF source", () => {
		const document = makeDocument(
			"message Book {\r\n  string name = 1;\r\n  int32 pages = 2;\r\n}\r\n",
		);
		expect(parseMessageBody(document, 0).fields.map((f) => f.name)).toEqual([
			"name",
			"pages",
		]);
	});

	test("reads the fields of a nested message when pointed at it", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  message Author {\n" +
				"    string name = 1;\n" +
				"  }\n" +
				"}\n",
		);
		expect(parseMessageBody(document, 1).fields.map((f) => f.name)).toEqual([
			"name",
		]);
	});

	test.skip("lists a map field", () => {
		// Expected: one field, `labels`, of type `map<string, string>`. Actual:
		// nothing. RE_FIELD (protoParser.ts:31) has an optional `map<…>` group
		// ahead of the type capture, so after that group is consumed there is no
		// `type name = number` left to match and the whole line is dropped. Map
		// fields are therefore invisible to the outline, to hover and to rename.
		const document = makeDocument(
			"message Book {\n  map<string, string> labels = 1;\n}\n",
		);
		expect(parseMessageBody(document, 0).fields.map((f) => f.name)).toEqual([
			"labels",
		]);
	});
});

/* ------------------------------------------------------------------ *
 * flattenSymbols and getSymbolAtPosition
 * ------------------------------------------------------------------ */

describe("flattenSymbols", () => {
	test("returns an empty list for no symbols", () => {
		expect(flattenSymbols([])).toEqual([]);
	});

	test("walks children depth first, parent before child", () => {
		const document = makeDocument(
			"message Book {\n" +
				"  message Author {\n  }\n" +
				"  string title = 1;\n" +
				"}\n" +
				"service Library {\n" +
				"  rpc GetBook(GetBookRequest) returns (Book);\n" +
				"}\n",
		);
		expect(outline(flattenSymbols(parseProtoDocument(document)))).toEqual([
			"message Book",
			"message Author",
			"field title",
			"service Library",
			"rpc GetBook",
		]);
	});
});

describe("getSymbolAtPosition", () => {
	const source =
		"message Book {\n" +
		"  string name = 1;\n" +
		"}\n" +
		"service Library {\n" +
		"  rpc GetBook(GetBookRequest) returns (Book);\n" +
		"}\n";

	test("finds a top-level symbol by its name range", () => {
		const symbols = parseProtoDocument(makeDocument(source));
		expect(getSymbolAtPosition(symbols, new Position(0, 9))?.name).toBe("Book");
	});

	test("finds a child before falling through to nothing", () => {
		const symbols = parseProtoDocument(makeDocument(source));
		expect(getSymbolAtPosition(symbols, new Position(4, 7))?.name).toBe(
			"GetBook",
		);
	});

	test("includes both ends of the name range", () => {
		const symbols = parseProtoDocument(makeDocument(source));
		expect(getSymbolAtPosition(symbols, new Position(0, 8))?.name).toBe("Book");
		expect(getSymbolAtPosition(symbols, new Position(0, 12))?.name).toBe(
			"Book",
		);
		expect(getSymbolAtPosition(symbols, new Position(0, 7))).toBeUndefined();
		expect(getSymbolAtPosition(symbols, new Position(0, 13))).toBeUndefined();
	});

	test("matches the name only, not the body", () => {
		const symbols = parseProtoDocument(makeDocument(source));
		// Column 10 is inside the field's name; column 4 is inside its type, and
		// only the name range counts even though the whole line is the field's
		// own range.
		expect(getSymbolAtPosition(symbols, new Position(1, 10))?.name).toBe(
			"name",
		);
		expect(getSymbolAtPosition(symbols, new Position(1, 4))).toBeUndefined();
		expect(getSymbolAtPosition(symbols, new Position(1, 0))).toBeUndefined();
	});

	test("returns undefined for a position in an empty document", () => {
		expect(getSymbolAtPosition([], new Position(0, 0))).toBeUndefined();
	});
});

/* ------------------------------------------------------------------ *
 * collectTypeReferences
 * ------------------------------------------------------------------ */

describe("collectTypeReferences", () => {
	test("returns nothing for an empty document", () => {
		expect(collectTypeReferences(makeDocument(""))).toEqual([]);
	});

	test("collects an rpc request and response type", () => {
		const document = makeDocument(
			"service Library {\n" +
				"  rpc GetBook(GetBookRequest) returns (Book);\n" +
				"}\n",
		);
		const refs = collectTypeReferences(document);
		expect(refs.map((r) => r.typeName)).toEqual(["GetBookRequest", "Book"]);
		expect(refs[0].range.start.line).toBe(1);
		expect(refs[0].range.start.character).toBe(14);
		expect(refs[0].range.end.character).toBe(28);
	});

	test("collects through the stream keyword", () => {
		const document = makeDocument(
			"service Library {\n" +
				"  rpc Watch(stream WatchRequest) returns (stream WatchResponse);\n" +
				"}\n",
		);
		expect(collectTypeReferences(document).map((r) => r.typeName)).toEqual([
			"WatchRequest",
			"WatchResponse",
		]);
	});

	test("ignores a commented-out rpc", () => {
		const document = makeDocument(
			"service Library {\n" +
				"  // rpc GetBook(GetBookRequest) returns (Book);\n" +
				"}\n",
		);
		expect(collectTypeReferences(document)).toEqual([]);
	});

	test("collects one rpc per line, not one per file", () => {
		const document = makeDocument(
			"service Library {\n" +
				"  rpc GetBook(GetBookRequest) returns (Book);\n" +
				"  rpc DeleteBook(DeleteBookRequest) returns (Empty);\n" +
				"}\n",
		);
		expect(collectTypeReferences(document).map((r) => r.typeName)).toEqual([
			"GetBookRequest",
			"Book",
			"DeleteBookRequest",
			"Empty",
		]);
	});

	test.skip("collects field types", () => {
		// Expected: `Author` and `google.protobuf.Timestamp`, with `string`
		// filtered out as a scalar. Actual: nothing at all. The field-type regex
		// (protoParser.ts:370) opens with `(\\.?[A-Za-z_]…)`, which in a regex
		// literal is a *literal backslash* followed by any optional character,
		// not the intended optional leading dot `(\.?…)`. No proto line contains
		// a backslash there, so the pattern never matches and every field type
		// reference is silently dropped — including from rename and references.
		const document = makeDocument(
			"message Book {\n" +
				"  string name = 1;\n" +
				"  Author author = 2;\n" +
				"  google.protobuf.Timestamp created = 3;\n" +
				"}\n",
		);
		expect(collectTypeReferences(document).map((r) => r.typeName)).toEqual([
			"Author",
			"google.protobuf.Timestamp",
		]);
	});

	test.skip("collects a field type written with a leading dot", () => {
		// Expected: `google.protobuf.Duration`, dot stripped, ranged over the
		// written text. Actual: nothing, for the same reason as above — the
		// escape that was meant to allow the leading dot is `\\.?` rather than
		// `\.?` (protoParser.ts:370). This is the same leading-dot gap already
		// fixed in annotations/extractor.ts, annotations/document.ts,
		// annotations/resolve.ts and index/parser.ts.
		const document = makeDocument(
			"message Book {\n  .google.protobuf.Duration loan = 1;\n}\n",
		);
		const refs = collectTypeReferences(document);
		expect(refs.map((r) => r.typeName)).toEqual(["google.protobuf.Duration"]);
		expect(refs[0].range.start.character).toBe(2);
	});

	test.skip("collects map key and value types", () => {
		// Expected: `Author` from the map value. Actual: nothing. The map regex
		// (protoParser.ts:373) carries the same `\\.?` typo as the field regex,
		// so it never matches either.
		const document = makeDocument(
			"message Book {\n  map<string, Author> authors = 1;\n}\n",
		);
		expect(collectTypeReferences(document).map((r) => r.typeName)).toContain(
			"Author",
		);
	});

	test.skip("strips the leading dot from an rpc type", () => {
		// Expected: `google.protobuf.Empty`. Actual: `.google.protobuf.Empty`.
		// The rpc branch (protoParser.ts:403-415) pushes the captured text
		// unchanged, while the field and map branches strip a leading dot
		// (lines 389, 420, 426). A reference carrying the dot matches no symbol
		// name, so find-references and rename miss fully-qualified rpc types.
		const document = makeDocument(
			"service Library {\n" +
				"  rpc Ping(.google.protobuf.Empty) returns (.google.protobuf.Empty);\n" +
				"}\n",
		);
		expect(collectTypeReferences(document).map((r) => r.typeName)).toEqual([
			"google.protobuf.Empty",
			"google.protobuf.Empty",
		]);
	});

	test.skip("ranges an rpc type at the type, not at the method name", () => {
		// Expected: the request reference starts at column 17, where `Book`
		// appears inside the parentheses. Actual: column 12, inside `CreateBook`
		// — the range is found with `line.indexOf(typeName)`
		// (protoParser.ts:405), which finds the first textual occurrence and
		// therefore lands on the method name whenever the type is a substring of
		// it. `rpc CreateBook(Book) returns (Book)` is the idiomatic AIP shape,
		// and rename edits these ranges, so it rewrites the middle of the method
		// name. Both request and response also collapse onto the same range.
		const document = makeDocument(
			"service Library {\n  rpc CreateBook(Book) returns (Book);\n}\n",
		);
		const refs = collectTypeReferences(document);
		expect(refs[0].range.start.character).toBe(17);
		expect(refs[1].range.start.character).toBe(31);
	});
});
