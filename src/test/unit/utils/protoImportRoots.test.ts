/**
 * Tests for import-root resolution: `protoImportRoots` and the
 * `workspace.protobuf.yaml` reader it sits on top of.
 *
 * Every navigation feature — go-to-definition, document links, the references
 * scan — resolves `import "pkg/thing.proto"` against this list, so a root that
 * goes missing reads as "this extension cannot find anything" rather than as a
 * config bug. Three properties matter and are pinned here: only directories
 * that exist survive, order is the search order (nearest module first, home
 * fallbacks last), and the module graph behind the list is cached until
 * something explicitly invalidates it, while `workspace.protobuf.yaml` is not.
 *
 * `configReader` is covered in the same file because it has no public surface
 * of its own worth isolating: `getProtoPaths` is reached through these two
 * functions, and the config file's own parsing is what decides what they
 * return. The upward `.api-linter.yaml` walk lives in `moduleGraph` and is
 * covered by that file's tests.
 *
 * The trees are real directories under `os.tmpdir()`: what is and is not on
 * disk is the entire behaviour under test. `os.homedir` is stubbed so the
 * `~/.gapi` fallbacks cannot depend on the developer's own machine — setting
 * `HOME` is not enough, because Bun resolves the home directory once at startup
 * and ignores later writes to the variable. `PATH` is emptied so the module
 * graph's background `buf dep graph` warm cannot reach a real binary.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findGapiConfigFile,
	findGapiConfigFileInFolder,
	getProtoPaths,
	getProtoPathsForFile,
	readGapiConfig,
} from "../../../utils/configReader";
import {
	getGapiAnnotationRoots,
	getProtoImportSearchRoots,
	getProtoImportSearchRootsForFile,
	invalidateProtoImportRootsCache,
} from "../../../utils/protoImportRoots";
import { Uri, workspace } from "../support/vscode";

/* ------------------------------------------------------------------ *
 * Scaffolding
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

/** A real directory tree, described as relative path → file contents. */
function makeTree(files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "import-roots-")),
	);
	tempRoots.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		if (contents === "") {
			fs.mkdirSync(full, { recursive: true });
			continue;
		}
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}
	return root;
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
 * The file names an include glob asks for.
 *
 * Matching on the basename rather than globbing keeps the walker honest: a
 * substring test would let `**\/workspace.protobuf.yaml` match `buf.yaml`,
 * since "protobuf.yaml" ends with it.
 */
function globBasenames(include: string): Set<string> {
	const tail = include.replace(/^\*\*\//, "");
	const braced = tail.match(/^\{(.*)\}$/);
	return new Set(
		(braced ? braced[1].split(",") : [tail]).map((name) => name.trim()),
	);
}

/**
 * Point the stub workspace at `root`, with a `findFiles` that walks it for
 * real and a `getWorkspaceFolder` that claims everything beneath it.
 */
function useWorkspace(root: string): void {
	workspace.workspaceFolders = [{ uri: Uri.file(root), name: "w", index: 0 }];
	workspace.getWorkspaceFolder = (uri: Uri) =>
		uri.fsPath.startsWith(root) ? { uri: Uri.file(root) } : undefined;
	workspace.findFiles = async (
		include: string,
		_exclude?: string,
		maxResults?: number,
	): Promise<Uri[]> => {
		const wanted = globBasenames(include);
		const found: Uri[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs
				.readdirSync(dir, { withFileTypes: true })
				.sort((a, b) => a.name.localeCompare(b.name))) {
				if (maxResults !== undefined && found.length >= maxResults) {
					return;
				}
				if (entry.isDirectory()) {
					if (!SKIP_DIRS.has(entry.name)) {
						walk(path.join(dir, entry.name));
					}
				} else if (wanted.has(entry.name)) {
					found.push(Uri.file(path.join(dir, entry.name)));
				}
			}
		};
		walk(root);
		return maxResults === undefined ? found : found.slice(0, maxResults);
	};
}

const originalWorkspaceFolders = workspace.workspaceFolders;
const originalFindFiles = workspace.findFiles;
const originalGetWorkspaceFolder = workspace.getWorkspaceFolder;
const originalPath = process.env.PATH;

/** A home directory of our own, so `~/.gapi` is whatever the test says it is. */
let fakeHome = "";
let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">> | undefined;

beforeAll(() => {
	fakeHome = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "import-roots-home-")),
	);
	tempRoots.push(fakeHome);
	// `gapiHomeRoots` reads `os.homedir()`, which Bun caches from the real
	// passwd entry at startup; assigning `process.env.HOME` here would leave the
	// developer's own `~/.gapi` in every answer.
	homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
	// The graph fires off `buf dep graph` in the background whenever a declared
	// dependency is missing from the cache. An unresolvable PATH turns that into
	// a logged spawn error rather than a real subprocess.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));
	tempRoots.push(empty);
	process.env.PATH = empty;
});

beforeEach(() => {
	invalidateProtoImportRootsCache();
});

afterEach(() => {
	workspace.workspaceFolders = originalWorkspaceFolders;
	workspace.findFiles = originalFindFiles;
	workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
	invalidateProtoImportRootsCache();
});

afterAll(() => {
	homedirSpy?.mockRestore();
	process.env.PATH = originalPath;
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * Finding the config file
 * ------------------------------------------------------------------ */

describe("findGapiConfigFile", () => {
	test("returns the first match in the workspace", async () => {
		const root = makeTree({ "workspace.protobuf.yaml": "proto_path: proto\n" });
		useWorkspace(root);
		const found = await findGapiConfigFile();
		expect(found?.fsPath).toBe(path.join(root, "workspace.protobuf.yaml"));
	});

	test("returns null when the workspace has none", async () => {
		useWorkspace(makeTree({ "buf.yaml": "version: v2\n" }));
		expect(await findGapiConfigFile()).toBeNull();
	});

	test("does not mistake buf.yaml for the gapi config", async () => {
		// `**/workspace.protobuf.yaml` ends with the text "buf.yaml"; a matcher
		// that compares substrings picks up every buf manifest in the tree and
		// then parses one as a gapi config.
		useWorkspace(makeTree({ "nested/buf.yaml": "version: v2\n" }));
		expect(await findGapiConfigFile()).toBeNull();
	});
});

describe("findGapiConfigFileInFolder", () => {
	test("finds the config at the folder root", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: proto\n",
			"nested/workspace.protobuf.yaml": "proto_path: other\n",
		});
		const found = await findGapiConfigFileInFolder(Uri.file(root));
		expect(found?.fsPath).toBe(path.join(root, "workspace.protobuf.yaml"));
	});

	test("returns null when the folder has no config, ignoring nested ones", async () => {
		const root = makeTree({
			"nested/workspace.protobuf.yaml": "proto_path: other\n",
		});
		expect(await findGapiConfigFileInFolder(Uri.file(root))).toBeNull();
	});

	test("returns null for a folder that does not exist", async () => {
		const root = makeTree({ "a/keep.txt": "x" });
		expect(
			await findGapiConfigFileInFolder(Uri.file(path.join(root, "absent"))),
		).toBeNull();
	});
});

/* ------------------------------------------------------------------ *
 * Reading the config file
 * ------------------------------------------------------------------ */

describe("readGapiConfig", () => {
	// Unreadable and malformed configs are reported through `console.error`;
	// muting it here keeps the deliberate failures out of the runner's output.
	let errors: ReturnType<typeof spyOn<Console, "error">> | undefined;

	beforeEach(() => {
		errors = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errors?.mockRestore();
	});

	/**
	 * Writes one config file and reads it back.
	 *
	 * The file is written directly rather than through `makeTree`, whose
	 * empty-string values mean "make a directory here" — passing `""` through it
	 * would create a *directory* named `workspace.protobuf.yaml` and the read
	 * would fail with EISDIR instead of exercising the empty-file path.
	 */
	async function read(contents: string) {
		const root = makeTree({ "keep.txt": "x" });
		const file = path.join(root, "workspace.protobuf.yaml");
		fs.writeFileSync(file, contents);
		const config = await readGapiConfig(Uri.file(file));
		return { root, config };
	}

	test("resolves a scalar proto_path against the config's directory", async () => {
		const { root, config } = await read("proto_path: proto\n");
		expect(config?.protoPaths).toEqual([path.join(root, "proto")]);
		expect(config?.protoPath).toBe(path.join(root, "proto"));
	});

	test("accepts a list under proto_paths", async () => {
		const { root, config } = await read("proto_paths:\n  - a\n  - b/c\n");
		expect(config?.protoPaths).toEqual([
			path.join(root, "a"),
			path.join(root, "b/c"),
		]);
	});

	test("puts proto_paths before proto_path and drops the duplicate", async () => {
		const { root, config } = await read(
			"proto_paths:\n  - a\n  - b\nproto_path: a\n",
		);
		expect(config?.protoPaths).toEqual([
			path.join(root, "a"),
			path.join(root, "b"),
		]);
	});

	test("treats paths that resolve to the same directory as one", async () => {
		const { root, config } = await read("proto_paths:\n  - a\n  - ./a/\n");
		expect(config?.protoPaths).toEqual([path.join(root, "a")]);
	});

	test("accepts an absolute path unchanged", async () => {
		const elsewhere = makeTree({ "x/keep.txt": "x" });
		const { config } = await read(`proto_path: ${path.join(elsewhere, "x")}\n`);
		expect(config?.protoPaths).toEqual([path.join(elsewhere, "x")]);
	});

	test("falls back to the config's own directory when no path is given", async () => {
		const { root, config } = await read("version: v1\n");
		expect(config?.protoPaths).toEqual([root]);
	});

	test("falls back to the config's own directory for an empty file", async () => {
		const { root, config } = await read("");
		expect(config?.protoPaths).toEqual([root]);
	});

	test("ignores a top-level list rather than reading it as a mapping", async () => {
		const { root, config } = await read("- a\n- b\n");
		expect(config?.protoPaths).toEqual([root]);
	});

	test("ignores blank and non-string entries", async () => {
		const { root, config } = await read(
			"proto_paths:\n  - '   '\n  - 42\n  - real\n",
		);
		expect(config?.protoPaths).toEqual([path.join(root, "real")]);
	});

	test("flattens a nested list", async () => {
		const { root, config } = await read("proto_paths:\n  - [a, b]\n");
		expect(config?.protoPaths).toEqual([
			path.join(root, "a"),
			path.join(root, "b"),
		]);
	});

	test("returns null for malformed yaml", async () => {
		const { config } = await read("proto_paths:\n  - [unclosed\n");
		expect(config).toBeNull();
	});

	test("returns null when the file does not exist", async () => {
		const root = makeTree({ "keep.txt": "x" });
		expect(
			await readGapiConfig(
				Uri.file(path.join(root, "workspace.protobuf.yaml")),
			),
		).toBeNull();
	});
});

/* ------------------------------------------------------------------ *
 * Whole-workspace and per-file proto paths
 * ------------------------------------------------------------------ */

describe("getProtoPaths", () => {
	test("puts workspace.protobuf.yaml entries before module roots", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: shared\n",
			shared: "",
			"svc/buf.yaml": "version: v2\nmodules:\n  - path: proto\n",
			"svc/proto": "",
		});
		useWorkspace(root);
		expect(await getProtoPaths()).toEqual([
			path.join(root, "shared"),
			path.join(root, "svc/proto"),
		]);
	});

	test("collects the roots of every module in the workspace", async () => {
		const root = makeTree({
			"one/buf.yaml": "version: v2\n",
			"two/buf.yaml": "version: v2\n",
		});
		useWorkspace(root);
		const paths = await getProtoPaths();
		expect(paths).toContain(path.join(root, "one"));
		expect(paths).toContain(path.join(root, "two"));
	});

	test("falls back to the workspace root when nothing is configured", async () => {
		const root = makeTree({ "a/thing.proto": 'syntax = "proto3";\n' });
		useWorkspace(root);
		expect(await getProtoPaths()).toEqual([root]);
	});

	test("returns nothing when no folder is open", async () => {
		workspace.workspaceFolders = undefined;
		expect(await getProtoPaths()).toEqual([]);
	});
});

describe("getProtoPathsForFile", () => {
	test("returns the file's own module roots, not every module's", async () => {
		const root = makeTree({
			"one/buf.yaml": "version: v2\n",
			"one/a.proto": 'syntax = "proto3";\n',
			"two/buf.yaml": "version: v2\n",
		});
		useWorkspace(root);
		expect(await getProtoPathsForFile(path.join(root, "one/a.proto"))).toEqual([
			path.join(root, "one"),
		]);
	});

	test("keeps workspace.protobuf.yaml entries in front of the module roots", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: shared\n",
			shared: "",
			"one/buf.yaml": "version: v2\n",
			"one/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(await getProtoPathsForFile(path.join(root, "one/a.proto"))).toEqual([
			path.join(root, "shared"),
			path.join(root, "one"),
		]);
	});

	test("falls back to the whole-workspace list for a file in no module", async () => {
		const root = makeTree({
			"one/buf.yaml": "version: v2\n",
			"loose/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(
			await getProtoPathsForFile(path.join(root, "loose/a.proto")),
		).toEqual([path.join(root, "one")]);
	});

	test("resolves a relative file path before matching a module", async () => {
		const root = makeTree({
			"one/buf.yaml": "version: v2\n",
			"one/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		const relative = path.relative(
			process.cwd(),
			path.join(root, "one/a.proto"),
		);
		expect(await getProtoPathsForFile(relative)).toEqual([
			path.join(root, "one"),
		]);
	});
});

/* ------------------------------------------------------------------ *
 * Import search roots
 * ------------------------------------------------------------------ */

describe("getProtoImportSearchRoots", () => {
	test("orders workspace folders, then config paths, then home fallbacks", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: shared\n",
			shared: "",
			"svc/buf.yaml": "version: v2\nmodules:\n  - path: proto\n",
			"svc/proto": "",
		});
		fs.mkdirSync(path.join(fakeHome, ".gapi/googleapis"), { recursive: true });
		useWorkspace(root);
		try {
			expect(await getProtoImportSearchRoots()).toEqual([
				root,
				path.join(root, "shared"),
				path.join(root, "svc/proto"),
				path.join(fakeHome, ".gapi/googleapis"),
			]);
		} finally {
			fs.rmSync(path.join(fakeHome, ".gapi"), { recursive: true, force: true });
		}
	});

	test("drops configured paths that do not exist", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_paths:\n  - present\n  - absent\n",
			present: "",
		});
		useWorkspace(root);
		expect(await getProtoImportSearchRoots()).toEqual([
			root,
			path.join(root, "present"),
		]);
	});

	test("drops a configured path that is a file rather than a directory", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: notadir.proto\n",
			"notadir.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(await getProtoImportSearchRoots()).toEqual([root]);
	});

	test("lists a directory once however many times it is configured", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_paths:\n  - .\n  - ./\n  - sub/..\n",
		});
		useWorkspace(root);
		expect(await getProtoImportSearchRoots()).toEqual([root]);
	});

	test("still returns the workspace folder when the config read fails", async () => {
		const root = makeTree({ "a/keep.txt": "x" });
		useWorkspace(root);
		const failing = workspace.findFiles;
		workspace.findFiles = async (include: string) => {
			if (include.includes("workspace.protobuf.yaml")) {
				throw new Error("host is shutting down");
			}
			return failing(include);
		};
		// `findGapiConfigFile` does not swallow host errors, so the whole
		// `getProtoPaths` call rejects; the search roots must survive it.
		expect(await getProtoImportSearchRoots()).toEqual([root]);
	});

	test("returns only the existing home fallbacks when no folder is open", async () => {
		workspace.workspaceFolders = undefined;
		fs.mkdirSync(path.join(fakeHome, ".gapi/protobuf/src"), {
			recursive: true,
		});
		try {
			expect(await getProtoImportSearchRoots()).toEqual([
				path.join(fakeHome, ".gapi/protobuf/src"),
				path.join(fakeHome, ".gapi/protobuf"),
			]);
		} finally {
			fs.rmSync(path.join(fakeHome, ".gapi"), { recursive: true, force: true });
		}
	});

	test("returns nothing when neither the workspace nor the home dirs exist", async () => {
		workspace.workspaceFolders = undefined;
		expect(await getProtoImportSearchRoots()).toEqual([]);
	});
});

describe("getProtoImportSearchRootsForFile", () => {
	test("puts the file's own module ahead of the workspace folder", async () => {
		const root = makeTree({
			"svc/buf.yaml": "version: v2\n",
			"svc/a.proto": 'syntax = "proto3";\n',
			"other/buf.yaml": "version: v2\n",
		});
		useWorkspace(root);
		expect(
			await getProtoImportSearchRootsForFile(path.join(root, "svc/a.proto")),
		).toEqual([path.join(root, "svc"), root]);
	});

	test("falls back to the whole workspace for a file in no module", async () => {
		const root = makeTree({
			"svc/buf.yaml": "version: v2\n",
			"loose/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(
			await getProtoImportSearchRootsForFile(path.join(root, "loose/a.proto")),
		).toEqual([path.join(root, "svc"), root]);
	});

	test("returns the home fallbacks for a file outside any workspace", async () => {
		const root = makeTree({ "a/x.proto": 'syntax = "proto3";\n' });
		workspace.workspaceFolders = undefined;
		fs.mkdirSync(path.join(fakeHome, ".gapi/googleapis"), { recursive: true });
		try {
			expect(
				await getProtoImportSearchRootsForFile(path.join(root, "a/x.proto")),
			).toEqual([path.join(fakeHome, ".gapi/googleapis")]);
		} finally {
			fs.rmSync(path.join(fakeHome, ".gapi"), { recursive: true, force: true });
		}
	});
});

/* ------------------------------------------------------------------ *
 * Cache invalidation
 * ------------------------------------------------------------------ */

describe("invalidateProtoImportRootsCache", () => {
	test("a changed buf.yaml is picked up only after invalidation", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: a\n",
			a: "",
			b: "",
		});
		useWorkspace(root);

		expect(await getProtoImportSearchRoots()).toContain(path.join(root, "a"));

		fs.writeFileSync(
			path.join(root, "buf.yaml"),
			"version: v2\nmodules:\n  - path: b\n",
		);
		// Still the old answer: the graph is cached, which is the whole point —
		// every keystroke would otherwise re-walk the workspace.
		const stale = await getProtoImportSearchRoots();
		expect(stale).toContain(path.join(root, "a"));
		expect(stale).not.toContain(path.join(root, "b"));

		invalidateProtoImportRootsCache();
		const fresh = await getProtoImportSearchRoots();
		expect(fresh).toContain(path.join(root, "b"));
		expect(fresh).not.toContain(path.join(root, "a"));
	});

	test("a newly created workspace.protobuf.yaml needs no invalidation", async () => {
		const root = makeTree({ "a/keep.txt": "x" });
		useWorkspace(root);

		expect(await getProtoImportSearchRoots()).toEqual([root]);

		// Only the module graph is cached. `workspace.protobuf.yaml` is located
		// and re-parsed on every call, so a config that appears mid-session takes
		// effect at once — the asymmetry with buf.yaml above is deliberate to
		// record, since it also means every request re-runs the `findFiles` glob.
		fs.writeFileSync(
			path.join(root, "workspace.protobuf.yaml"),
			"proto_path: a\n",
		);
		expect(await getProtoImportSearchRoots()).toEqual([
			root,
			path.join(root, "a"),
		]);

		invalidateProtoImportRootsCache();
		expect(await getProtoImportSearchRoots()).toEqual([
			root,
			path.join(root, "a"),
		]);
	});

	test("is safe to call before anything has been resolved", () => {
		expect(() => {
			invalidateProtoImportRootsCache();
			invalidateProtoImportRootsCache();
		}).not.toThrow();
	});
});

describe("getGapiAnnotationRoots", () => {
	test("returns the well-known directories that exist", async () => {
		fs.mkdirSync(path.join(fakeHome, ".gapi/googleapis"), { recursive: true });
		fs.mkdirSync(path.join(fakeHome, ".gapi/protobuf/src"), {
			recursive: true,
		});

		const roots = await getGapiAnnotationRoots();
		expect(roots).toContain(path.join(fakeHome, ".gapi", "googleapis"));
		expect(roots).toContain(path.join(fakeHome, ".gapi", "protobuf", "src"));
	});

	test("omits what is not on disk rather than reporting it", async () => {
		// A home of its own: `fakeHome` is built once for the whole file, so
		// asserting emptiness against it would only pass while this test ran
		// before the ones that populate it.
		const emptyHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "import-roots-empty-")),
		);
		tempRoots.push(emptyHome);
		homedirSpy?.mockReturnValue(emptyHome);
		try {
			// The scanner would otherwise be handed paths that do not exist and
			// spend a readdir failing on each.
			expect(await getGapiAnnotationRoots()).toEqual([]);
		} finally {
			homedirSpy?.mockReturnValue(fakeHome);
		}
	});

	test("is where google.api annotations come from for a non-buf workspace", async () => {
		// The regression this guards. Annotation roots used to be the module
		// graph's paths filtered to the buf cache, so a workspace that resolves
		// `google/api/...` through `~/.gapi` — the copy this extension
		// downloads itself — contributed no roots, found no `extend` blocks,
		// and showed no Annotations section at all.
		const api = path.join(fakeHome, ".gapi/googleapis/google/api");
		fs.mkdirSync(api, { recursive: true });
		fs.writeFileSync(path.join(api, "annotations.proto"), "");

		const roots = await getGapiAnnotationRoots();
		expect(roots.length).toBeGreaterThan(0);
		expect(
			roots.some((root) =>
				path.join(fakeHome, ".gapi/googleapis/google/api").startsWith(root),
			),
		).toBe(true);
	});
});
