/**
 * Tests for the lint capture.
 *
 * A capture is pasted into a bug report, so it is read by someone who does not
 * have the workspace. That makes two things load-bearing: the quoted source
 * line, which is the part of a screenshot that actually carries meaning, and
 * the rule links, which have to survive the AIP id's zero-padding or every one
 * of them 404s.
 *
 * It also has to stay bounded. A workspace with thousands of findings must
 * produce something a person can post, not a document nobody will read.
 */

import { describe, expect, test } from "bun:test";
import { buildCapture } from "../../../views/captureErrors";
import {
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	Position,
	Range,
	Uri,
} from "../support/vscode";

function diag(line: number, ruleId: string, message: string): Diagnostic {
	const d = new Diagnostic(
		new Range(new Position(line, 0), new Position(line, 8)),
		message,
		DiagnosticSeverity.Error,
	);
	d.source = "protobuf-aip-linter";
	(d as { code?: unknown }).code = { value: ruleId };
	return d;
}

/** A collection carrying the given findings for one file. */
function collectionWith(
	file: string,
	diagnostics: Diagnostic[],
): DiagnosticCollection {
	const collection = new DiagnosticCollection();
	(collection as { set(uri: unknown, value: unknown): void }).set(
		Uri.file(file),
		diagnostics,
	);
	return collection;
}

/** Stands in for reading a file, so no disk is touched. */
const lines: Record<number, string> = {
	9: "  string name = 1;",
	10: "  string title = 2;",
	54: "message Book {",
};
const readLine = async (
	_uri: unknown,
	line: number,
): Promise<string | undefined> => lines[line];

describe("buildCapture", () => {
	test("counts findings, files and rules", async () => {
		const collection = collectionWith("/ws/library.proto", [
			diag(9, "core::0192::has-comments", 'Missing comment over "name".'),
			diag(10, "core::0192::has-comments", 'Missing comment over "title".'),
			diag(
				54,
				"core::0123::resource-plural",
				"Resources should declare plural.",
			),
		]);

		const { markdown, total } = await buildCapture(
			collection as never,
			readLine,
		);
		expect(total).toBe(3);
		expect(markdown).toContain("**3** finding(s)");
		expect(markdown).toContain("**1** file(s)");
		expect(markdown).toContain("**2** rule(s)");
	});

	test("quotes the offending source line", async () => {
		const collection = collectionWith("/ws/library.proto", [
			diag(9, "core::0192::has-comments", 'Missing comment over "name".'),
		]);
		const { markdown } = await buildCapture(collection as never, readLine);
		// Without this the capture says a line is wrong without showing it,
		// which is exactly what makes a screenshot useful instead.
		expect(markdown).toContain("string name = 1;");
		expect(markdown).toContain("```proto");
	});

	test("links rules without the id's zero padding", async () => {
		const collection = collectionWith("/ws/library.proto", [
			diag(
				54,
				"core::0123::resource-plural",
				"Resources should declare plural.",
			),
		]);
		const { markdown } = await buildCapture(collection as never, readLine);
		expect(markdown).toContain("https://linter.aip.dev/123/resource-plural");
		expect(markdown).not.toContain("/0123/");
	});

	test("puts the loudest rule first", async () => {
		const collection = collectionWith("/ws/library.proto", [
			diag(54, "rare::rule::x", "once"),
			diag(9, "loud::rule::y", "twice a"),
			diag(10, "loud::rule::y", "twice b"),
		]);
		const { markdown } = await buildCapture(collection as never, readLine);
		expect(markdown.indexOf("### loud::rule::y")).toBeLessThan(
			markdown.indexOf("### rare::rule::x"),
		);
	});

	test("ignores diagnostics from other extensions", async () => {
		const foreign = new Diagnostic(
			new Range(new Position(1, 0), new Position(1, 2)),
			"someone else's problem",
			DiagnosticSeverity.Error,
		);
		foreign.source = "some-other-linter";
		const collection = collectionWith("/ws/library.proto", [foreign]);

		const { total, markdown } = await buildCapture(
			collection as never,
			readLine,
		);
		expect(total).toBe(0);
		expect(markdown).not.toContain("someone else's problem");
	});

	test("stays bounded and says what it left out", async () => {
		const many = Array.from({ length: 260 }, (_, at) =>
			diag(at, "core::0192::has-comments", `Missing comment ${at}`),
		);
		const collection = collectionWith("/ws/huge.proto", many);

		const { markdown, total } = await buildCapture(
			collection as never,
			readLine,
		);
		expect(total).toBe(260);
		// The summary table still accounts for all of them; only the quoted
		// detail is capped, and the capture admits it.
		expect(markdown).toContain("| 260 |");
		expect(markdown).toContain("further finding(s) not quoted");
	});

	test("carries the environment a maintainer will ask for", async () => {
		const collection = collectionWith("/ws/library.proto", [
			diag(9, "core::0192::has-comments", "Missing comment"),
		]);
		const { markdown } = await buildCapture(collection as never, readLine);
		expect(markdown).toContain("<details><summary>Environment</summary>");
		expect(markdown).toContain("- VS Code");
		expect(markdown).toContain("- Platform");
	});

	test("produces something usable when there is nothing to report", async () => {
		const { markdown, total } = await buildCapture(
			new DiagnosticCollection() as never,
			readLine,
		);
		expect(total).toBe(0);
		expect(markdown).toContain("**0** finding(s)");
	});
});
