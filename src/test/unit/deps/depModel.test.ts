/**
 * Tests for the dependency model.
 *
 * The model's whole job is to say where each dependency stands relative to what
 * the workspace declares, and every one of those states is a statement about
 * the filesystem: declared and unpacked, declared and absent, or unpacked and
 * declared by nobody. So the trees here are real directories rather than a
 * mocked `fs`, exactly as the module graph's own tests are.
 *
 * The graph is injected instead of discovered. `buildDependencyModel` takes one
 * for callers that already hold it, and using that hook keeps these tests off
 * the extension host's globber — what is being tested is the mapping from a
 * graph plus a cache onto the wire shape, not discovery, which the module graph
 * tests already cover.
 *
 * `cacheRoot` is always passed. Letting it default would point the scan at the
 * developer's own `~/.cache/buf`, which is neither hermetic nor small.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildDependencyModel,
	countProtoFiles,
	invalidateDepCaches,
	scanModuleCache,
	splitModuleRef,
} from "../../../deps/depModel";
import type {
	BufDependency,
	ModuleGraph,
	ProtoModule,
} from "../../../index/types";

const tempRoots: string[] = [];

/** A real directory tree, described as relative path → file contents. */
function makeTree(files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "dep-model-")),
	);
	tempRoots.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}
	return root;
}

/**
 * An unpacked buf module cache. `files/` is the directory buf extracts a
 * module's protos into and the only part anything ever points at.
 */
function makeCache(modules: Record<string, Record<string, string[]>>): {
	root: string;
	filesFor: (name: string, commit: string) => string;
} {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "dep-cache-")),
	);
	tempRoots.push(root);
	const filesFor = (name: string, commit: string): string =>
		path.join(root, ...name.split("/"), commit, "files");
	for (const [name, commits] of Object.entries(modules)) {
		for (const [commit, protos] of Object.entries(commits)) {
			const files = filesFor(name, commit);
			fs.mkdirSync(files, { recursive: true });
			for (const proto of protos) {
				const full = path.join(files, proto);
				fs.mkdirSync(path.dirname(full), { recursive: true });
				fs.writeFileSync(full, 'syntax = "proto3";\n');
			}
		}
	}
	return { root, filesFor };
}

/** An empty cache directory, for the many tests that declare nothing cached. */
function emptyCache(): string {
	return makeCache({}).root;
}

/** A `ModuleGraph` over a fixed list of modules. */
function graphOf(modules: readonly ProtoModule[]): ModuleGraph {
	return {
		modules: () => modules,
		forFile: () => undefined,
		protoPathsFor: () => [],
	};
}

/** A module rooted at `root`, with the given dependencies. */
function moduleAt(
	root: string,
	deps: readonly BufDependency[] = [],
	name?: string,
): ProtoModule {
	return { root, roots: [root], deps, name };
}

beforeEach(() => {
	invalidateDepCaches();
});

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * splitModuleRef
 * ------------------------------------------------------------------ */

describe("splitModuleRef", () => {
	test("splits a full reference", () => {
		expect(splitModuleRef("buf.build/googleapis/googleapis")).toEqual({
			remote: "buf.build",
			owner: "googleapis",
			module: "googleapis",
		});
	});

	test("degrades on a reference that is still being typed", () => {
		expect(splitModuleRef("buf.build/googleapis")).toEqual({
			remote: "",
			owner: "buf.build",
			module: "googleapis",
		});
		expect(splitModuleRef("googleapis")).toEqual({
			remote: "",
			owner: "",
			module: "googleapis",
		});
		expect(splitModuleRef("")).toEqual({ remote: "", owner: "", module: "" });
	});

	test("ignores empty segments from stray slashes", () => {
		expect(splitModuleRef("buf.build//acme/core/")).toEqual({
			remote: "buf.build",
			owner: "acme",
			module: "core",
		});
	});
});

/* ------------------------------------------------------------------ *
 * countProtoFiles
 * ------------------------------------------------------------------ */

describe("countProtoFiles", () => {
	test("counts nested protos and nothing else", async () => {
		const root = makeTree({
			"a.proto": "",
			"nested/b.proto": "",
			"nested/deep/c.proto": "",
			"nested/README.md": "",
			"d.protobuf": "",
		});
		expect(await countProtoFiles(root)).toBe(3);
	});

	test("reports an unreadable directory as empty rather than throwing", async () => {
		expect(
			await countProtoFiles(path.join(os.tmpdir(), "no-such-dir-xyz")),
		).toBe(0);
	});

	test("stops at the depth limit", async () => {
		const root = makeTree({
			"a.proto": "",
			"one/b.proto": "",
			"one/two/c.proto": "",
		});
		expect(await countProtoFiles(root, { maxDepth: 0 })).toBe(1);
		expect(await countProtoFiles(root, { maxDepth: 1 })).toBe(2);
		expect(await countProtoFiles(root, { maxDepth: 9 })).toBe(3);
	});

	test("stops at the file ceiling", async () => {
		const root = makeTree({
			"a.proto": "",
			"b.proto": "",
			"c.proto": "",
			"d.proto": "",
		});
		expect(await countProtoFiles(root, { maxFiles: 2 })).toBe(2);
	});

	test("returns early when cancelled", async () => {
		const root = makeTree({ "a.proto": "", "b.proto": "" });
		expect(await countProtoFiles(root, { isCancelled: () => true })).toBe(0);
	});
});

/* ------------------------------------------------------------------ *
 * scanModuleCache
 * ------------------------------------------------------------------ */

describe("scanModuleCache", () => {
	test("rebuilds module references from the directory layout", async () => {
		const cache = makeCache({
			"buf.build/acme/core": { c1: ["a.proto"] },
			"buf.build/googleapis/googleapis": { c2: ["google/api/http.proto"] },
		});
		const found = await scanModuleCache(cache.root);
		expect(found).toEqual([
			{
				name: "buf.build/acme/core",
				commit: "c1",
				cachePath: cache.filesFor("buf.build/acme/core", "c1"),
			},
			{
				name: "buf.build/googleapis/googleapis",
				commit: "c2",
				cachePath: cache.filesFor("buf.build/googleapis/googleapis", "c2"),
			},
		]);
	});

	test("picks the most recently unpacked commit", async () => {
		const cache = makeCache({
			"buf.build/acme/core": { old: ["a.proto"], fresh: ["a.proto"] },
		});
		const fresh = cache.filesFor("buf.build/acme/core", "fresh");
		const later = Date.now() / 1000 + 60;
		fs.utimesSync(fresh, later, later);

		const found = await scanModuleCache(cache.root);
		expect(found).toHaveLength(1);
		expect(found[0]?.commit).toBe("fresh");
	});

	test("skips a commit that was downloaded but never unpacked", async () => {
		const cache = makeCache({ "buf.build/acme/core": { c1: [] } });
		fs.mkdirSync(path.join(cache.root, "buf.build/acme/core/c2"), {
			recursive: true,
		});
		const found = await scanModuleCache(cache.root);
		expect(found.map((m) => m.commit)).toEqual(["c1"]);
	});

	test("returns nothing for a missing or empty cache", async () => {
		expect(
			await scanModuleCache(path.join(os.tmpdir(), "no-cache-xyz")),
		).toEqual([]);
		expect(await scanModuleCache(emptyCache())).toEqual([]);
	});

	test("honours the ceiling and the cancellation hook", async () => {
		const cache = makeCache({
			"buf.build/acme/one": { c: [] },
			"buf.build/acme/two": { c: [] },
		});
		expect(await scanModuleCache(cache.root, { maxModules: 1 })).toHaveLength(
			1,
		);
		expect(
			await scanModuleCache(cache.root, { isCancelled: () => true }),
		).toEqual([]);
	});
});

/* ------------------------------------------------------------------ *
 * buildDependencyModel
 * ------------------------------------------------------------------ */

describe("buildDependencyModel", () => {
	test("finds a template that does not sit beside a buf.yaml", async () => {
		// The layout this exists for: modules under proto/, the template at the
		// repository root. Looking only in module roots found nothing, which is
		// why Generate came up empty on workspaces that plainly had one.
		const repo = makeTree({
			"buf.gen.yaml":
				"version: v2\nplugins:\n  - remote: buf.build/protocolbuffers/plugins/go\n    out: gen/go\n",
			"proto/buf.yaml": "version: v2\n",
		});
		const moduleRoot = path.join(repo, "proto");

		const without = await buildDependencyModel({
			cacheRoot: makeCache({}).root,
			graph: graphOf([moduleAt(moduleRoot, [])]),
		});
		expect(without.gen).toHaveLength(0);

		const withRoot = await buildDependencyModel({
			cacheRoot: makeCache({}).root,
			graph: graphOf([moduleAt(moduleRoot, [])]),
			extraGenDirs: [repo],
		});
		expect(withRoot.gen).toHaveLength(1);
		expect(withRoot.gen[0]?.plugins[0]?.out).toBe("gen/go");
	});

	test("marks a cached dependency declared and counts its protos", async () => {
		const cache = makeCache({
			"buf.build/googleapis/googleapis": {
				c1: ["google/api/http.proto", "google/api/annotations.proto"],
			},
		});
		const root = makeTree({
			"buf.yaml": "version: v2\ndeps:\n  - buf.build/googleapis/googleapis\n",
		});
		const cachePath = cache.filesFor("buf.build/googleapis/googleapis", "c1");
		const model = await buildDependencyModel({
			cacheRoot: cache.root,
			graph: graphOf([
				moduleAt(root, [
					{
						name: "buf.build/googleapis/googleapis",
						commit: "c1",
						cachePath,
					},
				]),
			]),
		});

		expect(model.error).toBeUndefined();
		expect(model.updatesChecked).toBe(false);
		expect(model.modules).toHaveLength(1);
		expect(model.modules[0]?.root).toBe(root);
		expect(model.modules[0]?.deps[0]).toEqual({
			name: "buf.build/googleapis/googleapis",
			remote: "buf.build",
			owner: "googleapis",
			module: "googleapis",
			commit: "c1",
			cachePath,
			protoCount: 2,
			declaredIn: path.join(root, "buf.yaml"),
			state: "declared",
		});
		// Everything cached is declared, so nothing is left over.
		expect(model.undeclared).toEqual([]);
	});

	test("marks a declared dependency missing when it is not unpacked", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\ndeps:\n  - buf.build/acme/core\n",
		});
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([
				moduleAt(root, [{ name: "buf.build/acme/core", commit: "c1" }]),
			]),
		});
		expect(model.modules[0]?.deps[0]).toMatchObject({
			state: "missing",
			cachePath: undefined,
			protoCount: undefined,
			commit: "c1",
		});
	});

	test("reports a cached module no manifest declares", async () => {
		const cache = makeCache({
			"buf.build/acme/declared": { c1: ["a.proto"] },
			"buf.build/acme/stray": { c2: ["b.proto", "c.proto"] },
		});
		const root = makeTree({ "buf.yaml": "version: v2\n" });
		const model = await buildDependencyModel({
			cacheRoot: cache.root,
			graph: graphOf([
				moduleAt(root, [
					{
						name: "buf.build/acme/declared",
						commit: "c1",
						cachePath: cache.filesFor("buf.build/acme/declared", "c1"),
					},
				]),
			]),
		});
		expect(model.undeclared).toEqual([
			{
				name: "buf.build/acme/stray",
				remote: "buf.build",
				owner: "acme",
				module: "stray",
				commit: "c2",
				cachePath: cache.filesFor("buf.build/acme/stray", "c2"),
				protoCount: 2,
				state: "cached",
			},
		]);
	});

	test("groups module roots under the manifest that declares them", async () => {
		// A v2 buf.yaml can declare several module roots but carries one deps
		// list, so the model shows one row for the manifest rather than repeating
		// the same dependencies per root.
		const root = makeTree({
			"buf.yaml": "version: v2\ndeps:\n  - buf.build/acme/core\n",
			"first/a.proto": "",
			"second/b.proto": "",
		});
		const dep: BufDependency = { name: "buf.build/acme/core", commit: "c1" };
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([
				moduleAt(path.join(root, "first"), [dep], "buf.build/acme/first"),
				moduleAt(path.join(root, "second"), [dep], "buf.build/acme/second"),
			]),
		});
		expect(model.modules).toHaveLength(1);
		expect(model.modules[0]?.root).toBe(root);
		expect(model.modules[0]?.name).toBe("buf.build/acme/first");
		expect(model.modules[0]?.deps).toHaveLength(1);
	});

	test("falls back to the module root when no buf.yaml sits above it", async () => {
		const root = makeTree({ "a.proto": "" });
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([
				moduleAt(root, [{ name: "buf.build/acme/core", commit: "" }]),
			]),
		});
		expect(model.modules[0]?.root).toBe(root);
		expect(model.modules[0]?.deps[0]?.declaredIn).toBeUndefined();
	});

	test("keeps separate manifests as separate rows, ordered by path", async () => {
		const root = makeTree({
			"z/buf.yaml": "version: v1\n",
			"a/buf.yaml": "version: v1\n",
		});
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([
				moduleAt(path.join(root, "z")),
				moduleAt(path.join(root, "a")),
			]),
		});
		expect(model.modules.map((m) => m.root)).toEqual([
			path.join(root, "a"),
			path.join(root, "z"),
		]);
	});

	test("attaches every buf.gen.yaml beside a module", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: proto\n",
			"buf.gen.yaml": "version: v2\nplugins:\n  - remote: buf.build/x/go\n",
			"proto/buf.gen.local.yaml": "version: v1\nplugins:\n  - name: go\n",
		});
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([moduleAt(path.join(root, "proto"))]),
		});
		expect(model.gen.map((g) => g.path)).toEqual([
			path.join(root, "buf.gen.yaml"),
			path.join(root, "proto", "buf.gen.local.yaml"),
		]);
		expect(model.gen[0]?.plugins[0]?.kind).toBe("remote");
	});

	test("deduplicates a dependency declared twice in one manifest", async () => {
		const root = makeTree({ "buf.yaml": "version: v2\n" });
		const dep: BufDependency = { name: "buf.build/acme/core", commit: "c1" };
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([moduleAt(root, [dep, dep])]),
		});
		expect(model.modules[0]?.deps).toHaveLength(1);
	});

	test("reports a failure as an error rather than throwing", async () => {
		const broken: ModuleGraph = {
			modules: () => {
				throw new Error("graph exploded");
			},
			forFile: () => undefined,
			protoPathsFor: () => [],
		};
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: broken,
		});
		expect(model).toEqual({
			modules: [],
			gen: [],
			undeclared: [],
			updatesChecked: false,
			error: "graph exploded",
		});
	});

	test("returns an empty model for a workspace with no modules", async () => {
		const model = await buildDependencyModel({
			cacheRoot: emptyCache(),
			graph: graphOf([]),
		});
		expect(model).toEqual({
			modules: [],
			gen: [],
			undeclared: [],
			updatesChecked: false,
		});
	});
});
