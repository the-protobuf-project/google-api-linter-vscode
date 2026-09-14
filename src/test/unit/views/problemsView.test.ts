/**
 * Tests for the Problems view.
 *
 * The empty state is the interesting part. A `TreeItem` is always a
 * left-aligned row, so "no problems found" is a `viewsWelcome` contribution
 * rather than a node — and VS Code only renders one when the view has no
 * children at all. A placeholder row would suppress the very thing it was
 * standing in for, so returning nothing is load-bearing rather than an
 * omission.
 */

import { describe, expect, test } from "bun:test";
import { ProblemsProvider } from "../../../views/problemsView";
import {
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	Position,
	Range,
	Uri,
} from "../support/vscode";

function diag(line: number, ruleId: string, message = "boom"): Diagnostic {
	const d = new Diagnostic(
		new Range(new Position(line, 0), new Position(line, 4)),
		message,
		DiagnosticSeverity.Error,
	);
	d.source = "protobuf-aip-linter";
	(d as { code?: unknown }).code = { value: ruleId };
	return d;
}

function collectionWith(
	entries: Array<[string, Diagnostic[]]>,
): DiagnosticCollection {
	const collection = new DiagnosticCollection();
	for (const [file, diagnostics] of entries) {
		(collection as { set(uri: unknown, value: unknown): void }).set(
			Uri.file(file),
			diagnostics,
		);
	}
	return collection;
}

describe("empty state", () => {
	test("yields no children at all, so the welcome view can show", () => {
		const provider = new ProblemsProvider(new DiagnosticCollection() as never);
		// Not a placeholder row: VS Code renders `viewsWelcome` only for a view
		// with nothing in it, so a "No problems found" node would hide the
		// centred message it was imitating.
		expect(provider.getChildren()).toEqual([]);
		provider.dispose();
	});

	test("ignores another extension's findings when deciding it is empty", () => {
		const foreign = new Diagnostic(
			new Range(new Position(1, 0), new Position(1, 2)),
			"not ours",
			DiagnosticSeverity.Error,
		);
		foreign.source = "some-other-linter";
		const provider = new ProblemsProvider(
			collectionWith([["/ws/a.proto", [foreign]]]) as never,
		);
		expect(provider.getChildren()).toEqual([]);
		expect(provider.total()).toBe(0);
		provider.dispose();
	});
});

describe("grouping", () => {
	test("groups by rule, loudest first", () => {
		const provider = new ProblemsProvider(
			collectionWith([
				[
					"/ws/a.proto",
					[
						diag(1, "rare::rule::x"),
						diag(2, "loud::rule::y"),
						diag(3, "loud::rule::y"),
					],
				],
			]) as never,
		);
		const roots = provider.getChildren();
		expect(roots.map((n) => (n.kind === "rule" ? n.ruleId : n.kind))).toEqual([
			"loud::rule::y",
			"rare::rule::x",
		]);
		expect(roots[0].kind === "rule" && roots[0].count).toBe(2);
		provider.dispose();
	});

	test("switches to grouping by file and back", () => {
		const provider = new ProblemsProvider(
			collectionWith([
				["/ws/a.proto", [diag(1, "r::a::b")]],
				["/ws/b.proto", [diag(1, "r::a::b"), diag(2, "r::c::d")]],
			]) as never,
		);
		expect(provider.getChildren()[0].kind).toBe("rule");

		expect(provider.toggleGrouping()).toBe("file");
		const byFile = provider.getChildren();
		expect(byFile[0].kind).toBe("file");
		// Two findings in b.proto puts it ahead of a.proto's one.
		expect(byFile[0].kind === "file" && byFile[0].count).toBe(2);

		expect(provider.toggleGrouping()).toBe("rule");
		expect(provider.getChildren()[0].kind).toBe("rule");
		provider.dispose();
	});

	test("counts every finding, not every group", () => {
		const provider = new ProblemsProvider(
			collectionWith([
				["/ws/a.proto", [diag(1, "r::a::b"), diag(2, "r::a::b")]],
				["/ws/b.proto", [diag(1, "r::c::d")]],
			]) as never,
		);
		expect(provider.total()).toBe(3);
		expect(provider.getChildren()).toHaveLength(2);
		provider.dispose();
	});
});
