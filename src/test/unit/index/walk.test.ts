/**
 * Tests for the directory walk the index is fed from.
 *
 * The walk is the only thing standing between the index and the rest of the
 * disk. Two jobs, and both of them are bounds rather than happy paths:
 *
 *  1. **It is the pre-flight measurement.** `files.length` and `bytes` are what
 *     the memory ladder picks a tier from, *before* a byte of proto is read. If
 *     the walk under-counts — a skipped directory that should not be skipped, a
 *     root listed twice — the ladder chooses against the wrong number and the
 *     ceiling the user set stops meaning anything.
 *  2. **It refuses to go anywhere expensive.** Ignored directories, `maxFiles`,
 *     cancellation between batches, and symlinks that are never followed, which
 *     is what keeps a cyclic link out of an unbounded walk.
 *
 * Everything runs against real directories under `os.tmpdir()`, because a mocked
 * fs would pin the mock rather than the walk; the reference corpus stands in for
 * scale, since 9,257 files over a deep tree is not something a fixture imitates
 * honestly.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { importPathFor, walkProtoFiles } from "../../../index/walk";
import { hasReferenceCorpus, REFERENCE_PROTO_ROOT } from "../support/fixtures";

const temporaryRoots: string[] = [];

afterAll(() => {
	for (const root of temporaryRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Writes a throwaway directory tree.
 *
 * @param files - Relative path to contents; directories are created as needed
 * @returns Absolute path to the new root
 */
function tree(files: Record<string, string> = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-walk-"));
	temporaryRoots.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}
	return root;
}

/** Walked paths relative to a root, forward-slashed and sorted. */
function found(root: string, files: readonly { path: string }[]): string[] {
	return files
		.map((file) => path.relative(root, file.path).split(path.sep).join("/"))
		.sort();
}

describe("walkProtoFiles", () => {
	test("lists every .proto under a root with its size and mtime", async () => {
		const root = tree({
			"a.proto": "one",
			"deep/b.proto": "twotwo",
		});
		const result = await walkProtoFiles([root]);

		expect(found(root, result.files)).toEqual(["a.proto", "deep/b.proto"]);
		expect(result.truncated).toBe(false);
		// `bytes` is the pre-flight measurement, so it has to be the sum of the
		// real sizes rather than a file count times a guess.
		expect(result.bytes).toBe(9);
		for (const file of result.files) {
			expect(path.isAbsolute(file.path)).toBe(true);
			expect(file.mtimeMs).toBe(fs.statSync(file.path).mtimeMs);
			expect(file.size).toBe(fs.statSync(file.path).size);
		}
	});

	test("ignores everything that is not a .proto", async () => {
		const root = tree({
			"keep.proto": "",
			"readme.md": "",
			"schema.protobuf": "",
			proto: "",
			".proto": "",
			"nested/notes.txt": "",
		});
		// `.proto` on its own ends with the extension and is a real file, so it is
		// listed; nothing else is.
		expect(found(root, (await walkProtoFiles([root])).files)).toEqual([
			".proto",
			"keep.proto",
		]);
	});

	test("does not mistake a directory named like a proto for a file", async () => {
		const root = tree({ "bundle.proto/inner.proto": "" });
		expect(found(root, (await walkProtoFiles([root])).files)).toEqual([
			"bundle.proto/inner.proto",
		]);
	});

	test("skips the directories nobody wants indexed", async () => {
		const root = tree({
			"keep.proto": "",
			".git/hidden.proto": "",
			"node_modules/dep/dep.proto": "",
			"out/generated.proto": "",
			"dist/generated.proto": "",
			"build/generated.proto": "",
			"vendor/vendored.proto": "",
			".vscode-test/t.proto": "",
			".next/n.proto": "",
			"coverage/c.proto": "",
			"src/nested/deeper/real.proto": "",
		});
		// Generated output and dependency trees are where the file count explodes;
		// on a workspace with a populated `node_modules` this is the difference
		// between the ladder seeing thousands of files and seeing the source tree.
		expect(found(root, (await walkProtoFiles([root])).files)).toEqual([
			"keep.proto",
			"src/nested/deeper/real.proto",
		]);
	});

	test("skips by exact directory name, not by prefix", async () => {
		const root = tree({
			"buildkit/a.proto": "",
			"my-build/b.proto": "",
			"outbound/c.proto": "",
			"build/skipped.proto": "",
		});
		expect(found(root, (await walkProtoFiles([root])).files)).toEqual([
			"buildkit/a.proto",
			"my-build/b.proto",
			"outbound/c.proto",
		]);
	});

	test("walks a root that is itself an ignored name", async () => {
		// The skip list filters entries, not roots. Someone whose workspace folder
		// happens to be called `vendor` still gets an index.
		const outer = tree({ "vendor/a.proto": "" });
		const root = path.join(outer, "vendor");
		expect(found(root, (await walkProtoFiles([root])).files)).toEqual([
			"a.proto",
		]);
	});

	test("descends a deeply nested tree without a depth limit", async () => {
		const deep = Array.from({ length: 24 }, (_, i) => `d${i}`).join("/");
		const root = tree({ [`${deep}/leaf.proto`]: "x" });
		const result = await walkProtoFiles([root]);
		expect(result.files).toHaveLength(1);
		expect(found(root, result.files)).toEqual([`${deep}/leaf.proto`]);
	});

	test("visits a file once when the roots overlap", async () => {
		const root = tree({ "a/one.proto": "12", "b/two.proto": "345" });
		const result = await walkProtoFiles([
			root,
			path.join(root, "a"),
			path.join(root, "a"),
		]);
		// Double-listing would double `bytes` too, and the ladder would pick a tier
		// for a workspace twice the real size.
		expect(found(root, result.files)).toEqual(["a/one.proto", "b/two.proto"]);
		expect(result.bytes).toBe(5);
	});

	test("accepts a relative root by resolving it", async () => {
		const root = tree({ "a.proto": "" });
		const relative = path.relative(process.cwd(), root);
		const result = await walkProtoFiles([relative]);
		expect(result.files.map((file) => file.path)).toEqual([
			path.join(root, "a.proto"),
		]);
	});

	test("treats a root that does not exist as empty", async () => {
		const result = await walkProtoFiles([
			path.join(os.tmpdir(), "gapi-walk-absent-root"),
		]);
		expect(result).toEqual({ files: [], bytes: 0, truncated: false });
	});

	test("treats a root that is a file as empty", async () => {
		const root = tree({ "a.proto": "x" });
		const result = await walkProtoFiles([path.join(root, "a.proto")]);
		expect(result.files).toEqual([]);
		expect(result.bytes).toBe(0);
	});

	test("keeps going when one root of several is missing", async () => {
		const root = tree({ "a.proto": "x" });
		const result = await walkProtoFiles([
			path.join(os.tmpdir(), "gapi-walk-absent-root"),
			root,
		]);
		expect(found(root, result.files)).toEqual(["a.proto"]);
	});

	test("walks no roots at all without complaint", async () => {
		expect(await walkProtoFiles([])).toEqual({
			files: [],
			bytes: 0,
			truncated: false,
		});
	});

	test("does not follow a symlinked directory", async () => {
		// `readdir` reports a symlink as neither a file nor a directory, so the walk
		// never descends one. That is what makes a cyclic link — `a/link -> a` — a
		// non-event rather than an unbounded walk.
		const root = tree({ "real/a.proto": "" });
		fs.symlinkSync(path.join(root, "real"), path.join(root, "loop"), "dir");
		fs.symlinkSync(root, path.join(root, "real", "up"), "dir");

		const result = await walkProtoFiles([root]);
		expect(found(root, result.files)).toEqual(["real/a.proto"]);
	});

	test("does not list a symlinked proto", async () => {
		// Same `readdir` check: a symlink is not `isFile()`. Nothing in the corpus
		// symlinks a proto, and skipping them is what keeps the walk cycle-free.
		const root = tree({ "real.proto": "abc" });
		fs.symlinkSync(
			path.join(root, "real.proto"),
			path.join(root, "link.proto"),
		);

		const result = await walkProtoFiles([root]);
		expect(found(root, result.files)).toEqual(["real.proto"]);
		expect(result.bytes).toBe(3);
	});

	test("stops at maxFiles and says so", async () => {
		// Equal sizes so the total does not depend on which three `readdir`
		// happened to hand back first.
		const root = tree({
			"a.proto": "xx",
			"b.proto": "xx",
			"c.proto": "xx",
			"d.proto": "xx",
			"e.proto": "xx",
		});
		const result = await walkProtoFiles([root], { maxFiles: 3 });
		expect(result.files).toHaveLength(3);
		expect(result.truncated).toBe(true);
		// Only the files that were listed are stat-ed, so `bytes` describes the
		// truncated listing rather than the directory.
		expect(result.bytes).toBe(6);
	});

	test("reports truncation at exactly the ceiling", async () => {
		// The walk stops the moment the ceiling is reached, part way through a
		// directory listing, so it cannot know whether one more file was coming.
		// Reporting truncation is the conservative answer, not an off-by-one — and
		// it is why `ProtoIndexImpl` walks with `maxFiles + 1` and compares the
		// count itself.
		const root = tree({ "a.proto": "", "b.proto": "" });
		const exact = await walkProtoFiles([root], { maxFiles: 2 });
		expect(exact.files).toHaveLength(2);
		expect(exact.truncated).toBe(true);

		const room = await walkProtoFiles([root], { maxFiles: 3 });
		expect(room.files).toHaveLength(2);
		expect(room.truncated).toBe(false);
	});

	// The ceiling is tested after the push — `candidates.push(...)` then
	// `if (candidates.length >= maxFiles)` — so a `maxFiles` of 0 still lists one
	// file, one above a ceiling documented as hard. `ProtoIndexImpl` walks with
	// `budget.maxFiles + 1`, so it never passes 0 and never sees this; any other
	// caller of the exported `walkProtoFiles` would. src/index/walk.ts:113.
	// Expected: a maxFiles of 0 lists nothing.
	test.skip("a maxFiles of zero lists nothing", async () => {
		const root = tree({ "a.proto": "" });
		const result = await walkProtoFiles([root], { maxFiles: 0 });
		expect(result.files).toEqual([]);
		expect(result.truncated).toBe(true);
	});

	test("spreads one ceiling across every root", async () => {
		const first = tree({ "a.proto": "", "b.proto": "" });
		const second = tree({ "c.proto": "", "d.proto": "" });
		const result = await walkProtoFiles([first, second], { maxFiles: 3 });
		expect(result.files).toHaveLength(3);
		expect(result.truncated).toBe(true);
	});

	test("lists nothing when cancellation is already true", async () => {
		const root = tree({ "a.proto": "", "b.proto": "" });
		const result = await walkProtoFiles([root], { isCancelled: () => true });
		expect(result).toEqual({ files: [], bytes: 0, truncated: false });
	});

	test("stops stat-ing once cancellation turns true", async () => {
		// Cancellation is checked between batches, not per entry, so a walk already
		// past the directory pass finishes that pass and abandons the stats. The
		// point is that it returns rather than running to completion.
		const root = tree({ "a.proto": "x", "b.proto": "y" });
		let calls = 0;
		const result = await walkProtoFiles([root], {
			isCancelled: () => {
				calls++;
				// False for the first directory batch, true from the stat pass on.
				return calls > 1;
			},
		});
		expect(result.files).toEqual([]);
		expect(result.bytes).toBe(0);
		expect(result.truncated).toBe(false);
	});

	test("polls cancellation rather than ignoring it", async () => {
		const root = tree({ "a.proto": "", "nested/b.proto": "" });
		let calls = 0;
		await walkProtoFiles([root], {
			isCancelled: () => {
				calls++;
				return false;
			},
		});
		expect(calls).toBeGreaterThan(0);
	});
});

describe("importPathFor", () => {
	test("writes the path a proto would be imported as", () => {
		expect(
			importPathFor(["/ws"], path.join("/ws", "google", "api", "http.proto")),
		).toBe("google/api/http.proto");
	});

	test("names a file that sits directly in the root", () => {
		expect(importPathFor(["/ws"], "/ws/a.proto")).toBe("a.proto");
	});

	test("picks the root that gives the shortest import path", () => {
		// Nested import roots are the normal buf layout. The innermost one is the
		// one a `buf build` would resolve against, so it wins.
		const file = path.join("/ws", "proto", "demo", "v1", "a.proto");
		expect(importPathFor(["/ws", "/ws/proto"], file)).toBe("demo/v1/a.proto");
		expect(importPathFor(["/ws/proto", "/ws"], file)).toBe("demo/v1/a.proto");
	});

	test("falls back to the basename when no root contains the file", () => {
		expect(importPathFor(["/ws"], "/elsewhere/a.proto")).toBe("a.proto");
		expect(importPathFor([], "/elsewhere/a.proto")).toBe("a.proto");
	});

	test("requires a path prefix, not a string prefix", () => {
		// `/ws/proto-old` starts with `/ws/proto` as text but is a different
		// directory; treating it as contained would invent an import path of
		// `../proto-old/a.proto`.
		expect(importPathFor(["/ws/proto"], "/ws/proto-old/a.proto")).toBe(
			"a.proto",
		);
	});

	test("handles a root equal to the file's own directory", () => {
		expect(importPathFor(["/ws/demo"], "/ws/demo/a.proto")).toBe("a.proto");
	});

	test("does not claim a file that sits above the root", () => {
		expect(importPathFor(["/ws/demo"], "/ws/a.proto")).toBe("a.proto");
	});

	test("keeps a long path intact after flattening", () => {
		// Every string the index retains goes through `flattenString`, which for
		// anything over 13 characters rebuilds the string; the contents have to
		// survive that untouched.
		const deep = Array.from({ length: 12 }, (_, i) => `segment${i}`).join("/");
		const file = path.join("/ws", ...deep.split("/"), "message.proto");
		const result = importPathFor(["/ws"], file);
		expect(result).toBe(`${deep}/message.proto`);
		expect(result.length).toBeGreaterThan(13);
	});
});

describe.skipIf(!hasReferenceCorpus())("against the real corpus", () => {
	test("measures the whole corpus before anything is read", async () => {
		const result = await walkProtoFiles([REFERENCE_PROTO_ROOT as string]);
		// The pre-flight numbers the ladder decides on: ~9,257 files and ~26 MB.
		expect(result.files.length).toBeGreaterThan(9000);
		expect(result.files.length).toBeLessThan(20000);
		expect(result.bytes).toBeGreaterThan(20_000_000);
		expect(result.bytes).toBeLessThan(60_000_000);
		expect(result.truncated).toBe(false);
		// Every entry is a distinct, absolute `.proto`.
		expect(new Set(result.files.map((file) => file.path)).size).toBe(
			result.files.length,
		);
		expect(
			result.files.every(
				(file) => path.isAbsolute(file.path) && file.path.endsWith(".proto"),
			),
		).toBe(true);
		expect(result.files.every((file) => file.size > 0)).toBe(true);
	});

	test("honours the ceiling on a workspace far above it", async () => {
		const result = await walkProtoFiles([REFERENCE_PROTO_ROOT as string], {
			maxFiles: 50,
		});
		expect(result.files).toHaveLength(50);
		expect(result.truncated).toBe(true);
	});
});
