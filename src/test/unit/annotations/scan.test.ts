/**
 * Tests for the fs-based annotation scanner.
 *
 * This is the module that reads the buf module cache, where every `mcp.v1`,
 * `cache.v1` and `store.v1` option actually lives. It exists because the old
 * implementation opened one `vscode.TextDocument` per proto, which is what grew
 * the editor to 60 GB on a 9,280-file workspace; so the things worth pinning
 * are its bounds rather than its happy path. A scan that ignores `maxFiles` or
 * `isCancelled` does not fail loudly, it just takes the host down with it.
 *
 * The tree walk runs against real directories under `os.tmpdir()` — a mocked fs
 * would pin the mock, not the walk — and every one is removed afterwards.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import {
	bufCacheRoots,
	listProtoFiles,
	scanRootsInto,
	toImportPath,
} from "../../../annotations/scan";
import {
	BUF_CACHE_ROOT,
	hasReferenceCorpus,
	REFERENCE_PROTO_ROOT,
	syntheticPath,
} from "../support/fixtures";

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
function tree(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-scan-"));
	temporaryRoots.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}
	return root;
}

/** A minimal annotation-bearing proto, parameterised by package and name. */
function proto(packageName: string, name: string, number: number): string {
	return `syntax = "proto3";
package ${packageName};

import "google/protobuf/descriptor.proto";

extend google.protobuf.MessageOptions {
  // ${name} does something.
  ${name}Options ${name} = ${number};
}

message ${name}Options {
  bool enabled = 1;
}
`;
}

/** Paths relative to a root, forward-slashed and sorted, for stable compares. */
function relativeTo(root: string, files: readonly string[]): string[] {
	return files.map((file) => toImportPath(root, file)).sort();
}

describe("listProtoFiles", () => {
	test("finds every .proto at any depth", async () => {
		const root = tree({
			"top.proto": "",
			"a/one.proto": "",
			"a/b/c/deep.proto": "",
		});
		expect(relativeTo(root, await listProtoFiles(root))).toEqual([
			"a/b/c/deep.proto",
			"a/one.proto",
			"top.proto",
		]);
	});

	test("ignores files that are not protos", async () => {
		const root = tree({
			"keep.proto": "",
			"README.md": "",
			proto: "",
			"notes.proto.bak": "",
			".hidden.proto": "",
		});
		expect(relativeTo(root, await listProtoFiles(root))).toEqual([
			".hidden.proto",
			"keep.proto",
		]);
	});

	test("does not walk build output or vendored trees", async () => {
		const root = tree({
			"keep.proto": "",
			"node_modules/pkg/skip.proto": "",
			".git/skip.proto": "",
			"out/skip.proto": "",
			"dist/skip.proto": "",
			"build/skip.proto": "",
			"vendor/skip.proto": "",
			".vscode-test/skip.proto": "",
		});
		expect(relativeTo(root, await listProtoFiles(root))).toEqual([
			"keep.proto",
		]);
	});

	test("stops at the limit", async () => {
		const root = tree({
			"a.proto": "",
			"b.proto": "",
			"c.proto": "",
			"d/e.proto": "",
		});
		expect(await listProtoFiles(root, 2)).toHaveLength(2);
		expect(await listProtoFiles(root, 4)).toHaveLength(4);
		// Asking for more than there are is not an error.
		expect(await listProtoFiles(root, 99)).toHaveLength(4);
	});

	test("collects nothing for a limit of zero", async () => {
		const root = tree({ "a.proto": "" });
		expect(await listProtoFiles(root, 0)).toEqual([]);
	});

	test("answers empty for a root that is not there", async () => {
		const root = tree({ "a.proto": "" });
		expect(await listProtoFiles(path.join(root, "nope"))).toEqual([]);
		expect(await listProtoFiles(path.join(root, "a.proto"))).toEqual([]);
	});

	test("answers empty for a root holding no protos", async () => {
		expect(await listProtoFiles(tree({ "notes.md": "" }))).toEqual([]);
	});
});

describe("toImportPath", () => {
	test("makes the path other protos must write in an import", () => {
		const root = syntheticPath("cache", "buf", "files");
		expect(toImportPath(root, path.join(root, "cache", "v1", "a.proto"))).toBe(
			"cache/v1/a.proto",
		);
		expect(toImportPath(root, path.join(root, "top.proto"))).toBe("top.proto");
	});

	test("reports a file outside the root relative to it", () => {
		// Never happens in a scan, but the result must not silently look like a
		// legal import path.
		const root = syntheticPath("a", "b");
		expect(toImportPath(root, syntheticPath("a", "c", "x.proto"))).toBe(
			"../c/x.proto",
		);
	});

	test("is empty when the file is the root", () => {
		const root = syntheticPath("a", "b");
		expect(toImportPath(root, root)).toBe("");
	});
});

describe("bufCacheRoots", () => {
	test("expands org/module/commit into per-commit files roots", async () => {
		const cache = tree({
			"org/mod/aaaa/files/x/v1/a.proto": "",
			"org/mod/bbbb/files/x/v1/a.proto": "",
			"org2/other/cccc/files/y/v1/b.proto": "",
		});
		expect(relativeTo(cache, await bufCacheRoots(cache)).sort()).toEqual([
			"org/mod/aaaa/files",
			"org/mod/bbbb/files",
			"org2/other/cccc/files",
		]);
	});

	test("skips a commit with no unpacked files directory", async () => {
		const cache = tree({
			"org/mod/aaaa/files/a.proto": "",
			"org/mod/bbbb/manifest.txt": "",
			"org/mod/cccc/files": "not a directory",
		});
		expect(relativeTo(cache, await bufCacheRoots(cache))).toEqual([
			"org/mod/aaaa/files",
		]);
	});

	test("ignores stray files at every level of the layout", async () => {
		const cache = tree({
			"lock.json": "",
			"org/notes.txt": "",
			"org/mod/README": "",
			"org/mod/aaaa/files/a.proto": "",
		});
		expect(relativeTo(cache, await bufCacheRoots(cache))).toEqual([
			"org/mod/aaaa/files",
		]);
	});

	test("answers empty for a cache that was never populated", async () => {
		expect(
			await bufCacheRoots(path.join(os.tmpdir(), "gapi-no-such-cache")),
		).toEqual([]);
		expect(await bufCacheRoots(tree({}))).toEqual([]);
	});

	test.skipIf(!hasReferenceCorpus())(
		"reads the real buf module cache",
		async () => {
			const roots = await bufCacheRoots(BUF_CACHE_ROOT);
			expect(roots.length).toBeGreaterThan(0);
			for (const root of roots) {
				expect(path.basename(root)).toBe("files");
				expect(fs.statSync(root).isDirectory()).toBe(true);
			}
		},
	);
});

describe("scanRootsInto", () => {
	test("fills a registry and reports what it did", async () => {
		const a = proto("one.v1", "one", 50001);
		const b = proto("two.v1", "two", 50002);
		const root = tree({ "one/v1/annotations.proto": a, "two/v1/x.proto": b });
		const registry = new AnnotationRegistryImpl();
		const result = await scanRootsInto([root], registry);

		expect(result.roots).toBe(1);
		expect(result.files).toBe(2);
		expect(result.bytes).toBe(a.length + b.length);
		expect(result.truncated).toBe(false);
		expect(result.nextFileId).toBe(2);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(
			registry
				.all()
				.map((annotation) => annotation.fqn)
				.sort(),
		).toEqual(["one.v1.one", "two.v1.two"]);
	});

	test("gives each file the import path a consumer must write", async () => {
		const root = tree({
			"cache/v1/annotations.proto": proto("cache.v1", "cache", 52001),
		});
		const registry = new AnnotationRegistryImpl();
		await scanRootsInto([root], registry);
		const descriptor = registry.get("cache.v1.cache");
		if (!descriptor) {
			throw new Error("scan found no cache.v1.cache");
		}
		expect(descriptor.importPath).toBe("cache/v1/annotations.proto");
		const site = registry.siteOf(descriptor);
		expect(site?.path).toBe(path.join(root, "cache/v1/annotations.proto"));
		expect(site?.packageName).toBe("cache.v1");
		expect(registry.importsOf("cache/v1/annotations.proto")).toEqual([
			"google/protobuf/descriptor.proto",
		]);
	});

	test("adds to a registry rather than replacing what it holds", async () => {
		const first = tree({ "a.proto": proto("one.v1", "one", 1) });
		const second = tree({ "b.proto": proto("two.v1", "two", 2) });
		const registry = new AnnotationRegistryImpl();
		await scanRootsInto([first], registry);
		await scanRootsInto([second], registry, { startFileId: 1 });
		expect(registry.all()).toHaveLength(2);
	});

	test("chains file ids across scans", async () => {
		const root = tree({ "a.proto": "", "b.proto": "", "c.proto": "" });
		const registry = new AnnotationRegistryImpl();
		const first = await scanRootsInto([root], registry, { maxFiles: 2 });
		expect(first.nextFileId).toBe(2);

		const second = tree({ "d.proto": "" });
		const next = await scanRootsInto([second], registry, {
			startFileId: first.nextFileId,
		});
		expect(next.nextFileId).toBe(3);
		// Ids never collide, so the earlier scan's origins survive.
		expect(registry.origin(0)).toBeDefined();
		expect(registry.origin(1)).toBeDefined();
		expect(registry.origin(2)?.importPath).toBe("d.proto");
	});

	test("counts only the roots it could actually walk", async () => {
		const good = tree({ "a.proto": proto("one.v1", "one", 1) });
		const asFile = path.join(good, "a.proto");
		const result = await scanRootsInto(
			[good, path.join(good, "missing"), asFile],
			new AnnotationRegistryImpl(),
		);
		expect(result.roots).toBe(1);
		expect(result.files).toBe(1);
	});

	test("walks several roots into one registry", async () => {
		const first = tree({ "x/v1/a.proto": proto("x.v1", "x", 1) });
		const second = tree({ "y/v1/b.proto": proto("y.v1", "y", 2) });
		const registry = new AnnotationRegistryImpl();
		const result = await scanRootsInto([first, second], registry);
		expect(result.roots).toBe(2);
		expect(result.files).toBe(2);
		// Each root is its own import root, so both paths start at their own root.
		expect(registry.get("x.v1.x")?.importPath).toBe("x/v1/a.proto");
		expect(registry.get("y.v1.y")?.importPath).toBe("y/v1/b.proto");
	});

	test("stops at maxFiles and says so", async () => {
		const root = tree({
			"a.proto": "",
			"b.proto": "",
			"c.proto": "",
			"d.proto": "",
			"e.proto": "",
		});
		const result = await scanRootsInto([root], new AnnotationRegistryImpl(), {
			maxFiles: 3,
		});
		expect(result.files).toBe(3);
		expect(result.truncated).toBe(true);
		expect(result.nextFileId).toBe(3);
	});

	test("reports truncation at exactly the ceiling", async () => {
		// The walk stops collecting at the limit, so it cannot know whether the
		// directory held one more. Reporting truncation here is the conservative
		// answer, not an off-by-one.
		const root = tree({ "a.proto": "", "b.proto": "" });
		const exact = await scanRootsInto([root], new AnnotationRegistryImpl(), {
			maxFiles: 2,
		});
		expect(exact.files).toBe(2);
		expect(exact.truncated).toBe(true);

		const room = await scanRootsInto([root], new AnnotationRegistryImpl(), {
			maxFiles: 3,
		});
		expect(room.files).toBe(2);
		expect(room.truncated).toBe(false);
	});

	test("spreads one ceiling across every root", async () => {
		const first = tree({ "a.proto": "", "b.proto": "" });
		const second = tree({ "c.proto": "", "d.proto": "" });
		const result = await scanRootsInto(
			[first, second],
			new AnnotationRegistryImpl(),
			{ maxFiles: 3 },
		);
		expect(result.files).toBe(3);
		expect(result.truncated).toBe(true);
		// The second root was reached, so it counts even though it was cut short.
		expect(result.roots).toBe(2);
	});

	test("reads nothing at all for a ceiling of zero", async () => {
		const root = tree({ "a.proto": proto("one.v1", "one", 1) });
		const registry = new AnnotationRegistryImpl();
		const result = await scanRootsInto([root], registry, { maxFiles: 0 });
		expect(result.files).toBe(0);
		expect(result.truncated).toBe(true);
		expect(registry.all()).toEqual([]);
	});

	test("aborts before the first read when cancelled up front", async () => {
		const root = tree({ "a.proto": proto("one.v1", "one", 1) });
		const registry = new AnnotationRegistryImpl();
		const result = await scanRootsInto([root], registry, {
			isCancelled: () => true,
		});
		expect(result.roots).toBe(0);
		expect(result.files).toBe(0);
		expect(registry.all()).toEqual([]);
	});

	test("stops between batches once cancellation is asked for", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 10; i++) {
			files[`f${i}.proto`] = "";
		}
		const root = tree(files);
		const registry = new AnnotationRegistryImpl();
		let calls = 0;
		const result = await scanRootsInto([root], registry, {
			concurrency: 2,
			// Checked once per root and once per batch, so the first two calls
			// admit one batch of two and the third stops the scan.
			isCancelled: () => ++calls > 2,
		});
		expect(result.files).toBe(2);
		expect(result.files).toBeLessThan(10);
		expect(result.nextFileId).toBe(2);
		// Cancellation is not truncation: the caller asked, the ceiling did not.
		expect(result.truncated).toBe(false);
	});

	test("reads the same files whatever the concurrency", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 20; i++) {
			files[`pkg${i}/a.proto`] = proto(`p${i}.v1`, `opt${i}`, 50000 + i);
		}
		const root = tree(files);
		const serial = new AnnotationRegistryImpl();
		const parallel = new AnnotationRegistryImpl();
		const one = await scanRootsInto([root], serial, { concurrency: 1 });
		const many = await scanRootsInto([root], parallel, { concurrency: 64 });
		expect(one.files).toBe(20);
		expect(many.files).toBe(one.files);
		expect(
			parallel
				.all()
				.map((a) => a.fqn)
				.sort(),
		).toEqual(
			serial
				.all()
				.map((a) => a.fqn)
				.sort(),
		);
	});

	test("treats a concurrency below one as one", async () => {
		const root = tree({ "a.proto": "", "b.proto": "" });
		const result = await scanRootsInto([root], new AnnotationRegistryImpl(), {
			concurrency: 0,
		});
		expect(result.files).toBe(2);
	});

	test("does nothing for an empty root list", async () => {
		const result = await scanRootsInto([], new AnnotationRegistryImpl());
		expect(result).toMatchObject({
			roots: 0,
			files: 0,
			bytes: 0,
			nextFileId: 0,
			truncated: false,
		});
	});

	test("skips a file it cannot read and keeps going", async () => {
		if (process.getuid?.() === 0) {
			// root reads anything, so the unreadable case cannot be staged.
			return;
		}
		const root = tree({
			"readable.proto": proto("ok.v1", "ok", 1),
			"locked.proto": proto("locked.v1", "locked", 2),
		});
		fs.chmodSync(path.join(root, "locked.proto"), 0o000);
		const registry = new AnnotationRegistryImpl();
		const result = await scanRootsInto([root], registry);
		// The unreadable file still consumed its place in the listing, but
		// contributed no descriptors and no bytes.
		expect(result.files).toBe(1);
		expect(registry.all().map((a) => a.fqn)).toEqual(["ok.v1.ok"]);
	});

	test("ingests a file whose text is not a valid proto", async () => {
		const root = tree({
			"broken.proto": "this is not proto at all {{{",
			"good.proto": proto("ok.v1", "ok", 1),
		});
		const registry = new AnnotationRegistryImpl();
		const result = await scanRootsInto([root], registry);
		expect(result.files).toBe(2);
		expect(registry.all().map((a) => a.fqn)).toEqual(["ok.v1.ok"]);
		// A file that declares nothing is still a file the registry has seen.
		expect(registry.origin(0)).toBeDefined();
		expect(registry.origin(1)).toBeDefined();
	});

	test("counts characters read, including multi-byte ones", async () => {
		const text = "// Répertoire ✓\n";
		const root = tree({ "a.proto": text });
		const result = await scanRootsInto([root], new AnnotationRegistryImpl());
		expect(result.bytes).toBe(text.length);
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"scans the reference tree and the buf cache into one registry",
		async () => {
			if (!REFERENCE_PROTO_ROOT) {
				throw new Error("guarded by hasReferenceCorpus");
			}
			const registry = new AnnotationRegistryImpl();
			const roots = [
				REFERENCE_PROTO_ROOT,
				...(await bufCacheRoots(BUF_CACHE_ROOT)),
			];
			const result = await scanRootsInto(roots, registry, { maxFiles: 30000 });
			expect(result.roots).toBe(roots.length);
			expect(result.files).toBeGreaterThan(1000);
			expect(result.truncated).toBe(false);
			expect(result.nextFileId).toBe(result.files);
			expect(result.bytes).toBeGreaterThan(result.files);
			expect(registry.all().length).toBeGreaterThan(30);
			// Descriptors come from the buf cache roots as well as the workspace,
			// which is the whole reason the scanner exists.
			expect(registry.namespaces().length).toBeGreaterThanOrEqual(8);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"honours a ceiling well below the real file count",
		async () => {
			if (!REFERENCE_PROTO_ROOT) {
				throw new Error("guarded by hasReferenceCorpus");
			}
			const registry = new AnnotationRegistryImpl();
			const result = await scanRootsInto([REFERENCE_PROTO_ROOT], registry, {
				maxFiles: 50,
			});
			expect(result.files).toBe(50);
			expect(result.truncated).toBe(true);
		},
	);
});
