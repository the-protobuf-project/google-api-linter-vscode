/**
 * Tests for `buf.gen.yaml` parsing and discovery.
 *
 * Nothing else in the extension reads this file, so these tests are the whole
 * specification for it. Two properties matter more than the happy path. The
 * parser must flatten v1 and v2 onto one shape — v2 states where a plugin runs,
 * v1 only names it — and it must degrade rather than throw, because a template
 * being edited spends most of its life syntactically invalid and the panel
 * still has to render.
 *
 * Discovery uses real directories: the behaviour under test is which files on
 * disk count as a template.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findGenConfigs, parseBufGenYaml } from "../../../deps/bufGen";

const tempRoots: string[] = [];

/** A real directory tree, described as relative path → file contents. */
function makeTree(files: Record<string, string>): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "buf-gen-")),
	);
	tempRoots.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = path.join(root, relative);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
	}
	return root;
}

afterAll(() => {
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * v2
 * ------------------------------------------------------------------ */

describe("parseBufGenYaml, v2", () => {
	test("reads remote, local and protoc_builtin plugins", () => {
		const config = parseBufGenYaml(
			`version: v2
managed:
  enabled: true
plugins:
  - remote: buf.build/protocolbuffers/go
    out: gen/go
    opt: paths=source_relative
    revision: 1
  - local: protoc-gen-validate
    out: gen/validate
  - protoc_builtin: java
    out: gen/java
`,
			"/repo/buf.gen.yaml",
		);
		expect(config.path).toBe("/repo/buf.gen.yaml");
		expect(config.version).toBe("v2");
		expect(config.managed).toBe(true);
		expect(config.plugins).toEqual([
			{
				ref: "buf.build/protocolbuffers/go",
				kind: "remote",
				out: "gen/go",
				opt: ["paths=source_relative"],
				revision: 1,
			},
			{
				ref: "protoc-gen-validate",
				kind: "local",
				out: "gen/validate",
				opt: [],
				revision: undefined,
			},
			{
				ref: "java",
				kind: "protoc_builtin",
				out: "gen/java",
				opt: [],
				revision: undefined,
			},
		]);
	});

	test("joins an argv-style local plugin back into a command line", () => {
		const config = parseBufGenYaml(
			`version: v2
plugins:
  - local: ["go", "run", "./cmd/protoc-gen-x"]
    out: gen
`,
			"/repo/buf.gen.yaml",
		);
		expect(config.plugins[0]?.ref).toBe("go run ./cmd/protoc-gen-x");
		expect(config.plugins[0]?.kind).toBe("local");
	});

	test("reports managed generation off when the block is absent or false", () => {
		expect(parseBufGenYaml("version: v2\n", "/f").managed).toBe(false);
		expect(
			parseBufGenYaml("version: v2\nmanaged:\n  enabled: false\n", "/f")
				.managed,
		).toBe(false);
		// `managed:` with no `enabled:` is not an opt-in.
		expect(
			parseBufGenYaml("version: v2\nmanaged:\n  disable:\n    - x\n", "/f")
				.managed,
		).toBe(false);
	});
});

/* ------------------------------------------------------------------ *
 * v1
 * ------------------------------------------------------------------ */

describe("parseBufGenYaml, v1", () => {
	test("infers the kind of a `plugin:` entry from its name", () => {
		const config = parseBufGenYaml(
			`version: v1
plugins:
  - plugin: buf.build/protocolbuffers/go
    out: gen/go
  - plugin: python
    out: gen/py
  - plugin: connect-go
    out: gen/connect
`,
			"/repo/buf.gen.yaml",
		);
		expect(config.version).toBe("v1");
		expect(config.plugins.map((p) => [p.ref, p.kind])).toEqual([
			["buf.build/protocolbuffers/go", "remote"],
			["python", "protoc_builtin"],
			["connect-go", "local"],
		]);
	});

	test("accepts the older `name:` spelling", () => {
		const config = parseBufGenYaml(
			"version: v1\nplugins:\n  - name: go\n    out: gen/go\n",
			"/f",
		);
		expect(config.plugins).toEqual([
			{ ref: "go", kind: "local", out: "gen/go", opt: [], revision: undefined },
		]);
	});

	test("reads a v1 `remote:` entry as a remote plugin", () => {
		const config = parseBufGenYaml(
			"version: v1\nplugins:\n  - remote: buf.build/acme/plugins/go:v1\n",
			"/f",
		);
		expect(config.plugins[0]).toMatchObject({
			ref: "buf.build/acme/plugins/go:v1",
			kind: "remote",
			out: "",
		});
	});
});

/* ------------------------------------------------------------------ *
 * opt, revision and degradation
 * ------------------------------------------------------------------ */

describe("parseBufGenYaml, normalisation", () => {
	test("normalises a scalar opt and a list opt to the same shape", () => {
		const scalar = parseBufGenYaml(
			"version: v2\nplugins:\n  - local: p\n    opt: paths=source_relative\n",
			"/f",
		);
		const list = parseBufGenYaml(
			`version: v2
plugins:
  - local: p
    opt:
      - paths=source_relative
      - require_unimplemented_servers=false
`,
			"/f",
		);
		expect(scalar.plugins[0]?.opt).toEqual(["paths=source_relative"]);
		expect(list.plugins[0]?.opt).toEqual([
			"paths=source_relative",
			"require_unimplemented_servers=false",
		]);
	});

	test("drops non-string opt values and an empty scalar", () => {
		expect(
			parseBufGenYaml(
				"version: v2\nplugins:\n  - local: p\n    opt: [a=1, 7, null, b=2]\n",
				"/f",
			).plugins[0]?.opt,
		).toEqual(["a=1", "b=2"]);
		expect(
			parseBufGenYaml(
				'version: v2\nplugins:\n  - local: p\n    opt: ""\n',
				"/f",
			).plugins[0]?.opt,
		).toEqual([]);
	});

	test("keeps a revision written as a string and rejects nonsense", () => {
		const read = (revision: string): number | undefined =>
			parseBufGenYaml(
				`version: v2\nplugins:\n  - remote: r\n    revision: ${revision}\n`,
				"/f",
			).plugins[0]?.revision;
		expect(read("3")).toBe(3);
		expect(read('"4"')).toBe(4);
		expect(read("1.5")).toBeUndefined();
		expect(read("-1")).toBeUndefined();
		expect(read("latest")).toBeUndefined();
	});

	test("skips entries that name no plugin at all", () => {
		const config = parseBufGenYaml(
			`version: v2
plugins:
  - out: gen/orphan
  - null
  - just-a-string
  - local: real
    out: gen/real
`,
			"/f",
		);
		expect(config.plugins.map((p) => p.ref)).toEqual(["real"]);
	});

	test("returns an empty config for malformed YAML rather than throwing", () => {
		const config = parseBufGenYaml("version: v2\nplugins: [ - : :\n", "/f");
		expect(config).toEqual({
			path: "/f",
			version: "",
			managed: false,
			plugins: [],
		});
	});

	test("reports an empty version for a document that is not a mapping", () => {
		expect(parseBufGenYaml("- one\n- two\n", "/f").version).toBe("");
		expect(parseBufGenYaml("", "/f").version).toBe("");
	});

	test("assumes v1 when a mapping omits the version", () => {
		const config = parseBufGenYaml(
			"plugins:\n  - name: go\n    out: g\n",
			"/f",
		);
		expect(config.version).toBe("v1");
		expect(config.plugins).toHaveLength(1);
	});

	test("ignores a plugins key that is not a list", () => {
		expect(parseBufGenYaml("version: v2\nplugins: go\n", "/f").plugins).toEqual(
			[],
		);
	});
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

describe("findGenConfigs", () => {
	test("finds templates beside a module and ignores unrelated yaml", () => {
		const root = makeTree({
			"buf.yaml": "version: v2\n",
			"buf.gen.yaml": "version: v2\nplugins:\n  - local: a\n",
			"buf.gen.go.yaml": "version: v2\nplugins:\n  - local: b\n",
			"buf.work.yaml": "version: v1\n",
			"other.yaml": "version: v2\n",
		});
		return findGenConfigs([root]).then((configs) => {
			expect(configs.map((c) => path.basename(c.path))).toEqual([
				"buf.gen.go.yaml",
				"buf.gen.yaml",
			]);
			expect(configs[1]?.plugins[0]?.ref).toBe("a");
		});
	});

	test("collapses duplicate and unreadable directories", async () => {
		const root = makeTree({ "buf.gen.yaml": "version: v2\n" });
		const configs = await findGenConfigs([
			root,
			root,
			path.join(root, "nope"),
			path.join(root, ".", ""),
		]);
		expect(configs).toHaveLength(1);
	});

	test("does not descend into subdirectories", async () => {
		const root = makeTree({
			"buf.gen.yaml": "version: v2\n",
			"nested/buf.gen.yaml": "version: v2\n",
		});
		const configs = await findGenConfigs([root]);
		expect(configs.map((c) => c.path)).toEqual([
			path.join(root, "buf.gen.yaml"),
		]);
	});

	test("honours the cancellation hook and the ceiling", async () => {
		const root = makeTree({ "buf.gen.yaml": "version: v2\n" });
		expect(await findGenConfigs([root], { isCancelled: () => true })).toEqual(
			[],
		);
		expect(await findGenConfigs([root], { maxConfigs: 0 })).toEqual([]);
	});

	test("returns nothing when no directory holds a template", async () => {
		const root = makeTree({ "buf.yaml": "version: v2\n" });
		expect(await findGenConfigs([root])).toEqual([]);
		expect(await findGenConfigs([])).toEqual([]);
	});
});
