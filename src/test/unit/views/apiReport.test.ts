/**
 * Tests for the whole-workspace API report.
 *
 * The report is the one output that leaves the editor — it gets committed,
 * pasted into a pull request, rendered by GitHub — so two things matter beyond
 * "it produced a string".
 *
 * Markdown is whitespace- and pipe-sensitive: a type name containing `|` or a
 * doc comment containing a newline silently destroys a table. And the Mermaid
 * fences have to carry ids Mermaid accepts, because a fence that fails to parse
 * renders as an error box in the reader's browser rather than falling back to
 * text.
 *
 * The fixture mirrors the shape of a real AIP service: five standard methods
 * over one resource, sharing request and response types.
 */

import { describe, expect, test } from "bun:test";
import type {
	IndexedFile,
	IndexedSymbol,
	ProtoIndex,
	SymbolKind,
} from "../../../index/types";
import { buildApiReport } from "../../../views/apiReport";
import { DiagnosticCollection, Uri } from "../support/vscode";

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

const FILE: IndexedFile = {
	id: 1,
	path: "/ws/library/v1/library.proto",
	packageName: "library.v1",
	imports: ["google/api/annotations.proto"],
	mtimeMs: 0,
};

/** A service with the five standard methods, all over one resource. */
const SYMBOLS: IndexedSymbol[] = [
	sym("library.v1.LibraryService", "service", 10, {
		doc: "Manages books. Supports the standard methods.",
	}),
	sym("library.v1.LibraryService.GetBook", "rpc", 12, {
		parentFqn: "library.v1.LibraryService",
		detail: "(GetBookRequest) returns (Book)",
	}),
	sym("library.v1.LibraryService.ListBooks", "rpc", 16, {
		parentFqn: "library.v1.LibraryService",
		detail: "(ListBooksRequest) returns (ListBooksResponse)",
	}),
	sym("library.v1.LibraryService.CreateBook", "rpc", 20, {
		parentFqn: "library.v1.LibraryService",
		detail: "(CreateBookRequest) returns (Book)",
	}),
	sym("library.v1.Book", "message", 40, { doc: "A book. Has a title." }),
	sym("library.v1.GetBookRequest", "message", 50),
	sym("library.v1.ListBooksRequest", "message", 55),
	sym("library.v1.ListBooksResponse", "message", 60),
	sym("library.v1.CreateBookRequest", "message", 65),
	sym("library.v1.Priority", "enum", 80, { doc: "Priority levels." }),
];

function fakeIndex(
	symbols: IndexedSymbol[] = SYMBOLS,
	files: IndexedFile[] = [FILE],
): ProtoIndex {
	return {
		files: () => files,
		file: (id: number) => files.find((f) => f.id === id),
		symbolsInFile: (id: number) => symbols.filter((s) => s.fileId === id),
		stats: () => ({ tier: "full" }),
	} as unknown as ProtoIndex;
}

/** An empty collection; the report must work with no findings at all. */
function noDiagnostics(): DiagnosticCollection {
	return new DiagnosticCollection();
}

describe("buildApiReport", () => {
	test("counts what it found", () => {
		const report = buildApiReport(fakeIndex(), noDiagnostics() as never, {
			title: "Library",
		});
		expect(report.stats.services).toBe(1);
		expect(report.stats.rpcs).toBe(3);
		expect(report.stats.messages).toBe(5);
		expect(report.stats.enums).toBe(1);
		expect(report.stats.packages).toBe(1);
	});

	test("uses the title it is given", () => {
		const report = buildApiReport(fakeIndex(), noDiagnostics() as never, {
			title: "Library",
		});
		expect(report.markdown.startsWith("# Library\n")).toBe(true);
	});

	test("lists every RPC with its request and response", () => {
		const { markdown } = buildApiReport(fakeIndex(), noDiagnostics() as never);
		expect(markdown).toContain("### LibraryService");
		for (const rpc of ["GetBook", "ListBooks", "CreateBook"]) {
			expect(markdown).toContain(`\`${rpc}\``);
		}
		// The detail string is `(Request) returns (Response)`; both halves have
		// to survive the split or the table is wrong in a way nothing else shows.
		expect(markdown).toContain("`GetBookRequest`");
		expect(markdown).toContain("`ListBooksResponse`");
	});

	test("emits a parseable mermaid graph per service", () => {
		const { markdown } = buildApiReport(fakeIndex(), noDiagnostics() as never);
		const fences = markdown.match(/```mermaid\n([\s\S]*?)```/g) ?? [];
		expect(fences.length).toBeGreaterThan(0);

		const graph = fences[0] as string;
		expect(graph).toContain("graph LR");
		expect(graph).toContain("-.->|returns|");
		// Mermaid ids may not contain dots; an id like `library.v1.Book` makes
		// the whole fence fail to render.
		const ids = graph.match(/^\s{2}(\w+)/gm) ?? [];
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			expect(id.trim()).not.toContain(".");
		}
	});

	test("names the types more than one service depends on", () => {
		const second = [
			...SYMBOLS,
			sym("library.v1.ArchiveService", "service", 100),
			sym("library.v1.ArchiveService.ArchiveBook", "rpc", 102, {
				parentFqn: "library.v1.ArchiveService",
				detail: "(ArchiveBookRequest) returns (Book)",
			}),
		];
		const { markdown } = buildApiReport(
			fakeIndex(second),
			noDiagnostics() as never,
		);
		expect(markdown).toContain("Types shared across services");
		// `Book` is returned by both services, which is the coupling the
		// section exists to surface.
		expect(markdown).toMatch(/\|\s*`Book`\s*\|/);
	});

	test("says so plainly when nothing is shared", () => {
		const { markdown } = buildApiReport(fakeIndex(), noDiagnostics() as never);
		expect(markdown).toContain(
			"_No message type is used by more than one service._",
		);
	});

	test("escapes pipes so a type name cannot break a table", () => {
		const hostile = [
			sym("library.v1.Weird", "message", 5, {
				doc: "A doc with a | pipe\nand a newline.",
			}),
		];
		const { markdown } = buildApiReport(
			fakeIndex(hostile),
			noDiagnostics() as never,
		);
		const row = markdown
			.split("\n")
			.find((line) => line.includes("`Weird`")) as string;
		expect(row).toBeDefined();
		// Five pipes: the row's own four delimiters plus the escaped one.
		expect(row.includes("\\|")).toBe(true);
		expect(row.split("\n")).toHaveLength(1);
	});

	test("reports an empty workspace without inventing sections", () => {
		const { markdown, stats } = buildApiReport(
			fakeIndex([], []),
			noDiagnostics() as never,
		);
		expect(stats.services).toBe(0);
		expect(markdown).toContain("## At a glance");
		expect(markdown).not.toContain("## Services");
		expect(markdown).not.toContain("```mermaid");
	});

	test("stops when cancelled", () => {
		const { stats } = buildApiReport(fakeIndex(), noDiagnostics() as never, {
			isCancelled: () => true,
		});
		// The gather loop breaks before reading any file.
		expect(stats.services).toBe(0);
	});

	test("restricts to the packages it is given", () => {
		const other: IndexedFile = {
			id: 2,
			path: "/ws/other/v1/other.proto",
			packageName: "other.v1",
			imports: [],
			mtimeMs: 0,
		};
		const symbols = [
			...SYMBOLS,
			sym("other.v1.Thing", "message", 3, { fileId: 2 }),
		];
		const { markdown, stats } = buildApiReport(
			fakeIndex(symbols, [FILE, other]),
			noDiagnostics() as never,
			{ packages: ["library"] },
		);
		expect(stats.messages).toBe(5);
		expect(markdown).not.toContain("`Thing`");
	});

	test("links each rule to its documentation", () => {
		const collection = new DiagnosticCollection();
		const diagnostic = {
			range: { start: { line: 40, character: 0 } },
			message: "Missing comment",
			severity: 0,
			source: "protobuf-aip-linter",
			code: { value: "core::0192::has-comments" },
		};
		(collection as { set(uri: unknown, value: unknown): void }).set(
			Uri.file(FILE.path),
			[diagnostic],
		);

		const { markdown } = buildApiReport(fakeIndex(), collection as never);
		expect(markdown).toContain("## Lint findings by rule");
		// The rule id zero-pads the AIP number; linter.aip.dev does not.
		expect(markdown).toContain(
			"[`core::0192::has-comments`](https://linter.aip.dev/192/has-comments)",
		);
	});
});
