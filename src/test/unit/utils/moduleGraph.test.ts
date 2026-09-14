/**
 * Tests for the buf module graph.
 *
 * This replaced the scheme that broke on real repositories: one `buf.yaml`
 * (the workspace root's, or the shortest path found), every nested module and
 * every `buf.work.yaml` ignored, and dependencies resolved by shelling out to
 * `buf export` — which compiles the module and therefore returns nothing the
 * moment the workspace has a compile error, i.e. exactly when a linter is
 * wanted. The replacement reads every manifest, resolves a file to the module
 * with the longest matching root, and maps `buf.lock` entries straight onto
 * `<cache>/v3/modules/b5/<name>/<commit>/files`.
 *
 * The tests therefore build real directory trees rather than mocking `fs`: the
 * behaviour under test is almost entirely about what is and is not on disk.
 * `BUF_CACHE_DIR` is redirected at a temporary cache so dependency resolution
 * is hermetic, and `PATH` is emptied for the whole file so the background
 * `buf dep graph` warm cannot spawn a real subprocess.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getBufModuleCacheRoot,
	getModuleGraph,
	invalidateModuleGraphCache,
	parseBufWorkYaml,
	parseBufYaml,
} from "../../../utils/moduleGraph";
import { EXTENSION_ROOT, hasReferenceCorpus } from "../support/fixtures";
import { Uri, workspace } from "../support/vscode";

/* ------------------------------------------------------------------ *
 * Scaffolding
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

/** A real directory tree, described as relative path → file contents. */
function makeTree(files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "module-graph-")),
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
 * An unpacked module in a temporary buf cache, and the `BUF_CACHE_DIR` that
 * finds it. `files/` is the directory buf unpacks the module's protos into and
 * the only part the graph ever points `--proto-path` at.
 */
function makeCache(modules: Record<string, string[]>): {
	dir: string;
	filesFor: (name: string, commit: string) => string;
} {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "buf-cache-")),
	);
	tempRoots.push(dir);
	const filesFor = (name: string, commit: string): string =>
		path.join(dir, "v3", "modules", "b5", ...name.split("/"), commit, "files");
	for (const [name, commits] of Object.entries(modules)) {
		for (const commit of commits) {
			fs.mkdirSync(filesFor(name, commit), { recursive: true });
		}
	}
	return { dir, filesFor };
}

const originalWorkspaceFolders = workspace.workspaceFolders;
const originalFindFiles = workspace.findFiles;
const originalGetWorkspaceFolder = workspace.getWorkspaceFolder;
const originalEnv = { ...process.env };

/**
 * Sets or clears an environment variable.
 *
 * `process.env.X = undefined` does not clear X: node coerces the value to the
 * string "undefined", so the variable stays set and every later read sees that
 * literal. Clearing needs `delete`.
 */
function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

/** Directories the extension host's own glob never descends into. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"out",
	"dist",
	"build",
	".vscode-test",
]);

/**
 * Point the stub workspace at `root` with a `findFiles` that walks it for
 * real. The include glob is ignored — the only caller asks for buf manifests,
 * and matching basenames is closer to what the host returns than a
 * half-implemented globber would be.
 */
function useWorkspace(root: string): void {
	workspace.workspaceFolders = [{ uri: Uri.file(root), name: "w", index: 0 }];
	workspace.getWorkspaceFolder = (uri: Uri) =>
		uri.fsPath.startsWith(root) ? { uri: Uri.file(root) } : undefined;
	workspace.findFiles = async (
		_include: string,
		_exclude?: string,
		maxResults?: number,
	): Promise<Uri[]> => {
		const found: Uri[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					if (!SKIP_DIRS.has(entry.name)) {
						walk(path.join(dir, entry.name));
					}
				} else if (
					entry.name === "buf.yaml" ||
					entry.name === "buf.work.yaml"
				) {
					found.push(Uri.file(path.join(dir, entry.name)));
				}
			}
		};
		walk(root);
		return maxResults ? found.slice(0, maxResults) : found;
	};
}

beforeAll(() => {
	// The graph fires off `buf dep graph` in the background whenever a declared
	// dependency is missing from the cache. An unresolvable PATH turns that into
	// a logged spawn error instead of a real subprocess touching the network.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));
	tempRoots.push(empty);
	process.env.PATH = empty;
});

beforeEach(() => {
	invalidateModuleGraphCache();
});

afterEach(() => {
	workspace.workspaceFolders = originalWorkspaceFolders;
	workspace.findFiles = originalFindFiles;
	workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
	setEnv("BUF_CACHE_DIR", originalEnv.BUF_CACHE_DIR);
	setEnv("XDG_CACHE_HOME", originalEnv.XDG_CACHE_HOME);
	// Restored for the same reason as the other two: the cache-root tests clear
	// it to reach the XDG branch, and on Windows leaving it cleared would change
	// what every later test resolves.
	setEnv("LOCALAPPDATA", originalEnv.LOCALAPPDATA);
	invalidateModuleGraphCache();
});

afterAll(() => {
	process.env.PATH = originalEnv.PATH;
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * Manifest parsing
 * ------------------------------------------------------------------ */

/**
 * The config directory these parser tests pass in.
 *
 * Resolved rather than written as a bare POSIX literal, because the parsers
 * resolve what they are given: on Windows that turns into a drive-qualified
 * path, so a literal in the expectation compared a POSIX string against a
 * Windows one and failed there while passing everywhere else. One constant on
 * both sides keeps input and expectation on the same platform by construction.
 */
const REPO = path.resolve("/repo");

describe("parseBufYaml", () => {
	test("roots a v1 module at the config's own directory", () => {
		const parsed = parseBufYaml(
			"version: v1\nname: buf.build/acme/core\ndeps:\n  - buf.build/acme/dep\n",
			REPO,
		);
		expect(parsed.version).toBe("v1");
		expect(parsed.entries).toEqual([
			{ root: REPO, name: "buf.build/acme/core" },
		]);
		expect(parsed.deps).toEqual(["buf.build/acme/dep"]);
	});

	test("gives every v2 modules entry its own root and name", () => {
		const parsed = parseBufYaml(
			`version: v2
modules:
  - path: proto
    name: buf.build/acme/core
  - path: vendor/external
    name: buf.build/acme/vendor
  - path: .
`,
			REPO,
		);
		expect(parsed.version).toBe("v2");
		expect(parsed.entries).toEqual([
			{ root: path.join(REPO, "proto"), name: "buf.build/acme/core" },
			{
				root: path.join(REPO, "vendor", "external"),
				name: "buf.build/acme/vendor",
			},
			{ root: REPO, name: undefined },
		]);
	});

	test("treats a modules entry with no path as the config's directory", () => {
		const parsed = parseBufYaml("version: v2\nmodules:\n  - name: n\n", REPO);
		expect(parsed.entries).toEqual([{ root: REPO, name: "n" }]);
	});

	test("reads v1beta1 build roots", () => {
		const parsed = parseBufYaml(
			"version: v1beta1\nbuild:\n  roots:\n    - proto\n    - vendor\n",
			REPO,
		);
		expect(parsed.entries.map((e) => e.root)).toEqual([
			path.join(REPO, "proto"),
			path.join(REPO, "vendor"),
		]);
	});

	test("lets a top-level name fill in for unnamed entries only", () => {
		const parsed = parseBufYaml(
			`version: v2
name: buf.build/acme/default
modules:
  - path: a
  - path: b
    name: buf.build/acme/b
`,
			REPO,
		);
		expect(parsed.entries).toEqual([
			{ root: path.join(REPO, "a"), name: "buf.build/acme/default" },
			{ root: path.join(REPO, "b"), name: "buf.build/acme/b" },
		]);
	});

	test("falls back to one entry when modules is empty or all malformed", () => {
		expect(parseBufYaml("version: v2\nmodules: []\n", REPO).entries).toEqual([
			{ root: REPO, name: undefined },
		]);
		expect(
			parseBufYaml("version: v2\nmodules:\n  - 7\n  - null\n", REPO).entries,
		).toEqual([{ root: REPO, name: undefined }]);
	});

	test("assumes v1 when the version is missing or not a string", () => {
		expect(parseBufYaml("name: x\n", REPO).version).toBe("v1");
		expect(parseBufYaml("version: 2\n", REPO).version).toBe("v1");
	});

	test("degrades to a single root when the YAML is malformed", () => {
		const parsed = parseBufYaml("version: v2\nmodules: [ : : :\n", REPO);
		expect(parsed.version).toBe("v1");
		expect(parsed.entries).toEqual([{ root: REPO, name: undefined }]);
		expect(parsed.deps).toEqual([]);
	});

	test("degrades for a document that is not a mapping", () => {
		expect(parseBufYaml("- a\n- b\n", REPO).entries).toEqual([
			{ root: REPO, name: undefined },
		]);
		expect(parseBufYaml("", REPO).entries).toEqual([
			{ root: REPO, name: undefined },
		]);
	});

	test("keeps only string deps", () => {
		expect(parseBufYaml("deps:\n  - a\n  - 7\n  - null\n", REPO).deps).toEqual([
			"a",
		]);
		expect(parseBufYaml("deps: nope\n", REPO).deps).toEqual([]);
	});
});

describe("parseBufWorkYaml", () => {
	test("resolves directories against the workspace file's directory", () => {
		expect(
			parseBufWorkYaml(
				"version: v1\ndirectories:\n  - proto\n  - vendor/external\n  - .\n",
				REPO,
			),
		).toEqual([
			path.join(REPO, "proto"),
			path.join(REPO, "vendor", "external"),
			REPO,
		]);
	});

	test("returns nothing for a missing, empty or malformed directories list", () => {
		expect(parseBufWorkYaml("version: v1\n", REPO)).toEqual([]);
		expect(parseBufWorkYaml("directories: []\n", REPO)).toEqual([]);
		expect(parseBufWorkYaml("directories: [ : :\n", REPO)).toEqual([]);
		expect(parseBufWorkYaml("", REPO)).toEqual([]);
	});

	test("keeps only string entries", () => {
		expect(parseBufWorkYaml("directories:\n  - proto\n  - 7\n", REPO)).toEqual([
			path.join(REPO, "proto"),
		]);
	});
});

/* ------------------------------------------------------------------ *
 * Cache root
 * ------------------------------------------------------------------ */

describe("getBufModuleCacheRoot", () => {
	const SEGMENT = path.join("v3", "modules", "b5");

	test("honours BUF_CACHE_DIR above everything else", () => {
		setEnv("BUF_CACHE_DIR", "/tmp/explicit");
		setEnv("XDG_CACHE_HOME", "/tmp/xdg");
		expect(getBufModuleCacheRoot()).toBe(path.join("/tmp/explicit", SEGMENT));
	});

	test("falls back to XDG_CACHE_HOME, then the home directory", () => {
		// `LOCALAPPDATA` outranks both of these, and CI sets it on Windows —
		// so without clearing it this asserted a branch the function never
		// reached there, and only there.
		setEnv("BUF_CACHE_DIR", undefined);
		setEnv("LOCALAPPDATA", undefined);
		setEnv("XDG_CACHE_HOME", "/tmp/xdg");
		expect(getBufModuleCacheRoot()).toBe(path.join("/tmp/xdg", "buf", SEGMENT));

		setEnv("XDG_CACHE_HOME", undefined);
		expect(getBufModuleCacheRoot()).toBe(
			path.join(os.homedir(), ".cache", "buf", SEGMENT),
		);
	});

	test("prefers LOCALAPPDATA on Windows, which is where buf caches there", () => {
		// Asserted on every platform by construction rather than by running on
		// Windows: the branch is what the function does when the variable is
		// set and the platform says win32, and a POSIX-only suite never
		// exercised it at all.
		setEnv("BUF_CACHE_DIR", undefined);
		setEnv("XDG_CACHE_HOME", undefined);
		setEnv("LOCALAPPDATA", path.join("C:", "Users", "dev", "AppData", "Local"));

		const root = getBufModuleCacheRoot();
		if (process.platform === "win32") {
			expect(root).toBe(
				path.join(
					"C:",
					"Users",
					"dev",
					"AppData",
					"Local",
					"buf",
					"cache",
					SEGMENT,
				),
			);
		} else {
			// Elsewhere the variable is meaningless and must be ignored.
			expect(root).toBe(path.join(os.homedir(), ".cache", "buf", SEGMENT));
		}
	});
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

describe("module discovery", () => {
	test("finds one module for a v1 workspace", async () => {
		const root = makeTree({
			"buf.yaml": "version: v1\nname: buf.build/acme/core\n",
			"acme/v1/a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.modules()).toHaveLength(1);
		expect(graph.modules()[0].root).toBe(root);
		expect(graph.modules()[0].roots).toEqual([root]);
		expect(graph.modules()[0].name).toBe("buf.build/acme/core");
	});

	test("makes one module per v2 modules entry", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: one\n  - path: two\n",
			"one/a.proto": "",
			"two/b.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(
			graph
				.modules()
				.map((m) => m.root)
				.sort(),
		).toEqual([path.join(root, "one"), path.join(root, "two")].sort());
		// The config's own directory is not a root when modules are declared.
		expect(graph.forFile(path.join(root, "stray.proto"))).toBeUndefined();
	});

	test("drops a declared module whose directory does not exist", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: real\n  - path: missing\n",
			"real/a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.modules().map((m) => m.root)).toEqual([
			path.join(root, "real"),
		]);
	});

	test("resolves a file to the longest matching module root", async () => {
		// The bug this pins: with nested modules the old code picked the outer
		// one, so a file under a/b compiled against a's roots and a's deps.
		const root = makeTree({
			"a/buf.yaml": "version: v1\nname: buf.build/acme/outer\n",
			"a/outer.proto": "",
			"a/b/buf.yaml": "version: v1\nname: buf.build/acme/inner\n",
			"a/b/inner.proto": "",
			"a/bb/buf.yaml": "version: v1\nname: buf.build/acme/sibling\n",
			"a/bb/sibling.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.forFile(path.join(root, "a/b/inner.proto"))?.name).toBe(
			"buf.build/acme/inner",
		);
		expect(graph.forFile(path.join(root, "a/outer.proto"))?.name).toBe(
			"buf.build/acme/outer",
		);
		// `a/bb` must not be swallowed by the `a/b` prefix.
		expect(graph.forFile(path.join(root, "a/bb/sibling.proto"))?.name).toBe(
			"buf.build/acme/sibling",
		);
		// A file deep under the inner module still belongs to the inner module.
		expect(graph.forFile(path.join(root, "a/b/c/d/deep.proto"))?.name).toBe(
			"buf.build/acme/inner",
		);
	});

	test("scopes protoPathsFor to one module and unions them in allProtoPaths", async () => {
		const root = makeTree({
			"a/buf.yaml": "version: v1\n",
			"a/outer.proto": "",
			"a/b/buf.yaml": "version: v1\n",
			"a/b/inner.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.protoPathsFor(path.join(root, "a/b/inner.proto"))).toEqual([
			path.join(root, "a/b"),
		]);
		expect(graph.protoPathsFor(path.join(root, "a/outer.proto"))).toEqual([
			path.join(root, "a"),
		]);
		expect([...graph.allProtoPaths()].sort()).toEqual(
			[path.join(root, "a"), path.join(root, "a/b")].sort(),
		);
	});

	test("returns nothing for a file under no module", async () => {
		const root = makeTree({
			"mod/buf.yaml": "version: v1\n",
			"mod/a.proto": "",
			"loose/b.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.forFile(path.join(root, "loose/b.proto"))).toBeUndefined();
		expect(graph.protoPathsFor(path.join(root, "loose/b.proto"))).toEqual([]);
	});

	test("treats buf.work.yaml directories as module roots", async () => {
		const root = makeTree({
			"buf.work.yaml": "version: v1\ndirectories:\n  - first\n  - second\n",
			"first/a.proto": "",
			"second/b.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(
			graph
				.modules()
				.map((m) => m.root)
				.sort(),
		).toEqual([path.join(root, "first"), path.join(root, "second")].sort());
		expect(graph.forFile(path.join(root, "first/a.proto"))?.root).toBe(
			path.join(root, "first"),
		);
	});

	test("claims a workspace directory that has its own buf.yaml only once", async () => {
		const root = makeTree({
			"buf.work.yaml": "version: v1\ndirectories:\n  - first\n  - second\n",
			"first/buf.yaml": "version: v1\nname: buf.build/acme/first\n",
			"first/a.proto": "",
			"second/b.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.modules()).toHaveLength(2);
		const first = graph
			.modules()
			.find((m) => m.root === path.join(root, "first"));
		// The buf.yaml wins, so the module keeps its declared name.
		expect(first?.name).toBe("buf.build/acme/first");
	});

	test("skips a workspace directory that does not exist", async () => {
		const root = makeTree({
			"buf.work.yaml": "version: v1\ndirectories:\n  - here\n  - gone\n",
			"here/a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.modules().map((m) => m.root)).toEqual([
			path.join(root, "here"),
		]);
	});

	test("is empty when no workspace folder is open", async () => {
		workspace.workspaceFolders = undefined;
		const graph = await getModuleGraph();
		expect(graph.modules()).toEqual([]);
		expect(graph.allProtoPaths()).toEqual([]);
		expect(graph.primaryConfig()).toBeUndefined();
		expect(graph.configStamps()).toEqual([]);
	});

	test("is empty when discovery throws", async () => {
		const root = makeTree({ "buf.yaml": "version: v1\n" });
		useWorkspace(root);
		workspace.findFiles = async () => {
			throw new Error("host went away");
		};

		const graph = await getModuleGraph();
		expect(graph.modules()).toEqual([]);
	});

	test("prefers the workspace-root buf.yaml as the primary config", async () => {
		const root = makeTree({
			"buf.yaml": "version: v1\n",
			"a.proto": "",
			"deep/nested/buf.yaml": "version: v1\n",
			"deep/nested/b.proto": "",
		});
		useWorkspace(root);

		expect((await getModuleGraph()).primaryConfig()).toBe(
			path.join(root, "buf.yaml"),
		);
	});

	test("falls back to the shortest path when no config sits at the root", async () => {
		const root = makeTree({
			"shallow/buf.yaml": "version: v1\n",
			"shallow/a.proto": "",
			"deep/deeper/deepest/buf.yaml": "version: v1\n",
			"deep/deeper/deepest/b.proto": "",
		});
		useWorkspace(root);

		expect((await getModuleGraph()).primaryConfig()).toBe(
			path.join(root, "shallow/buf.yaml"),
		);
	});

	test("stamps buf.lock alongside buf.yaml so a lock change invalidates", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\n",
			"buf.lock": "version: v2\ndeps: []\n",
			"a.proto": "",
		});
		useWorkspace(root);

		const stamps = (await getModuleGraph()).configStamps();
		expect(stamps.map((s) => s.path)).toEqual([
			path.join(root, "buf.lock"),
			path.join(root, "buf.yaml"),
		]);
		for (const stamp of stamps) {
			expect(stamp.mtimeMs).toBeGreaterThan(0);
		}
	});

	test("attaches the nearest .api-linter.yaml to each module", async () => {
		const root = makeTree({
			".api-linter.yaml": "---\n",
			"buf.yaml": "version: v2\nmodules:\n  - path: plain\n  - path: own\n",
			"plain/a.proto": "",
			"own/.api-linter.yaml": "---\n",
			"own/b.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		const byRoot = new Map(graph.modules().map((m) => [m.root, m]));
		expect(byRoot.get(path.join(root, "own"))?.apiLinterConfig).toBe(
			path.join(root, "own/.api-linter.yaml"),
		);
		// Nothing of its own, so the config governing the buf.yaml applies.
		expect(byRoot.get(path.join(root, "plain"))?.apiLinterConfig).toBe(
			path.join(root, ".api-linter.yaml"),
		);
	});
});

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

describe("dependency resolution", () => {
	const PROTOVALIDATE = "buf.build/bufbuild/protovalidate";
	const GOOGLEAPIS = "buf.build/googleapis/googleapis";

	test("maps every buf.lock entry onto its unpacked cache directory", async () => {
		const cache = makeCache({
			[PROTOVALIDATE]: ["aaaa1111"],
			[GOOGLEAPIS]: ["bbbb2222"],
		});
		process.env.BUF_CACHE_DIR = cache.dir;
		const root = makeTree({
			"buf.yaml": "version: v2\n",
			"buf.lock": `version: v2
deps:
  - name: ${PROTOVALIDATE}
    commit: aaaa1111
    digest: b5:00
  - name: ${GOOGLEAPIS}
    commit: bbbb2222
    digest: b5:01
`,
			"a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.protoPathsFor(path.join(root, "a.proto"))).toEqual([
			root,
			cache.filesFor(PROTOVALIDATE, "aaaa1111"),
			cache.filesFor(GOOGLEAPIS, "bbbb2222"),
		]);
		expect(graph.modules()[0].deps.map((d) => d.name)).toEqual([
			PROTOVALIDATE,
			GOOGLEAPIS,
		]);
	});

	test("understands the v1 lock shape", async () => {
		const cache = makeCache({ [GOOGLEAPIS]: ["cccc3333"] });
		process.env.BUF_CACHE_DIR = cache.dir;
		const root = makeTree({
			"buf.yaml": "version: v1\n",
			"buf.lock": `version: v1
deps:
  - remote: buf.build
    owner: googleapis
    repository: googleapis
    commit: cccc3333
`,
			"a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.protoPathsFor(path.join(root, "a.proto"))).toEqual([
			root,
			cache.filesFor(GOOGLEAPIS, "cccc3333"),
		]);
	});

	test("skips a locked dependency that is not in the cache", async () => {
		const cache = makeCache({ [GOOGLEAPIS]: ["dddd4444"] });
		process.env.BUF_CACHE_DIR = cache.dir;
		const root = makeTree({
			"buf.yaml": "version: v2\n",
			"buf.lock": `version: v2
deps:
  - name: ${GOOGLEAPIS}
    commit: dddd4444
  - name: buf.build/acme/never-fetched
    commit: eeee5555
`,
			"a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		// The uncached dep is still described, but contributes no proto path.
		expect(graph.modules()[0].deps.map((d) => d.cachePath)).toEqual([
			cache.filesFor(GOOGLEAPIS, "dddd4444"),
			undefined,
		]);
		expect(graph.protoPathsFor(path.join(root, "a.proto"))).toEqual([
			root,
			cache.filesFor(GOOGLEAPIS, "dddd4444"),
		]);
	});

	test("falls back to the newest unpacked commit when the lock is stale", async () => {
		const cache = makeCache({ [GOOGLEAPIS]: ["old0000", "new1111"] });
		process.env.BUF_CACHE_DIR = cache.dir;
		const older = new Date(Date.now() - 60_000);
		fs.utimesSync(cache.filesFor(GOOGLEAPIS, "old0000"), older, older);
		const root = makeTree({
			"buf.yaml": "version: v2\n",
			"buf.lock": `version: v2
deps:
  - name: ${GOOGLEAPIS}
    commit: gone9999
`,
			"a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		const dep = graph.modules()[0].deps[0];
		expect(dep.cachePath).toBe(cache.filesFor(GOOGLEAPIS, "new1111"));
		// The lock's own commit is kept when it is written down.
		expect(dep.commit).toBe("gone9999");
	});

	test("ignores a cache entry that was never unpacked", async () => {
		const cache = makeCache({});
		process.env.BUF_CACHE_DIR = cache.dir;
		// A commit directory with no `files/` inside it: a half-finished fetch.
		fs.mkdirSync(
			path.join(cache.dir, "v3/modules/b5", GOOGLEAPIS, "ffff6666"),
			{ recursive: true },
		);
		const root = makeTree({
			"buf.yaml": "version: v2\n",
			"buf.lock": `version: v2\ndeps:\n  - name: ${GOOGLEAPIS}\n    commit: ffff6666\n`,
			"a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.modules()[0].deps[0].cachePath).toBeUndefined();
		expect(graph.protoPathsFor(path.join(root, "a.proto"))).toEqual([root]);
	});

	test("uses buf.yaml deps when there is no lock at all", async () => {
		const cache = makeCache({ [GOOGLEAPIS]: ["7777aaaa"] });
		process.env.BUF_CACHE_DIR = cache.dir;
		const root = makeTree({
			"buf.yaml": `version: v2\ndeps:\n  - ${GOOGLEAPIS}\n`,
			"a.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		// No commit is known, so resolution falls back to the newest unpacked one.
		expect(graph.protoPathsFor(path.join(root, "a.proto"))).toEqual([
			root,
			cache.filesFor(GOOGLEAPIS, "7777aaaa"),
		]);
	});

	test("yields no dependency roots for an empty or malformed lock", async () => {
		const cache = makeCache({ [GOOGLEAPIS]: ["8888bbbb"] });
		process.env.BUF_CACHE_DIR = cache.dir;
		for (const lock of [
			"",
			"version: v2\n",
			"version: v2\ndeps: []\n",
			"deps: [ : :\n",
		]) {
			invalidateModuleGraphCache();
			const root = makeTree({
				"buf.yaml": "version: v2\n",
				"buf.lock": lock,
				"a.proto": "",
			});
			useWorkspace(root);

			const graph = await getModuleGraph();
			expect(graph.modules()[0].deps).toEqual([]);
			expect(graph.protoPathsFor(path.join(root, "a.proto"))).toEqual([root]);
		}
	});

	test("keeps each module's dependencies to itself", async () => {
		const cache = makeCache({
			[PROTOVALIDATE]: ["9999cccc"],
			[GOOGLEAPIS]: ["9999dddd"],
		});
		process.env.BUF_CACHE_DIR = cache.dir;
		const root = makeTree({
			"outer/buf.yaml": "version: v2\n",
			"outer/buf.lock": `version: v2\ndeps:\n  - name: ${PROTOVALIDATE}\n    commit: 9999cccc\n`,
			"outer/a.proto": "",
			"outer/inner/buf.yaml": "version: v2\n",
			"outer/inner/buf.lock": `version: v2\ndeps:\n  - name: ${GOOGLEAPIS}\n    commit: 9999dddd\n`,
			"outer/inner/b.proto": "",
		});
		useWorkspace(root);

		const graph = await getModuleGraph();
		expect(graph.protoPathsFor(path.join(root, "outer/inner/b.proto"))).toEqual(
			[path.join(root, "outer/inner"), cache.filesFor(GOOGLEAPIS, "9999dddd")],
		);
		expect(graph.protoPathsFor(path.join(root, "outer/a.proto"))).toEqual([
			path.join(root, "outer"),
			cache.filesFor(PROTOVALIDATE, "9999cccc"),
		]);
		// The union lists every root before any dependency cache path.
		const all = graph.allProtoPaths();
		expect(all.slice(0, 2).sort()).toEqual(
			[path.join(root, "outer"), path.join(root, "outer/inner")].sort(),
		);
		expect(all.slice(2).sort()).toEqual(
			[
				cache.filesFor(PROTOVALIDATE, "9999cccc"),
				cache.filesFor(GOOGLEAPIS, "9999dddd"),
			].sort(),
		);
	});

	test("lists a dependency shared by two modules once", async () => {
		const cache = makeCache({ [GOOGLEAPIS]: ["eeee7777"] });
		process.env.BUF_CACHE_DIR = cache.dir;
		const lock = `version: v2\ndeps:\n  - name: ${GOOGLEAPIS}\n    commit: eeee7777\n`;
		const root = makeTree({
			"one/buf.yaml": "version: v2\n",
			"one/buf.lock": lock,
			"one/a.proto": "",
			"two/buf.yaml": "version: v2\n",
			"two/buf.lock": lock,
			"two/b.proto": "",
		});
		useWorkspace(root);

		const all = (await getModuleGraph()).allProtoPaths();
		expect(
			all.filter((p) => p === cache.filesFor(GOOGLEAPIS, "eeee7777")),
		).toHaveLength(1);
		expect(all).toHaveLength(3);
	});
});

/* ------------------------------------------------------------------ *
 * Caching
 * ------------------------------------------------------------------ */

describe("graph caching", () => {
	test("hands back the same graph inside the fast window", async () => {
		const root = makeTree({ "buf.yaml": "version: v1\n", "a.proto": "" });
		useWorkspace(root);

		const first = await getModuleGraph();
		let calls = 0;
		const walker = workspace.findFiles;
		workspace.findFiles = async (...args: Parameters<typeof walker>) => {
			calls++;
			return walker(...args);
		};
		const second = await getModuleGraph();
		expect(second).toBe(first);
		expect(calls).toBe(0);
	});

	test("rebuilds after invalidation and sees the edited manifest", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: first\n",
			"first/a.proto": "",
			"second/b.proto": "",
		});
		useWorkspace(root);

		const before = await getModuleGraph();
		expect(before.allProtoPaths()).toEqual([path.join(root, "first")]);

		fs.writeFileSync(
			path.join(root, "buf.yaml"),
			"version: v2\nmodules:\n  - path: second\n",
		);
		expect((await getModuleGraph()).allProtoPaths()).toEqual([
			path.join(root, "first"),
		]);

		invalidateModuleGraphCache();
		const after = await getModuleGraph();
		expect(after).not.toBe(before);
		expect(after.allProtoPaths()).toEqual([path.join(root, "second")]);
	});

	test("rebuilds to an equal graph when invalidation finds nothing changed", async () => {
		const root = makeTree({ "buf.yaml": "version: v1\n", "a.proto": "" });
		useWorkspace(root);

		const first = await getModuleGraph();
		invalidateModuleGraphCache();
		const second = await getModuleGraph();

		// `invalidateModuleGraphCache` drops the cached graph outright, so the
		// next call always rebuilds -- the mtime-key comparison inside
		// `getModuleGraph` only spares a rebuild once the fast TTL has expired
		// with the entry still present, which explicit invalidation precludes.
		// The guarantee here is therefore equal content, not object identity.
		expect(second).not.toBe(first);
		expect(second.allProtoPaths()).toEqual(first.allProtoPaths());
	});

	test("shares one build between concurrent callers", async () => {
		const root = makeTree({ "buf.yaml": "version: v1\n", "a.proto": "" });
		useWorkspace(root);
		let calls = 0;
		const walker = workspace.findFiles;
		workspace.findFiles = async (...args: Parameters<typeof walker>) => {
			calls++;
			return walker(...args);
		};

		const [a, b, c] = await Promise.all([
			getModuleGraph(),
			getModuleGraph(),
			getModuleGraph(),
		]);
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(calls).toBe(1);
	});
});

/* ------------------------------------------------------------------ *
 * The repository this extension is developed against
 * ------------------------------------------------------------------ */

describe("reference workspace", () => {
	const SMOKE_TEST = path.join(EXTENSION_ROOT, "smoke_test", "protobuf");

	test("resolves the smoke-test module and its api-linter config", async () => {
		useWorkspace(SMOKE_TEST);

		const graph = await getModuleGraph();
		expect(graph.modules()).toHaveLength(1);
		const [module] = graph.modules();
		// `modules: [{path: .}]` roots the module at the buf.yaml's directory.
		expect(module.root).toBe(SMOKE_TEST);
		expect(module.apiLinterConfig).toBe(
			path.join(SMOKE_TEST, ".api-linter.yaml"),
		);
		expect(graph.primaryConfig()).toBe(path.join(SMOKE_TEST, "buf.yaml"));
	});

	test.skipIf(!hasReferenceCorpus())(
		"resolves the real repository's two cached dependencies",
		async () => {
			const repo = path.resolve(EXTENSION_ROOT, "..");
			useWorkspace(repo);

			const graph = await getModuleGraph();
			const file = path.join(repo, "protobuf/fhir");
			const module = graph.forFile(file);
			// The root buf.yaml declares no `modules:`, so the module is the repo.
			expect(module?.root).toBe(repo);
			expect(module?.name).toBe("buf.build/shokki-engineering/fhir");

			const paths = graph.protoPathsFor(file);
			expect(paths[0]).toBe(repo);
			expect(paths).toHaveLength(3);
			for (const dep of paths.slice(1)) {
				expect(dep.endsWith("/files")).toBe(true);
				expect(fs.existsSync(dep)).toBe(true);
			}
			expect(module?.deps.map((d) => d.name)).toEqual([
				"buf.build/bufbuild/protovalidate",
				"buf.build/googleapis/googleapis",
			]);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"gives the nested extension checkout its own module",
		async () => {
			// The extension is checked out inside the repository's module, and its
			// smoke test carries a buf.yaml of its own. Longest-prefix resolution
			// means a smoke-test proto belongs to the smoke test, not to FHIR.
			const repo = path.resolve(EXTENSION_ROOT, "..");
			useWorkspace(repo);

			const graph = await getModuleGraph();
			const smoke = graph.forFile(path.join(SMOKE_TEST, "anything/v1/a.proto"));
			expect(smoke?.root).toBe(SMOKE_TEST);
			expect(graph.forFile(path.join(repo, "protobuf/fhir"))?.root).toBe(repo);
		},
	);
});
