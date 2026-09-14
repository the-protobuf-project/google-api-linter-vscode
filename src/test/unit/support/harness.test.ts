/**
 * Tests for the test harness.
 *
 * The fixtures are shared by every other unit test, so a bug here reads as a
 * failure somewhere else entirely. `atCursor` in particular has caught a real
 * mistake already: reusing one uri across fixtures made the providers' cached
 * model leak between tests.
 */

import { describe, expect, test } from "bun:test";
import { atCursor, makeDocument } from "./fixtures";

describe("makeDocument", () => {
	test("round-trips offsets and positions", () => {
		const document = makeDocument('syntax = "proto3";\n\nmessage M {\n}\n');
		const offset = document.offsetAt({ line: 2, character: 8 } as never);
		const position = document.positionAt(offset);
		expect(position.line).toBe(2);
		expect(position.character).toBe(8);
	});

	test("reads a line by number", () => {
		const document = makeDocument("a\nbb\nccc\n");
		expect(document.lineAt(1).text).toBe("bb");
		expect(document.lineCount).toBe(4);
	});

	test("gives each document its own uri", () => {
		const first = makeDocument("a");
		const second = makeDocument("a");
		expect(first.uri.toString()).not.toBe(second.uri.toString());
	});
});

describe("atCursor", () => {
	test("removes the marker and reports its position", () => {
		const { document, position } = atCursor("message M {\n  int32 x = ▮1;\n}");
		expect(document.getText()).not.toContain("▮");
		expect(position.line).toBe(1);
		expect(position.character).toBe(12);
		expect(document.lineAt(1).text).toBe("  int32 x = 1;");
	});

	test("rejects a fixture with no marker", () => {
		expect(() => atCursor("message M {}")).toThrow("cursor marker");
	});
});
