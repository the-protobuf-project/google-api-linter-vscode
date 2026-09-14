/**
 * Tests for the Details payload builder.
 *
 * Two things are load-bearing here and neither is obvious from the types.
 *
 * The span calculation decides which findings belong to which symbol. Get it
 * wrong and every problem in a file is attributed to whichever symbol happens
 * to be first, which is worse than showing no attribution at all.
 *
 * The field parser has to follow a multi-line `[...]` option block. Real protos
 * write `field_behavior` across several lines far more often than on one, and a
 * parser that reads only the declaration line reports every such field as
 * having no behaviour set — the exact opposite of the truth.
 *
 * The fixture is a trimmed copy of a proto that `api-linter 2.3.1` really was
 * run against, so the rule ids and messages below are the ones it emits.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	IndexedFile,
	IndexedSymbol,
	ProtoIndex,
	SymbolKind,
} from "../../../index/types";
import {
	attributeProblems,
	buildSymbolDetail,
	symbolSpan,
} from "../../../views/symbolDetail";
import {
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	Position,
	Range,
	Uri,
} from "../support/vscode";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** Writes `content` to a throwaway directory and returns the file path. */
function writeProto(content: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "detail-"));
	tempRoots.push(root);
	const file = path.join(root, "library.proto");
	fs.writeFileSync(file, content, "utf8");
	return file;
}

function sym(
	fqn: string,
	kind: SymbolKind,
	line: number,
	extra: Partial<IndexedSymbol> = {},
): IndexedSymbol {
	return {
		fqn,
		name: fqn.split(".").pop() ?? fqn,
		kind,
		fileId: 1,
		line,
		startCol: 0,
		endCol: 0,
		...extra,
	};
}

function diag(line: number, ruleId: string, message = "boom"): Diagnostic {
	const d = new Diagnostic(
		new Range(new Position(line, 0), new Position(line, 5)),
		message,
		DiagnosticSeverity.Error,
	);
	d.source = "protobuf-aip-linter";
	// The stub types `code` as the scalar form; the real API also allows the
	// `{value, target}` shape the linter actually publishes, which is the one
	// under test here.
	(d as { code?: unknown }).code = {
		value: ruleId,
		target: Uri.parse(`https://linter.aip.dev/${ruleId}`),
	};
	return d;
}

/**
 * Publishes stub diagnostics onto a stub collection.
 *
 * Both are structurally narrower than the `vscode` types the builder is written
 * against, so the cast is confined here rather than repeated at every call.
 */
function setDiagnostics(
	collection: DiagnosticCollection,
	file: string,
	diagnostics: Diagnostic[],
): void {
	(collection as { set(uri: unknown, value: unknown): void }).set(
		Uri.file(file),
		diagnostics,
	);
}

/** A `ProtoIndex` implementing only what the builder calls. */
function fakeIndex(file: IndexedFile, symbols: IndexedSymbol[]): ProtoIndex {
	return {
		symbol: (fqn: string) => symbols.find((s) => s.fqn === fqn),
		file: (id: number) => (id === file.id ? file : undefined),
		symbolsInFile: () => symbols,
	} as unknown as ProtoIndex;
}

describe("symbolSpan", () => {
	test("a symbol owns every line up to the next non-descendant", () => {
		const symbols = [
			sym("library.v1.Book", "message", 10),
			sym("library.v1.Book.name", "field", 12, {
				parentFqn: "library.v1.Book",
			}),
			sym("library.v1.GetBookRequest", "message", 20),
		];
		expect(symbolSpan(symbols, symbols[0], 40)).toEqual([10, 19]);
	});

	test("nested declarations do not close the span", () => {
		const symbols = [
			sym("p.Outer", "message", 1),
			sym("p.Outer.Inner", "message", 3),
			sym("p.Outer.Inner.deep", "field", 4),
			sym("p.Next", "message", 9),
		];
		expect(symbolSpan(symbols, symbols[0], 30)).toEqual([1, 8]);
	});

	test("the last symbol runs to the end of the file", () => {
		const symbols = [sym("p.Only", "message", 4)];
		expect(symbolSpan(symbols, symbols[0], 12)).toEqual([4, 11]);
	});

	test("a prefix that is not a descendant does not extend the span", () => {
		// `p.BookShelf` starts with `p.Book` as a string but is a sibling.
		const symbols = [
			sym("p.Book", "message", 2),
			sym("p.BookShelf", "message", 6),
		];
		expect(symbolSpan(symbols, symbols[0], 20)).toEqual([2, 5]);
	});
});

describe("attributeProblems", () => {
	test("collapses repeats of one rule and counts them", () => {
		const problems = attributeProblems(
			[
				diag(5, "core::0192::has-comments", 'Missing comment over "title".'),
				diag(6, "core::0192::has-comments", 'Missing comment over "author".'),
				diag(7, "core::0192::has-comments", 'Missing comment over "read".'),
			],
			[0, 20],
			"/tmp/library.proto",
		);
		expect(problems).toHaveLength(1);
		expect(problems[0].occurrences).toBe(3);
		expect(problems[0].lines).toEqual([5, 6, 7]);
	});

	test("ignores findings outside the span", () => {
		const problems = attributeProblems(
			[diag(2, "a::b::c"), diag(50, "d::e::f")],
			[0, 10],
			"/tmp/x.proto",
		);
		expect(problems.map((p) => p.ruleId)).toEqual(["a::b::c"]);
	});

	test("ignores diagnostics from other extensions", () => {
		const foreign = new Diagnostic(
			new Range(new Position(1, 0), new Position(1, 1)),
			"from someone else",
			DiagnosticSeverity.Error,
		);
		foreign.source = "some-other-linter";
		expect(attributeProblems([foreign], [0, 10], "/tmp/x.proto")).toHaveLength(
			0,
		);
	});

	test("orders by occurrence count so the loudest rule reads first", () => {
		const problems = attributeProblems(
			[
				diag(1, "rare::rule::x"),
				diag(2, "loud::rule::y"),
				diag(3, "loud::rule::y"),
				diag(4, "loud::rule::y"),
			],
			[0, 10],
			"/tmp/x.proto",
		);
		expect(problems[0].ruleId).toBe("loud::rule::y");
		expect(problems[0].occurrences).toBe(3);
	});

	test("carries the rule documentation url through", () => {
		const problems = attributeProblems(
			[diag(1, "core::0123::resource-singular")],
			[0, 10],
			"/tmp/x.proto",
		);
		expect(problems[0].docUrl).toContain("linter.aip.dev");
	});
});

describe("buildSymbolDetail", () => {
	const PROTO = `syntax = "proto3";

package library.v1;

message Book {
  option (google.api.resource) = {
    type: "library.googleapis.com/Book"
    pattern: "shelves/{shelf}/books/{book}"
  };

  string name = 1;
  string title = 2 [
    (google.api.field_behavior) = OPTIONAL
  ];
  repeated string tags = 3;
  google.protobuf.Timestamp create_time = 4 [(google.api.field_behavior) = OUTPUT_ONLY];
}

message GetBookRequest {
  string name = 1;
}
`;

	function setup() {
		const file = writeProto(PROTO);
		const indexedFile: IndexedFile = {
			id: 1,
			path: file,
			packageName: "library.v1",
			imports: [],
			mtimeMs: 0,
		};
		const symbols = [
			sym("library.v1.Book", "message", 4),
			sym("library.v1.GetBookRequest", "message", 18),
		];
		return { file, index: fakeIndex(indexedFile, symbols) };
	}

	test("reads fields, numbers and repeated-ness", async () => {
		const { file, index } = setup();
		const collection = new DiagnosticCollection();
		setDiagnostics(collection, file, []);

		const detail = await buildSymbolDetail(
			index,
			"library.v1.Book",
			collection as never,
		);

		expect(detail).not.toBeNull();
		expect(detail?.fields.map((f) => f.name)).toEqual([
			"name",
			"title",
			"tags",
			"create_time",
		]);
		expect(detail?.fields[2].repeated).toBe(true);
		expect(detail?.fields[3].number).toBe(4);
	});

	test("finds field_behavior written across several lines", async () => {
		const { file, index } = setup();
		const collection = new DiagnosticCollection();
		setDiagnostics(collection, file, []);

		const detail = await buildSymbolDetail(
			index,
			"library.v1.Book",
			collection as never,
		);

		// `title` spreads its option over three lines; a single-line parser
		// would report it as having no behaviour at all.
		expect(detail?.fields[1].behaviors).toEqual(["OPTIONAL"]);
		expect(detail?.fields[3].behaviors).toEqual(["OUTPUT_ONLY"]);
		expect(detail?.fields[0].behaviors).toEqual([]);
	});

	test("does not leak the next message's fields into this one", async () => {
		const { file, index } = setup();
		const collection = new DiagnosticCollection();
		setDiagnostics(collection, file, []);

		const detail = await buildSymbolDetail(
			index,
			"library.v1.GetBookRequest",
			collection as never,
		);
		expect(detail?.fields.map((f) => f.name)).toEqual(["name"]);
	});

	test("reports a resource option's set and absent keys", async () => {
		const { file, index } = setup();
		const collection = new DiagnosticCollection();
		setDiagnostics(collection, file, [
			diag(
				5,
				"core::0123::resource-singular",
				"Resources should declare singular",
			),
			diag(
				5,
				"core::0123::resource-plural",
				"Resources should declare plural.",
			),
		]);

		const detail = await buildSymbolDetail(
			index,
			"library.v1.Book",
			collection as never,
		);

		expect(detail?.isResource).toBe(true);
		const resource = detail?.annotations.find(
			(a) => a.name === "google.api.resource",
		);
		const byKey = new Map(resource?.keys.map((k) => [k.key, k]));
		expect(byKey.get("type")?.value).toContain("library.googleapis.com/Book");
		// The absent keys are the point: a panel that renders only what exists
		// can never say "singular is not set".
		expect(byKey.get("singular")?.value).toBeUndefined();
		expect(byKey.get("singular")?.requiredBy).toBe(
			"core::0123::resource-singular",
		);
		expect(byKey.get("plural")?.requiredBy).toBe("core::0123::resource-plural");
	});

	test("problemTotal counts occurrences, not collapsed rows", async () => {
		const { file, index } = setup();
		const collection = new DiagnosticCollection();
		setDiagnostics(collection, file, [
			diag(10, "core::0192::has-comments"),
			diag(11, "core::0192::has-comments"),
			diag(14, "core::0192::has-comments"),
		]);

		const detail = await buildSymbolDetail(
			index,
			"library.v1.Book",
			collection as never,
		);
		expect(detail?.problems).toHaveLength(1);
		expect(detail?.problemTotal).toBe(3);
	});

	test("returns null for a symbol the index does not have", async () => {
		const { index } = setup();
		const collection = new DiagnosticCollection();
		const detail = await buildSymbolDetail(
			index,
			"library.v1.Nope",
			collection as never,
		);
		expect(detail).toBeNull();
	});
});
