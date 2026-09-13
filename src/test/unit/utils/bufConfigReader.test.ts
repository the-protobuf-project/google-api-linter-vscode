/**
 * Tests for `bufConfigReader`, the public face of buf configuration.
 *
 * Two things matter here. The parsers must degrade rather than throw: a
 * half-typed `buf.yaml` is the normal state of a file being edited, and an
 * exception there takes down every feature that asks for proto paths. And the
 * proto-path functions must keep delegating to the module graph — the rewrite
 * replaced a single `buf.yaml` plus `buf export` with a graph that reads
 * `buf.lock` and the buf module cache, precisely because `buf export` returns
 * nothing whenever the module fails to compile, which is when the linter is
 * wanted most.
 *
 * `cleanupAllBufTmpDirs` is covered too: it is a documented no-op kept only so
 * `deactivate` compiles, and it must stay one.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupAllBufTmpDirs,
	findBufConfig,
	getBufProtoPaths,
	getBufProtoPathsForFile,
	invalidateBufProtoPathsCache,
	readBufConfig,
	readBufModuleRoots,
} from "../../../utils/bufConfigReader";
import { Uri, workspace } from "../support/vscode";

/* ------------------------------------------------------------------ *
 * Temporary workspaces
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];

/** A real directory tree, described as path → file contents. */
function makeTree(files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "buf-config-")),
	);
	tempRoots.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}
	return root;
}

const originalWorkspaceFolders = workspace.workspaceFolders;
const originalFindFiles = workspace.findFiles;
const originalGetWorkspaceFolder = workspace.getWorkspaceFolder;

/**
 * Point the stub workspace at `root`, with a `findFiles` that walks it for
 * real. The include glob is ignored: the only caller asks for buf manifests,
 * and matching basenames is closer to what the extension host returns than a
 * half-implemented globber would be.
 */
function useWorkspace(root: string): void {
	workspace.workspaceFolders = [{ uri: Uri.file(root), name: "w", index: 0 }];
	workspace.getWorkspaceFolder = (uri: Uri) =>
		uri.fsPath.startsWith(root) ? { uri: Uri.file(root) } : undefined;
	workspace.findFiles = async (): Promise<Uri[]> => {
		const found: Uri[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (
					entry.name === "buf.yaml" ||
					entry.name === "buf.work.yaml"
				) {
					found.push(Uri.file(full));
				}
			}
		};
		walk(root);
		return found;
	};
}

beforeEach(() => {
	invalidateBufProtoPathsCache();
});

afterEach(() => {
	workspace.workspaceFolders = originalWorkspaceFolders;
	workspace.findFiles = originalFindFiles;
	workspace.getWorkspaceFolder = originalGetWorkspaceFolder;
	invalidateBufProtoPathsCache();
});

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * readBufConfig
 * ------------------------------------------------------------------ */

describe("readBufConfig", () => {
	test("reads a v2 file with several modules", () => {
		const config = readBufConfig(`version: v2
modules:
  - path: protobuf
    name: buf.build/acme/core
  - path: vendor/third-party
    name: buf.build/acme/vendor
deps:
  - buf.build/bufbuild/protovalidate
  - buf.build/googleapis/googleapis
breaking:
  use:
    - FILE
    - PACKAGE
`);
		expect(config.version).toBe("v2");
		expect(config.modules).toEqual([
			{ path: "protobuf", name: "buf.build/acme/core" },
			{ path: "vendor/third-party", name: "buf.build/acme/vendor" },
		]);
		expect(config.deps).toEqual([
			"buf.build/bufbuild/protovalidate",
			"buf.build/googleapis/googleapis",
		]);
		expect(config.breaking?.use).toEqual(["FILE", "PACKAGE"]);
	});

	test("leaves modules empty when the file declares none", () => {
		const config = readBufConfig(`version: v1
name: buf.build/acme/core
deps:
  - buf.build/googleapis/googleapis
`);
		expect(config.version).toBe("v1");
		expect(config.modules).toEqual([]);
		expect(config.deps).toEqual(["buf.build/googleapis/googleapis"]);
		expect(config.breaking).toBeUndefined();
	});

	test("defaults a module's path to the config's own directory", () => {
		const config = readBufConfig(`version: v2
modules:
  - name: buf.build/acme/core
`);
		expect(config.modules).toEqual([
			{ path: ".", name: "buf.build/acme/core" },
		]);
	});

	test("leaves an unnamed module's name empty", () => {
		const config = readBufConfig("version: v2\nmodules:\n  - path: proto\n");
		expect(config.modules).toEqual([{ path: "proto", name: "" }]);
	});

	test("drops entries of the wrong shape", () => {
		const config = readBufConfig(`version: v2
modules:
  - proto
  - null
  - path: real
deps:
  - buf.build/acme/one
  - 7
breaking:
  use: FILE
`);
		expect(config.modules).toEqual([{ path: "real", name: "" }]);
		expect(config.deps).toEqual(["buf.build/acme/one"]);
		// `use` is a scalar rather than a list, so nothing is carried over.
		expect(config.breaking).toBeUndefined();
	});

	test("returns an empty config for malformed YAML rather than throwing", () => {
		const config = readBufConfig("version: v2\nmodules: [ - broken: : :\n");
		expect(config).toEqual({ modules: [], deps: [] });
	});

	test("returns an empty config for empty input", () => {
		expect(readBufConfig("")).toEqual({ modules: [], deps: [] });
	});

	test("ignores a document that is not a mapping", () => {
		expect(readBufConfig("- one\n- two\n")).toEqual({ modules: [], deps: [] });
		expect(readBufConfig("just a string")).toEqual({ modules: [], deps: [] });
	});

	test("ignores a non-string version", () => {
		expect(readBufConfig("version: 2\n").version).toBeUndefined();
	});
});

/* ------------------------------------------------------------------ *
 * readBufModuleRoots
 * ------------------------------------------------------------------ */

describe("readBufModuleRoots", () => {
	test("resolves each v2 module path against the config's directory", () => {
		expect(
			readBufModuleRoots(
				"version: v2\nmodules:\n  - path: a\n  - path: b/c\n",
				"/repo",
			),
		).toEqual([path.resolve("/repo/a"), path.resolve("/repo/b/c")]);
	});

	test("falls back to the config's own directory for a v1 module", () => {
		expect(readBufModuleRoots("version: v1\n", "/repo")).toEqual(["/repo"]);
	});

	test("reads v1beta1 build roots", () => {
		expect(
			readBufModuleRoots(
				"version: v1beta1\nbuild:\n  roots:\n    - proto\n    - vendor\n",
				"/repo",
			),
		).toEqual([path.resolve("/repo/proto"), path.resolve("/repo/vendor")]);
	});

	test("normalises a path that climbs out of the directory", () => {
		expect(
			readBufModuleRoots("version: v2\nmodules:\n  - path: ../shared\n", "/repo/sub"),
		).toEqual([path.resolve("/repo/shared")]);
	});

	test("degrades to the config's directory when the YAML is malformed", () => {
		expect(readBufModuleRoots("modules: [ : :\n", "/repo")).toEqual(["/repo"]);
	});
});

/* ------------------------------------------------------------------ *
 * Proto paths, delegated to the module graph
 * ------------------------------------------------------------------ */

describe("proto path resolution", () => {
	test("returns the module root for a single-module workspace", async () => {
		const root = makeTree({
			"buf.yaml": "version: v1\nname: buf.build/acme/core\n",
			"acme/v1/service.proto": 'syntax = "proto3";\n',
		});
		useWorkspace(root);

		expect(await getBufProtoPaths()).toEqual([root]);
		expect(
			await getBufProtoPathsForFile(path.join(root, "acme/v1/service.proto")),
		).toEqual([root]);
	});

	test("returns nothing for a file outside every module", async () => {
		const root = makeTree({
			"module/buf.yaml": "version: v1\n",
			"module/acme/v1/a.proto": "",
			"outside/b.proto": "",
		});
		useWorkspace(root);

		expect(
			await getBufProtoPathsForFile(path.join(root, "outside/b.proto")),
		).toEqual([]);
	});

	test("resolves a relative path the same as its absolute form", async () => {
		const root = makeTree({
			"buf.yaml": "version: v1\n",
			"a/v1/a.proto": "",
		});
		useWorkspace(root);

		const absolute = await getBufProtoPathsForFile(
			path.join(root, "a/v1/a.proto"),
		);
		const messy = await getBufProtoPathsForFile(
			path.join(root, "a", "..", "a", "v1", "a.proto"),
		);
		expect(messy).toEqual(absolute);
	});

	test("finds the workspace-root buf.yaml as the primary config", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: proto\n",
			"proto/acme/v1/a.proto": "",
			"nested/deep/buf.yaml": "version: v1\n",
			"nested/deep/b.proto": "",
		});
		useWorkspace(root);

		const found = await findBufConfig();
		expect(found?.fsPath).toBe(path.join(root, "buf.yaml"));
	});

	test("returns null when the workspace has no buf.yaml", async () => {
		const root = makeTree({ "a/v1/a.proto": "" });
		useWorkspace(root);

		expect(await findBufConfig()).toBeNull();
		expect(await getBufProtoPaths()).toEqual([]);
	});

	test("returns nothing when no workspace folder is open", async () => {
		workspace.workspaceFolders = undefined;
		expect(await getBufProtoPaths()).toEqual([]);
		expect(await findBufConfig()).toBeNull();
	});

	test("picks up an edited buf.yaml only after invalidation", async () => {
		const root = makeTree({
			"buf.yaml": "version: v2\nmodules:\n  - path: first\n",
			"first/a.proto": "",
			"second/b.proto": "",
		});
		useWorkspace(root);

		expect(await getBufProtoPaths()).toEqual([path.join(root, "first")]);

		fs.writeFileSync(
			path.join(root, "buf.yaml"),
			"version: v2\nmodules:\n  - path: second\n",
		);
		// Inside the fast window the cached graph is served without re-stamping.
		expect(await getBufProtoPaths()).toEqual([path.join(root, "first")]);

		invalidateBufProtoPathsCache();
		expect(await getBufProtoPaths()).toEqual([path.join(root, "second")]);
	});
});

describe("cleanupAllBufTmpDirs", () => {
	test("is a no-op that neither throws nor touches the filesystem", () => {
		const root = makeTree({ "buf.yaml": "version: v1\n", "a/v1/a.proto": "" });
		expect(() => cleanupAllBufTmpDirs()).not.toThrow();
		expect(cleanupAllBufTmpDirs()).toBeUndefined();
		expect(fs.existsSync(path.join(root, "buf.yaml"))).toBe(true);
		expect(fs.existsSync(path.join(root, "a/v1/a.proto"))).toBe(true);
	});
});
