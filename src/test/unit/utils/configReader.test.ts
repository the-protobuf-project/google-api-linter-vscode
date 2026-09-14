/**
 * Tests for `configReader`: the `workspace.protobuf.yaml` parser and the two
 * proto-path entry points every other module calls.
 *
 * The contract worth pinning is a negative one. This layer resolves what the
 * config file says and nothing more — a configured path that does not exist, or
 * that names a file rather than a directory, is returned unchanged. Deciding
 * which of those survive belongs to `protoImportRoots`, and moving that check
 * down here would silently drop a directory that a linter invocation still
 * wants on its `--proto-path`. The reader must also degrade rather than throw:
 * a half-typed config is the normal state of a file being edited, and an
 * exception here takes down every caller that asks for proto paths.
 *
 * `protoImportRoots.test.ts` exercises the same reader from the navigation
 * side, where the existence filter applies; this file stays on the reader's own
 * behaviour and on what it delegates to the module graph.
 *
 * Trees are real directories under `os.tmpdir()`. `BUF_CACHE_DIR` points at an
 * empty one so a dependency declared in a fixture cannot resolve against the
 * developer's own buf cache, and `PATH` is emptied so the graph's background
 * `buf dep graph` warm cannot reach a real binary.
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
	getProtoExclusion,
	getProtoPaths,
	getProtoPathsForFile,
	readGapiConfig,
} from "../../../utils/configReader";
import { invalidateModuleGraphCache } from "../../../utils/moduleGraph";
import { Uri, workspace } from "../support/vscode";

/* ------------------------------------------------------------------ *
 * Scaffolding
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

/**
 * A real directory tree, described as relative path → file contents. An empty
 * string makes a directory instead of a file.
 */
function makeTree(files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "config-reader-")),
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

/** Writes `contents` to a `workspace.protobuf.yaml` and returns its directory. */
function writeConfig(contents: string, dir?: string): string {
	const root = dir ?? makeTree({ "keep.txt": "x" });
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "workspace.protobuf.yaml"), contents);
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
 * The file names an include glob asks for. Both callers use a leading `**​/`
 * and one of them braces two alternatives.
 *
 * Matching whole basenames rather than substrings keeps the walker honest:
 * `**​/workspace.protobuf.yaml` ends with the text "buf.yaml", so a substring
 * test would hand every buf manifest in the tree back as a gapi config.
 */
function globBasenames(include: string): Set<string> {
	const tail = include.replace(/^\*\*\//, "");
	const braced = tail.match(/^\{(.*)\}$/);
	return new Set(
		(braced ? braced[1].split(",") : [tail]).map((name) => name.trim()),
	);
}

/**
 * Point the stub workspace at `root`, with a `findFiles` that walks it for real
 * and a `getWorkspaceFolder` that claims everything beneath it.
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
const originalBufCacheDir = process.env.BUF_CACHE_DIR;
const originalPath = process.env.PATH;

beforeAll(() => {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "config-reader-empty-"));
	tempRoots.push(empty);
	process.env.BUF_CACHE_DIR = empty;
	process.env.PATH = empty;
});

beforeEach(() => {
	invalidateModuleGraphCache();
});

afterEach(() => {
	workspace.workspaceFolders = originalWorkspaceFolders;
	workspace.findFiles = originalFindFiles;
	workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
	invalidateModuleGraphCache();
});

afterAll(() => {
	// Assigning the string "undefined" would leak a bogus cache root into every
	// later file in the run, so restore by deleting when there was no value.
	if (originalBufCacheDir === undefined) {
		delete process.env.BUF_CACHE_DIR;
	} else {
		process.env.BUF_CACHE_DIR = originalBufCacheDir;
	}
	process.env.PATH = originalPath;
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * Locating the config file
 * ------------------------------------------------------------------ */

describe("findGapiConfigFile", () => {
	test("stops at one match however many the workspace holds", async () => {
		const root = makeTree({
			"a/workspace.protobuf.yaml": "proto_path: one\n",
			"b/workspace.protobuf.yaml": "proto_path: two\n",
		});
		useWorkspace(root);
		const found = await findGapiConfigFile();
		expect(found?.fsPath).toBe(path.join(root, "a/workspace.protobuf.yaml"));
	});

	test("finds a config nested well below the workspace root", async () => {
		const root = makeTree({
			"deep/deeper/deepest/workspace.protobuf.yaml": "proto_path: p\n",
		});
		useWorkspace(root);
		const found = await findGapiConfigFile();
		expect(found?.fsPath).toBe(
			path.join(root, "deep/deeper/deepest/workspace.protobuf.yaml"),
		);
	});

	test("lets a host failure propagate rather than reporting no config", async () => {
		// Swallowing this would be worse than the throw: a transient host error
		// during shutdown would read as "the config was deleted" and quietly
		// reconfigure every proto path in the session.
		useWorkspace(makeTree({ "workspace.protobuf.yaml": "proto_path: p\n" }));
		workspace.findFiles = async () => {
			throw new Error("host is shutting down");
		};
		await expect(findGapiConfigFile()).rejects.toThrow("host is shutting down");
	});
});

describe("findGapiConfigFileInFolder", () => {
	test("looks only at the folder itself, never at its parent", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: p\n",
			child: "",
		});
		expect(
			await findGapiConfigFileInFolder(Uri.file(path.join(root, "child"))),
		).toBeNull();
	});

	test("returns null when the folder uri names a file", async () => {
		const root = makeTree({ "notadir.txt": "x" });
		expect(
			await findGapiConfigFileInFolder(
				Uri.file(path.join(root, "notadir.txt")),
			),
		).toBeNull();
	});

	test("reports a directory named workspace.protobuf.yaml as a config", async () => {
		// `stat` cannot tell the caller it found a directory, so the uri comes
		// back and the read behind it is what fails. Recorded as current
		// behaviour: `readGapiConfig` turns it into null a moment later.
		const root = makeTree({ "workspace.protobuf.yaml": "" });
		const found = await findGapiConfigFileInFolder(Uri.file(root));
		expect(found?.fsPath).toBe(path.join(root, "workspace.protobuf.yaml"));
	});
});

/* ------------------------------------------------------------------ *
 * Parsing the config file
 * ------------------------------------------------------------------ */

describe("readGapiConfig", () => {
	// The failure paths report through `console.error`; muting it keeps the
	// deliberate breakages out of the runner's output.
	let errors: ReturnType<typeof spyOn<Console, "error">> | undefined;

	beforeEach(() => {
		errors = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		errors?.mockRestore();
	});

	/** Reads a config written into its own directory. */
	async function read(contents: string) {
		const root = writeConfig(contents);
		const config = await readGapiConfig(
			Uri.file(path.join(root, "workspace.protobuf.yaml")),
		);
		return { root, config };
	}

	test("reports the parse failure rather than swallowing it silently", async () => {
		const { config } = await read("proto_paths:\n\t- tab-indented\n");
		expect(config).toBeNull();
		expect(errors).toHaveBeenCalled();
	});

	test("returns null for a file that is really a directory", async () => {
		const root = makeTree({ "workspace.protobuf.yaml": "" });
		expect(
			await readGapiConfig(
				Uri.file(path.join(root, "workspace.protobuf.yaml")),
			),
		).toBeNull();
	});

	test("returns null when the same key is given twice", async () => {
		// YAML rejects duplicate keys outright, so a config that repeats
		// `proto_path` is dropped whole rather than resolving the last one.
		const { config } = await read("proto_path: a\nproto_path: b\n");
		expect(config).toBeNull();
	});

	test("falls back to the config's directory for a whitespace-only file", async () => {
		const { root, config } = await read("   \n\n");
		expect(config?.protoPaths).toEqual([root]);
	});

	test("falls back to the config's directory when the key has no value", async () => {
		const { root, config } = await read("proto_path:\n");
		expect(config?.protoPaths).toEqual([root]);
	});

	test("reads a file with CRLF line endings", async () => {
		const { root, config } = await read("proto_paths:\r\n  - a\r\n  - b\r\n");
		expect(config?.protoPaths).toEqual([
			path.join(root, "a"),
			path.join(root, "b"),
		]);
	});

	test("reads a file that starts with a byte order mark", async () => {
		const { root, config } = await read("﻿proto_path: proto\n");
		expect(config?.protoPaths).toEqual([path.join(root, "proto")]);
	});

	test("keeps a non-ASCII path intact", async () => {
		const { root, config } = await read("proto_path: données/protos\n");
		expect(config?.protoPaths).toEqual([path.join(root, "données/protos")]);
	});

	test("accepts a list under the singular proto_path", async () => {
		const { root, config } = await read("proto_path:\n  - a\n  - b\n");
		expect(config?.protoPaths).toEqual([
			path.join(root, "a"),
			path.join(root, "b"),
		]);
	});

	test("accepts a scalar under the plural proto_paths", async () => {
		const { root, config } = await read("proto_paths: only\n");
		expect(config?.protoPaths).toEqual([path.join(root, "only")]);
	});

	test("trims surrounding whitespace from an entry", async () => {
		const { root, config } = await read('proto_path: "  padded  "\n');
		expect(config?.protoPaths).toEqual([path.join(root, "padded")]);
	});

	test("resolves a path that climbs above the config's directory", async () => {
		const nested = makeTree({ "sub/keep.txt": "x" });
		writeConfig("proto_path: ../shared\n", path.join(nested, "sub"));
		const config = await readGapiConfig(
			Uri.file(path.join(nested, "sub/workspace.protobuf.yaml")),
		);
		expect(config?.protoPaths).toEqual([path.join(nested, "shared")]);
	});

	test("resolves against the config's own directory, not the workspace root", async () => {
		const root = makeTree({ "svc/keep.txt": "x" });
		useWorkspace(root);
		writeConfig("proto_path: proto\n", path.join(root, "svc"));
		const config = await readGapiConfig(
			Uri.file(path.join(root, "svc/workspace.protobuf.yaml")),
		);
		expect(config?.protoPaths).toEqual([path.join(root, "svc/proto")]);
	});

	test("names the first entry as protoPath", async () => {
		const { root, config } = await read(
			"proto_paths:\n  - first\n  - second\n",
		);
		expect(config?.protoPath).toBe(path.join(root, "first"));
		expect(config?.protoPaths[0]).toBe(config?.protoPath);
	});

	test("keeps a configured path that does not exist", async () => {
		// Nothing here stats the filesystem. `protoImportRoots` drops the absent
		// directories; a linter invocation may still want them on --proto-path.
		const { root, config } = await read("proto_path: never/created\n");
		expect(config?.protoPaths).toEqual([path.join(root, "never/created")]);
		expect(fs.existsSync(path.join(root, "never/created"))).toBe(false);
	});

	test("keeps a configured path that names a file", async () => {
		const root = writeConfig("proto_path: thing.proto\n");
		fs.writeFileSync(path.join(root, "thing.proto"), 'syntax = "proto3";\n');
		const config = await readGapiConfig(
			Uri.file(path.join(root, "workspace.protobuf.yaml")),
		);
		expect(config?.protoPaths).toEqual([path.join(root, "thing.proto")]);
	});

	test("ignores keys it does not know", async () => {
		const { root, config } = await read(
			"version: v1\nproto_path: p\nlinter:\n  rules:\n    - core\n",
		);
		expect(config?.protoPaths).toEqual([path.join(root, "p")]);
	});
});

/* ------------------------------------------------------------------ *
 * Whole-workspace proto paths
 * ------------------------------------------------------------------ */

describe("getProtoPaths", () => {
	test("keeps absent and non-directory config entries in the list", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml":
				"proto_paths:\n  - present\n  - absent\n  - a.proto\n",
			present: "",
			"a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(await getProtoPaths()).toEqual([
			path.join(root, "present"),
			path.join(root, "absent"),
			path.join(root, "a.proto"),
		]);
	});

	test("lists a directory once when the config and a module agree on it", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: svc/proto\n",
			"svc/buf.yaml": "version: v2\nmodules:\n  - path: proto\n",
			"svc/proto": "",
		});
		useWorkspace(root);
		expect(await getProtoPaths()).toEqual([path.join(root, "svc/proto")]);
	});

	test("falls back to the module roots when the config is malformed", async () => {
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const root = makeTree({
				"workspace.protobuf.yaml": "proto_paths:\n\t- broken\n",
				"svc/buf.yaml": "version: v2\n",
			});
			useWorkspace(root);
			expect(await getProtoPaths()).toEqual([path.join(root, "svc")]);
		} finally {
			errors.mockRestore();
		}
	});

	test("uses the workspace root only when nothing else is configured", async () => {
		const root = makeTree({ "a/thing.proto": 'syntax = "proto3";\n' });
		useWorkspace(root);
		expect(await getProtoPaths()).toEqual([root]);
	});

	test("does not add the workspace root once a config supplies a path", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: shared\n",
			shared: "",
		});
		useWorkspace(root);
		expect(await getProtoPaths()).toEqual([path.join(root, "shared")]);
	});

	test("returns an empty list when no folder is open", async () => {
		workspace.workspaceFolders = undefined;
		workspace.findFiles = async () => [];
		expect(await getProtoPaths()).toEqual([]);
	});

	test("writes the graph summary to the output channel it is given", async () => {
		const lines: string[] = [];
		const root = makeTree({ "svc/buf.yaml": "version: v2\n" });
		useWorkspace(root);
		await getProtoPaths({ appendLine: (s) => lines.push(s) });
		expect(lines.join("\n")).toContain("module graph");
	});
});

/* ------------------------------------------------------------------ *
 * Per-file proto paths
 * ------------------------------------------------------------------ */

describe("getProtoPathsForFile", () => {
	test("lists a directory once when the config repeats the module root", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: svc\n",
			"svc/buf.yaml": "version: v2\n",
			"svc/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(await getProtoPathsForFile(path.join(root, "svc/a.proto"))).toEqual([
			path.join(root, "svc"),
		]);
	});

	test("keeps the config entries even for a file in no module at all", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: shared\n",
			shared: "",
			"svc/buf.yaml": "version: v2\n",
			"loose/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		// No module owns the file, so this is the whole-workspace list.
		expect(
			await getProtoPathsForFile(path.join(root, "loose/a.proto")),
		).toEqual([path.join(root, "shared"), path.join(root, "svc")]);
	});

	test("gives a nested module its own root rather than its parent's", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: outer\n",
			"outer/a.proto": 'syntax = "proto3";\n',
			"outer/inner/buf.yaml": "version: v2\n",
			"outer/inner/b.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(
			await getProtoPathsForFile(path.join(root, "outer/inner/b.proto")),
		).toEqual([path.join(root, "outer/inner")]);
	});

	test("normalises a path that doubles back on itself", async () => {
		const root = makeTree({
			"svc/buf.yaml": "version: v2\n",
			"svc/a/b.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		expect(
			await getProtoPathsForFile(
				path.join(root, "svc", "a", "..", "a", "b.proto"),
			),
		).toEqual([path.join(root, "svc")]);
	});

	test("returns the whole-workspace list for a file outside the workspace", async () => {
		const root = makeTree({ "svc/buf.yaml": "version: v2\n" });
		const elsewhere = makeTree({ "x/a.proto": 'syntax = "proto3";\n' });
		useWorkspace(root);
		expect(
			await getProtoPathsForFile(path.join(elsewhere, "x/a.proto")),
		).toEqual([path.join(root, "svc")]);
	});

	test("writes the graph summary to the output channel it is given", async () => {
		const lines: string[] = [];
		const root = makeTree({
			"svc/buf.yaml": "version: v2\n",
			"svc/a.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);
		await getProtoPathsForFile(path.join(root, "svc/a.proto"), {
			appendLine: (s) => lines.push(s),
		});
		expect(lines.join("\n")).toContain("module graph");
	});
});

/* ------------------------------------------------------------------ *
 * Caching
 * ------------------------------------------------------------------ */

describe("caching", () => {
	test("serves an edited buf.yaml from the cache until it is invalidated", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: first\n",
			first: "",
			second: "",
		});
		useWorkspace(root);

		expect(await getProtoPaths()).toEqual([path.join(root, "first")]);

		fs.writeFileSync(
			path.join(root, "buf.yaml"),
			"version: v2\nmodules:\n  - path: second\n",
		);
		// Deliberate: re-walking the workspace on every keystroke is what the
		// rewrite removed. The file watcher invalidates instead.
		expect(await getProtoPaths()).toEqual([path.join(root, "first")]);

		invalidateModuleGraphCache();
		expect(await getProtoPaths()).toEqual([path.join(root, "second")]);
	});

	test("re-reads workspace.protobuf.yaml on every call", async () => {
		const root = makeTree({
			"workspace.protobuf.yaml": "proto_path: before\n",
			"svc/buf.yaml": "version: v2\n",
		});
		useWorkspace(root);

		expect(await getProtoPaths()).toEqual([
			path.join(root, "before"),
			path.join(root, "svc"),
		]);

		// Only the module graph is cached. The gapi config is located and parsed
		// afresh each time, so an edit lands without invalidation — and so every
		// request pays for another `findFiles` glob over the workspace.
		fs.writeFileSync(
			path.join(root, "workspace.protobuf.yaml"),
			"proto_path: after\n",
		);
		expect(await getProtoPaths()).toEqual([
			path.join(root, "after"),
			path.join(root, "svc"),
		]);
	});

	test("shares one cached graph between the two entry points", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: first\n",
			"first/a.proto": 'syntax = "proto3";\n',
			second: "",
		});
		useWorkspace(root);

		expect(
			await getProtoPathsForFile(path.join(root, "first/a.proto")),
		).toEqual([path.join(root, "first")]);

		fs.writeFileSync(
			path.join(root, "buf.yaml"),
			"version: v2\nmodules:\n  - path: second\n",
		);
		expect(await getProtoPaths()).toEqual([path.join(root, "first")]);

		invalidateModuleGraphCache();
		expect(await getProtoPaths()).toEqual([path.join(root, "second")]);
	});

	test("does not carry one workspace's answer over to the next", async () => {
		const one = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: a\n",
		});
		fs.mkdirSync(path.join(one, "a"));
		useWorkspace(one);
		expect(await getProtoPaths()).toEqual([path.join(one, "a")]);

		const two = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: b\n",
		});
		fs.mkdirSync(path.join(two, "b"));
		useWorkspace(two);
		invalidateModuleGraphCache();
		expect(await getProtoPaths()).toEqual([path.join(two, "b")]);
	});
});

/* ------------------------------------------------------------------ *
 * Excluding folders from linting
 * ------------------------------------------------------------------ */

describe("getProtoExclusion", () => {
	/** Writes a config at `root` and returns the compiled exclusion. */
	async function exclusionFor(contents: string) {
		const root = makeTree({ "workspace.protobuf.yaml": contents });
		useWorkspace(root);
		return { root, exclusion: await getProtoExclusion() };
	}

	test("excludes everything under a bare directory name", async () => {
		const { root, exclusion } = await exclusionFor("exclude:\n  - vendor\n");
		expect(exclusion.isExcluded(path.join(root, "vendor/book.proto"))).toBe(
			true,
		);
		expect(
			exclusion.isExcluded(path.join(root, "vendor/deep/book.proto")),
		).toBe(true);
		expect(exclusion.isExcluded(path.join(root, "src/book.proto"))).toBe(false);
	});

	test("accepts a scalar as readily as a list", async () => {
		const { root, exclusion } = await exclusionFor("exclude: vendor\n");
		expect(exclusion.isExcluded(path.join(root, "vendor/book.proto"))).toBe(
			true,
		);
	});

	test("accepts excluded_paths as an alias", async () => {
		const { root, exclusion } = await exclusionFor(
			"excluded_paths:\n  - third_party\n",
		);
		expect(
			exclusion.isExcluded(path.join(root, "third_party/book.proto")),
		).toBe(true);
	});

	test("matches file globs, not only directories", async () => {
		const { root, exclusion } = await exclusionFor(
			'exclude:\n  - "**/*.pb.proto"\n',
		);
		expect(exclusion.isExcluded(path.join(root, "gen/book.pb.proto"))).toBe(
			true,
		);
		expect(exclusion.isExcluded(path.join(root, "gen/book.proto"))).toBe(false);
	});

	test("patterns are relative to the config, not to the workspace root", async () => {
		// The config sits one level down, so `vendor` means that module's vendor
		// directory -- a sibling module's vendor tree is not its business.
		const root = makeTree({
			"mod/workspace.protobuf.yaml": "exclude:\n  - vendor\n",
		});
		useWorkspace(root);
		const exclusion = await getProtoExclusion();
		expect(exclusion.isExcluded(path.join(root, "mod/vendor/a.proto"))).toBe(
			true,
		);
		expect(exclusion.isExcluded(path.join(root, "other/vendor/a.proto"))).toBe(
			false,
		);
	});

	test("never claims a file outside the config's own tree", async () => {
		const { exclusion } = await exclusionFor("exclude:\n  - vendor\n");
		const elsewhere = makeTree({ "vendor/book.proto": "x" });
		expect(
			exclusion.isExcluded(path.join(elsewhere, "vendor/book.proto")),
		).toBe(false);
	});

	test("excludes nothing when no config is open", async () => {
		useWorkspace(makeTree({ "keep.txt": "x" }));
		const exclusion = await getProtoExclusion();
		expect(exclusion.root).toBeNull();
		expect(exclusion.patterns).toEqual([]);
		expect(exclusion.isExcluded("/anywhere/book.proto")).toBe(false);
	});

	test("excludes nothing when the config has no exclude key", async () => {
		const { root, exclusion } = await exclusionFor("proto_path: .\n");
		expect(exclusion.isExcluded(path.join(root, "vendor/book.proto"))).toBe(
			false,
		);
	});

	test("reports the patterns it compiled, for the output channel", async () => {
		const { exclusion } = await exclusionFor(
			"exclude:\n  - vendor\n  - third_party\n",
		);
		expect(exclusion.patterns).toEqual(["vendor", "third_party"]);
	});
});
