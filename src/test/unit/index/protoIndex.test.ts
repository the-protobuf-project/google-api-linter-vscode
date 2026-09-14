/**
 * Tests for `ProtoIndexImpl`, the workspace index that replaced one open
 * `TextDocument` per `.proto` — about 60 GB on protobuf-fhir — with a few tens
 * of megabytes of interned, columnar data.
 *
 * Three properties are what that rewrite bought, and each is pinned here.
 *
 *  1. **Keys are fully qualified.** The reference corpus declares
 *     `SubjectChoice` 87 times in 87 different packages. Simple-name matching is
 *     what made one rename rewrite 154 files, so `symbol` and `referencesTo`
 *     must answer for exactly one of those and never for its namesakes. A
 *     reference that could mean two imported types resolves to neither.
 *  2. **Updates are surgical.** `update` and `remove` patch one file's slice:
 *     no stale symbol survives, no reference is counted twice, and a freed file
 *     id is handed out again without carrying its predecessor's rows.
 *  3. **The ladder is bounded and loud.** Tier choice happens against the
 *     injected budget — the `gapi.index.maxMemoryMB` and `gapi.index.maxFiles`
 *     settings — before a byte is read, and every degrade names the limit it hit
 *     and what it switched off. Nothing here allocates memory to force a rung.
 *
 * Fixtures are written to real temp directories because the index reads through
 * node `fs`; the reference corpus is used once, for scale and for the name
 * collisions no hand-written fixture would reproduce honestly.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createProtoIndex,
	DEFAULT_INDEX_BUDGET,
	ProtoIndexImpl,
	type ProtoIndexOptions,
} from "../../../index/protoIndex";
import type { IndexStats } from "../../../index/types";
import { hasReferenceCorpus, REFERENCE_PROTO_ROOT } from "../support/fixtures";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const tempRoots: string[] = [];
const liveIndexes: ProtoIndexImpl[] = [];

afterAll(() => {
	for (const index of liveIndexes) {
		index.dispose();
	}
	for (const root of tempRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/** Writes one `.proto` into a workspace, creating directories as needed. */
function writeProto(root: string, relative: string, text: string): string {
	const full = path.join(root, relative);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, text);
	return full;
}

/**
 * A fresh temp directory holding the given files.
 *
 * The index reads from disk, so fixtures have to exist on disk; the directory
 * is removed when the file finishes.
 */
function workspace(files: Record<string, string> = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "proto-index-"));
	tempRoots.push(root);
	for (const [relative, text] of Object.entries(files)) {
		writeProto(root, relative, text);
	}
	return root;
}

/** An index that will be disposed when the file finishes. */
function newIndex(options: ProtoIndexOptions = {}): ProtoIndexImpl {
	const index = new ProtoIndexImpl(options);
	liveIndexes.push(index);
	return index;
}

/** A workspace and an index already built over it. */
async function built(
	files: Record<string, string>,
	options: ProtoIndexOptions = {},
): Promise<{ root: string; index: ProtoIndexImpl; stats: IndexStats }> {
	const root = workspace(files);
	const index = newIndex(options);
	const stats = await index.build([root]);
	return { root, index, stats };
}

/** File id for a path, failing loudly rather than yielding `undefined`. */
function fileIdOf(index: ProtoIndexImpl, absolutePath: string): number {
	const file = index.fileByPath(absolutePath);
	if (!file) {
		throw new Error(`not indexed: ${absolutePath}`);
	}
	return file.id;
}

/** Declarations in one file, as `kind fqn`, in source order. */
function shapeOf(index: ProtoIndexImpl, absolutePath: string): string[] {
	return index
		.symbolsInFile(fileIdOf(index, absolutePath))
		.map((symbol) => `${symbol.kind} ${symbol.fqn}`);
}

/**
 * A small workspace with the shape that matters: one type used from another
 * package, a nested type, and the same declarations repeated verbatim under a
 * second version, which is exactly the protobuf-fhir layout that broke rename.
 */
const DEMO: Record<string, string> = {
	"a/v1/patient.proto": `syntax = "proto3";

package demo.a.v1;

import "b/v1/common.proto";

// Patient is a person receiving care.
message Patient {
  // Logical identifier.
  string id = 1;
  demo.b.v1.Address address = 2;
  Address home = 3;
  .demo.b.v1.Address billing = 4;
  Contact primary = 5;

  message Contact {
    string name = 1;
  }

  enum Status {
    STATUS_UNSPECIFIED = 0;
    STATUS_ACTIVE = 1;
  }
}

message GetPatientRequest {
  string id = 1;
}

service PatientService {
  rpc GetPatient(GetPatientRequest) returns (Patient);
}
`,
	"a/v2/patient.proto": `syntax = "proto3";

package demo.a.v2;

message Patient {
  string id = 1;
}

message GetPatientRequest {
  string id = 1;
}

service PatientService {
  rpc GetPatient(GetPatientRequest) returns (Patient);
}
`,
	"b/v1/common.proto": `syntax = "proto3";

package demo.b.v1;

message Address {
  string line = 1;
}
`,
};

let demoRoot: string;
let demo: ProtoIndexImpl;

beforeAll(async () => {
	const result = await built(DEMO);
	demoRoot = result.root;
	demo = result.index;
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("build", () => {
	test("reports counts, bytes and the tier it settled on", () => {
		const stats = demo.stats();
		expect(stats.tier).toBe("full");
		expect(stats.degradeReason).toBeUndefined();
		expect(stats.fileCount).toBe(3);
		// 15 declarations in a/v1 (enumerated in the next test), 6 in a/v2 and 2 in
		// b/v1. Members count: the full tier keeps fields, enum values and rpcs.
		expect(stats.symbolCount).toBe(23);
		expect(stats.annotationCount).toBe(0);
		expect(stats.bytesRead).toBe(
			Object.values(DEMO).reduce((sum, text) => sum + text.length, 0),
		);
		expect(stats.buildMs).toBeGreaterThanOrEqual(0);
	});

	test("records every declaration under its file's package", () => {
		expect(shapeOf(demo, path.join(demoRoot, "a/v1/patient.proto"))).toEqual([
			"message demo.a.v1.Patient",
			"field demo.a.v1.Patient.id",
			"field demo.a.v1.Patient.address",
			"field demo.a.v1.Patient.home",
			"field demo.a.v1.Patient.billing",
			"field demo.a.v1.Patient.primary",
			"message demo.a.v1.Patient.Contact",
			"field demo.a.v1.Patient.Contact.name",
			"enum demo.a.v1.Patient.Status",
			"enumValue demo.a.v1.Patient.Status.STATUS_UNSPECIFIED",
			"enumValue demo.a.v1.Patient.Status.STATUS_ACTIVE",
			"message demo.a.v1.GetPatientRequest",
			"field demo.a.v1.GetPatientRequest.id",
			"service demo.a.v1.PatientService",
			"rpc demo.a.v1.PatientService.GetPatient",
		]);
	});

	test("indexes an empty directory without degrading", async () => {
		const { stats, index } = await built({});
		expect(stats).toMatchObject({
			tier: "full",
			fileCount: 0,
			symbolCount: 0,
			bytesRead: 0,
		});
		expect(stats.degradeReason).toBeUndefined();
		expect(index.files()).toEqual([]);
		expect(index.searchSymbols("")).toEqual([]);
	});

	test("treats a root that does not exist as empty", async () => {
		const index = newIndex();
		const stats = await index.build([
			path.join(os.tmpdir(), "proto-index-absent-root"),
		]);
		expect(stats.fileCount).toBe(0);
	});

	test("visits a file once when the roots overlap", async () => {
		// Two roots where one contains the other is the normal multi-folder
		// workspace shape; double-indexing would double every symbol.
		const root = workspace(DEMO);
		const index = newIndex();
		const stats = await index.build([root, path.join(root, "a")]);
		expect(stats.fileCount).toBe(3);
		// `searchSymbols` matches members too, so the field `address` is a legitimate
		// hit alongside the message; what matters here is that each appears exactly
		// once. Double-indexing `a/v1/patient.proto` would give four rows, not two.
		expect(
			index
				.searchSymbols("Address")
				.map((s) => s.fqn)
				.sort(),
		).toEqual(["demo.a.v1.Patient.address", "demo.b.v1.Address"]);
		expect(index.stats().symbolCount).toBe(23);
	});

	test("replaces prior contents rather than adding to them", async () => {
		const root = workspace(DEMO);
		const index = newIndex();
		const first = await index.build([root]);
		const second = await index.build([root]);
		expect(second.fileCount).toBe(first.fileCount);
		expect(second.symbolCount).toBe(first.symbolCount);
		expect(index.referencesTo("demo.b.v1.Address")).toHaveLength(3);
	});

	test("answers empty before it has been built", () => {
		// `gapi.index.enabled: false` makes the extension skip construction
		// altogether, so the nearest observable state here is an index nobody has
		// built: every query is empty, none of them throws.
		const index = createProtoIndex();
		expect(index.stats()).toMatchObject({
			tier: "full",
			fileCount: 0,
			symbolCount: 0,
			buildMs: 0,
		});
		expect(index.files()).toEqual([]);
		expect(index.symbol("demo.a.v1.Patient")).toBeUndefined();
		expect(index.referencesTo("demo.a.v1.Patient")).toEqual([]);
		expect(index.searchSymbols("Patient")).toEqual([]);
		index.dispose();
	});
});

describe("files", () => {
	test("reports the package, imports and mtime of a file", () => {
		const abs = path.join(demoRoot, "a/v1/patient.proto");
		const file = demo.fileByPath(abs);
		expect(file).toMatchObject({
			path: abs,
			packageName: "demo.a.v1",
			imports: ["b/v1/common.proto"],
			mtimeMs: fs.statSync(abs).mtimeMs,
		});
		expect(file?.moduleRoot).toBeUndefined();
	});

	test("looks a file up by a path that needs resolving", () => {
		const abs = path.join(demoRoot, "a/v1/patient.proto");
		const indirect = path.join(
			demoRoot,
			"a",
			"v1",
			"..",
			"v1",
			"patient.proto",
		);
		expect(demo.fileByPath(indirect)?.id).toBe(fileIdOf(demo, abs));
	});

	test("round-trips ids through file() and files()", () => {
		const all = demo.files();
		expect(all).toHaveLength(3);
		for (const file of all) {
			expect(demo.file(file.id)).toMatchObject({ path: file.path });
		}
		expect(
			all
				.map((file) =>
					path.relative(demoRoot, file.path).split(path.sep).join("/"),
				)
				.sort(),
		).toEqual([
			"a/v1/patient.proto",
			"a/v2/patient.proto",
			"b/v1/common.proto",
		]);
	});

	test("returns undefined for an id nobody handed out", () => {
		expect(demo.file(-1)).toBeUndefined();
		expect(demo.file(9999)).toBeUndefined();
		expect(demo.fileByPath(path.join(demoRoot, "nope.proto"))).toBeUndefined();
	});

	test("supplies moduleRoot from the module graph when one is wired in", async () => {
		const root = workspace(DEMO);
		const index = newIndex({ moduleRootOf: () => "/modules/demo" });
		await index.build([root]);
		expect(index.files().every((f) => f.moduleRoot === "/modules/demo")).toBe(
			true,
		);
	});

	test("indexes a file that declares no package", async () => {
		const { index, root } = await built({
			"loose.proto": `syntax = "proto3";

message Loose {
  string a = 1;
}
`,
		});
		const abs = path.join(root, "loose.proto");
		expect(index.fileByPath(abs)?.packageName).toBe("");
		expect(shapeOf(index, abs)).toEqual(["message Loose", "field Loose.a"]);
		expect(index.symbol("Loose")).toMatchObject({
			fqn: "Loose",
			name: "Loose",
		});
		expect(index.symbol("Loose")?.parentFqn).toBeUndefined();
	});
});

describe("fully-qualified lookup", () => {
	test("finds a top-level declaration by its exact fqn", () => {
		expect(demo.symbol("demo.a.v1.Patient")).toMatchObject({
			fqn: "demo.a.v1.Patient",
			name: "Patient",
			kind: "message",
			line: 7,
			startCol: 8,
			endCol: 15,
			doc: "Patient is a person receiving care.",
		});
		expect(demo.symbol("demo.a.v1.Patient")?.parentFqn).toBeUndefined();
	});

	test("does not answer for a bare name", () => {
		// The whole point: `Patient` alone is ambiguous across v1 and v2, so it
		// names nothing. Rename asks by fqn or it does not ask.
		expect(demo.symbol("Patient")).toBeUndefined();
		expect(demo.symbol("Address")).toBeUndefined();
	});

	test("keeps identical declarations in two versions apart", () => {
		const v1 = demo.symbol("demo.a.v1.Patient");
		const v2 = demo.symbol("demo.a.v2.Patient");
		expect(v1).toBeDefined();
		expect(v2).toBeDefined();
		expect(v1?.fileId).not.toBe(v2?.fileId);
	});

	test("finds a nested type and reports its parent", () => {
		expect(demo.symbol("demo.a.v1.Patient.Contact")).toMatchObject({
			kind: "message",
			parentFqn: "demo.a.v1.Patient",
		});
		expect(demo.symbol("demo.a.v1.Patient.Status")).toMatchObject({
			kind: "enum",
			parentFqn: "demo.a.v1.Patient",
		});
	});

	test("finds members through their container", () => {
		// Fields, enum values and rpcs are not in the fqn map; they are reached
		// from the container, which is. Go to Definition on a field depends on it.
		expect(demo.symbol("demo.a.v1.Patient.id")).toMatchObject({
			kind: "field",
			detail: "string",
			doc: "Logical identifier.",
		});
		expect(demo.symbol("demo.a.v1.Patient.Status.STATUS_ACTIVE")).toMatchObject(
			{
				kind: "enumValue",
			},
		);
		expect(demo.symbol("demo.a.v1.PatientService.GetPatient")).toMatchObject({
			kind: "rpc",
			detail: "(GetPatientRequest) returns (Patient)",
		});
	});

	test("does not find a member under the wrong container", () => {
		expect(
			demo.symbol("demo.a.v2.Patient.Status.STATUS_ACTIVE"),
		).toBeUndefined();
		expect(demo.symbol("demo.a.v1.GetPatientRequest.name")).toBeUndefined();
		expect(demo.symbol("demo.a.v1.Nothing")).toBeUndefined();
		expect(demo.symbol("")).toBeUndefined();
	});

	test("lists declarations in one file and nothing for an unknown id", () => {
		expect(shapeOf(demo, path.join(demoRoot, "b/v1/common.proto"))).toEqual([
			"message demo.b.v1.Address",
			"field demo.b.v1.Address.line",
		]);
		expect(demo.symbolsInFile(4242)).toEqual([]);
	});
});

describe("reference resolution", () => {
	test("resolves a package-qualified, an unqualified and a dotted use to one type", () => {
		// The three spellings of the same cross-package reference. The leading-dot
		// form is the one that used to be dropped silently.
		const refs = demo.referencesTo("demo.b.v1.Address");
		expect(refs.map((r) => r.typeName).sort()).toEqual([
			".demo.b.v1.Address",
			"Address",
			"demo.b.v1.Address",
		]);
		expect(refs.every((r) => r.resolvedFqn === "demo.b.v1.Address")).toBe(true);
		expect(
			refs.every(
				(r) =>
					demo.file(r.fileId)?.path ===
					path.join(demoRoot, "a/v1/patient.proto"),
			),
		).toBe(true);
	});

	test("reports the range of the type name, not of the field", () => {
		const refs = demo
			.referencesTo("demo.b.v1.Address")
			.filter((r) => r.typeName === "Address");
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({ line: 11, startCol: 2, endCol: 9 });
	});

	test("resolves a name to the version that declares it, never the other", () => {
		// Both patient.proto files contain the identical line
		// `rpc GetPatient(GetPatientRequest) returns (Patient);`. One reference
		// each, and neither leaks into the other version.
		const v1 = demo.referencesTo("demo.a.v1.Patient");
		const v2 = demo.referencesTo("demo.a.v2.Patient");
		expect(v1).toHaveLength(1);
		expect(v2).toHaveLength(1);
		expect(demo.file(v1[0].fileId)?.packageName).toBe("demo.a.v1");
		expect(demo.file(v2[0].fileId)?.packageName).toBe("demo.a.v2");
	});

	test("resolves a nested type from inside its container", () => {
		const refs = demo.referencesTo("demo.a.v1.Patient.Contact");
		expect(refs).toHaveLength(1);
		expect(refs[0].typeName).toBe("Contact");
	});

	test("returns nothing for an unknown fqn or a type nobody uses", () => {
		expect(demo.referencesTo("demo.a.v1.Nowhere")).toEqual([]);
		expect(demo.referencesTo("Patient")).toEqual([]);
		expect(demo.referencesTo("demo.a.v1.Patient.Status")).toEqual([]);
		// A service is a declaration, but no type reference can name one.
		expect(demo.referencesTo("demo.a.v1.PatientService")).toEqual([]);
	});

	test("refuses to guess when two imports could supply the name", async () => {
		const { index } = await built({
			"left/common.proto": `syntax = "proto3";

package demo.left;

message Address {
  string line = 1;
}
`,
			"right/common.proto": `syntax = "proto3";

package demo.right;

message Address {
  string line = 1;
}
`,
			"use.proto": `syntax = "proto3";

package demo.use;

import "left/common.proto";
import "right/common.proto";

message U {
  Address ambiguous = 1;
  demo.left.Address explicit = 2;
}
`,
		});
		// `Address` alone could be either import, so it resolves to neither and is
		// reported under neither fqn. Renaming one of them must not touch it.
		expect(
			index.referencesTo("demo.left.Address").map((r) => r.typeName),
		).toEqual(["demo.left.Address"]);
		expect(index.referencesTo("demo.right.Address")).toEqual([]);
	});

	test("matches an import by path suffix, not by basename", () => {
		// Both fixtures above are called `common.proto`; only the one whose path
		// ends with `left/common.proto` may satisfy that import.
		expect(demo.referencesTo("demo.b.v1.Address")).toHaveLength(3);
	});

	test("leaves a reference to a type nothing declares unresolved", async () => {
		const { index } = await built({
			"use.proto": `syntax = "proto3";

package demo.v1;

message U {
  Missing gone = 1;
}
`,
		});
		expect(index.referencesTo("demo.v1.Missing")).toEqual([]);
		expect(index.symbol("demo.v1.Missing")).toBeUndefined();
	});
});

describe("incremental update", () => {
	test("replaces a file's symbols and leaves none of the old ones", async () => {
		const { index, root } = await built({
			"a.proto": `syntax = "proto3";

package demo.v1;

message Old {
  string a = 1;
}
`,
		});
		const abs = path.join(root, "a.proto");
		expect(index.symbol("demo.v1.Old")).toBeDefined();

		writeProto(
			root,
			"a.proto",
			`syntax = "proto3";

package demo.v1;

message New {
  string b = 1;
}
`,
		);
		await index.update(abs);

		expect(index.symbol("demo.v1.Old")).toBeUndefined();
		expect(index.symbol("demo.v1.New")).toBeDefined();
		expect(index.searchSymbols("Old")).toEqual([]);
		expect(index.stats().fileCount).toBe(1);
		expect(shapeOf(index, abs)).toEqual([
			"message demo.v1.New",
			"field demo.v1.New.b",
		]);
	});

	test("re-indexing an unchanged file duplicates nothing", async () => {
		const { index, root } = await built(DEMO);
		const before = index.stats();
		await index.update(path.join(root, "a/v1/patient.proto"));
		expect(index.stats().fileCount).toBe(before.fileCount);
		expect(index.stats().symbolCount).toBe(before.symbolCount);
		// The three uses of `Address` must still be three, not six.
		expect(index.referencesTo("demo.b.v1.Address")).toHaveLength(3);
		expect(index.referencesTo("demo.a.v1.Patient")).toHaveLength(1);
		expect(
			index
				.searchSymbols("Patient")
				.filter((s) => s.fqn === "demo.a.v1.Patient"),
		).toHaveLength(1);
	});

	test("adds a file that was not there at build time", async () => {
		const { index, root } = await built({
			"a.proto": `syntax = "proto3";

package demo.v1;

message A {
  string a = 1;
}
`,
		});
		const abs = writeProto(
			root,
			"b.proto",
			`syntax = "proto3";

package demo.v1;

message B {
  A a = 1;
}
`,
		);
		await index.update(abs);
		expect(index.stats().fileCount).toBe(2);
		expect(index.symbol("demo.v1.B")).toBeDefined();
		expect(index.referencesTo("demo.v1.A")).toHaveLength(1);
	});

	test("resolves references that were waiting for a type to appear", async () => {
		const { index, root } = await built({
			"use.proto": `syntax = "proto3";

package demo.v1;

message U {
  Missing gone = 1;
}
`,
		});
		expect(index.referencesTo("demo.v1.Missing")).toEqual([]);

		const abs = writeProto(
			root,
			"types.proto",
			`syntax = "proto3";

package demo.v1;

message Missing {
  string a = 1;
}
`,
		);
		await index.update(abs);

		const refs = index.referencesTo("demo.v1.Missing");
		expect(refs).toHaveLength(1);
		expect(refs[0].typeName).toBe("Missing");
		expect(index.file(refs[0].fileId)?.path).toBe(path.join(root, "use.proto"));
	});

	test("unresolves references when the type they named goes away", async () => {
		const { index, root } = await built({
			"use.proto": `syntax = "proto3";

package demo.v1;

message U {
  Gone g = 1;
}
`,
			"types.proto": `syntax = "proto3";

package demo.v1;

message Gone {
  string a = 1;
}
`,
		});
		expect(index.referencesTo("demo.v1.Gone")).toHaveLength(1);

		index.remove(path.join(root, "types.proto"));

		expect(index.symbol("demo.v1.Gone")).toBeUndefined();
		expect(index.referencesTo("demo.v1.Gone")).toEqual([]);
		expect(index.stats().fileCount).toBe(1);
	});

	test("removes a file whose path has disappeared from disk", async () => {
		const { index, root } = await built({
			"a.proto": `syntax = "proto3";

package demo.v1;

message A {
  string a = 1;
}
`,
		});
		const abs = path.join(root, "a.proto");
		fs.rmSync(abs);
		await index.update(abs);
		expect(index.stats().fileCount).toBe(0);
		expect(index.symbol("demo.v1.A")).toBeUndefined();
	});

	test("ignores removal of a file that was never indexed", async () => {
		const { index, root } = await built(DEMO);
		let changes = 0;
		const subscription = index.onDidChange(() => {
			changes++;
		});
		index.remove(path.join(root, "never/seen.proto"));
		expect(changes).toBe(0);
		expect(index.stats().fileCount).toBe(3);
		subscription.dispose();
	});

	test("hands a freed file id back out with none of its old rows", async () => {
		const { index, root } = await built({
			"a.proto": `syntax = "proto3";

package demo.v1;

message A {
  string a = 1;
}
`,
			"b.proto": `syntax = "proto3";

package demo.v1;

message B {
  string b = 1;
}
`,
		});
		const abs = path.join(root, "a.proto");
		const freed = fileIdOf(index, abs);
		index.remove(abs);
		expect(index.file(freed)).toBeUndefined();
		expect(index.symbolsInFile(freed)).toEqual([]);

		const replacement = writeProto(
			root,
			"c.proto",
			`syntax = "proto3";

package demo.v1;

message C {
  string c = 1;
}
`,
		);
		await index.update(replacement);

		// Ids are recycled on purpose — the free list is what keeps the columns
		// from growing on every edit — so the reused id must describe the new file
		// only.
		expect(fileIdOf(index, replacement)).toBe(freed);
		expect(index.file(freed)?.path).toBe(replacement);
		expect(index.symbolsInFile(freed).map((s) => s.fqn)).toEqual([
			"demo.v1.C",
			"demo.v1.C.c",
		]);
		expect(index.stats().fileCount).toBe(2);
	});

	test("drops a package's last file without stranding its package bucket", async () => {
		const { index, root } = await built({
			"only.proto": `syntax = "proto3";

package demo.solo;

message Solo {
  string a = 1;
}
`,
		});
		index.remove(path.join(root, "only.proto"));
		expect(index.stats()).toMatchObject({ fileCount: 0, symbolCount: 0 });
		expect(index.files()).toEqual([]);
		expect(index.symbol("demo.solo.Solo")).toBeUndefined();
		expect(index.symbol("demo.solo.Solo.a")).toBeUndefined();
	});
});

describe("searchSymbols", () => {
	const NAMES: Record<string, string> = {
		"s.proto": `syntax = "proto3";

package demo.s;

message Patient {
  string a = 1;
}

message PatientRecord {
  string a = 1;
}

message XPatient {
  string a = 1;
}

message EmergencyPatient {
  string a = 1;
}
`,
	};

	let search: ProtoIndexImpl;

	beforeAll(async () => {
		search = (await built(NAMES)).index;
	});

	test("orders exact, then prefix, then the shortest containing name", () => {
		expect(
			search
				.searchSymbols("patient")
				.filter((s) => s.kind === "message")
				.map((s) => s.name),
		).toEqual(["Patient", "PatientRecord", "XPatient", "EmergencyPatient"]);
	});

	test("matches case-insensitively", () => {
		expect(search.searchSymbols("PATIENTREC").map((s) => s.name)).toEqual([
			"PatientRecord",
		]);
		expect(search.searchSymbols("  patient  ").map((s) => s.name)[0]).toBe(
			"Patient",
		);
	});

	test("honours the limit and keeps the best matches", () => {
		expect(search.searchSymbols("patient", 2).map((s) => s.name)).toEqual([
			"Patient",
			"PatientRecord",
		]);
		expect(search.searchSymbols("patient", 0)).toEqual([]);
		expect(search.searchSymbols("patient", 1000)).toHaveLength(4);
	});

	test("returns everything for an empty query, up to the limit", () => {
		// Go to Symbol opens with an empty box; it must list rather than refuse.
		expect(search.searchSymbols("")).toHaveLength(8);
		expect(search.searchSymbols("", 3)).toHaveLength(3);
	});

	test("returns nothing when nothing matches", () => {
		expect(search.searchSymbols("zzzz")).toEqual([]);
	});

	test("searches members as well as declarations", () => {
		expect(demo.searchSymbols("STATUS_ACTIVE").map((s) => s.fqn)).toEqual([
			"demo.a.v1.Patient.Status.STATUS_ACTIVE",
		]);
	});
});

describe("the memory ladder", () => {
	/** A proto big enough for the byte-based estimate to be the deciding term. */
	function bulkProto(pkg: string, fields: number): string {
		const body = Array.from(
			{ length: fields },
			(_, i) => `  string field_${i} = ${i + 1};`,
		).join("\n");
		return `syntax = "proto3";

package ${pkg};

// Bulk exists to put a predictable number of bytes on disk.
message Bulk {
${body}
}
`;
	}

	/**
	 * A workspace whose pre-flight estimate lands between the two rungs.
	 *
	 * Twelve bulk files are about 2.66 MB of proto, so a full index is estimated
	 * at 6.4 MB and a reduced one at 2.4 MB. Spreading the bytes over twelve files
	 * rather than one is deliberate: `checkMemory` re-reads real heap every 512
	 * files, so with fewer than that it fires exactly once, after the first file,
	 * and only that file's ~2 MB of read-and-parse churn is on the heap when it
	 * does. A single 2.66 MB file would blow any budget under the 6.4 MB estimate
	 * on transient garbage alone and knock the tier down a second rung.
	 */
	function bulkFiles(count: number): Record<string, string> {
		const files: Record<string, string> = {};
		for (let i = 0; i < count; i++) {
			files[`bulk_${i}.proto`] = bulkProto(`demo.bulk${i}`, 8000);
		}
		return files;
	}

	/** Between the 2.4 MB reduced estimate and the 6.4 MB full one. */
	const BETWEEN_RUNGS = { maxMemoryMB: 5, maxFiles: 100 };

	test("stays at the full tier under the default budget", () => {
		expect(DEFAULT_INDEX_BUDGET).toEqual({
			maxMemoryMB: 256,
			maxFiles: 20000,
		});
		expect(demo.stats().tier).toBe("full");
	});

	test("keeps indexing when the file count exactly meets the cap", async () => {
		const { stats } = await built(DEMO, {
			budget: { maxMemoryMB: 256, maxFiles: 3 },
		});
		expect(stats.tier).toBe("full");
		expect(stats.degradeReason).toBeUndefined();
	});

	test("switches workspace indexing off one file above the cap", async () => {
		const { stats, index } = await built(DEMO, {
			budget: { maxMemoryMB: 256, maxFiles: 2 },
		});
		expect(stats.tier).toBe("onDemand");
		expect(stats.degradeReason).toContain("3 .proto files");
		expect(stats.degradeReason).toContain("2-file index limit");
		expect(stats.degradeReason).toContain("workspace indexing is off");
		// Nothing was ingested, so every workspace query is empty rather than
		// half-populated.
		expect(stats.fileCount).toBe(0);
		expect(index.symbol("demo.a.v1.Patient")).toBeUndefined();
		expect(index.searchSymbols("Patient")).toEqual([]);
		expect(index.files()).toEqual([]);
	});

	test("a maxFiles of zero, the documented minimum, indexes nothing", async () => {
		const { stats } = await built(DEMO, {
			budget: { maxMemoryMB: 256, maxFiles: 0 },
		});
		expect(stats.tier).toBe("onDemand");
		expect(stats.degradeReason).toContain("0-file index limit");
	});

	test("drops to reduced when a full index would not fit", async () => {
		// A full index is estimated at 2.4x the text and a reduced one at 0.9x, so
		// a 5 MB ceiling over 2.66 MB of proto sits between the two rungs.
		// `concurrency: 1` pins the one heap checkpoint to a single file having
		// been read, so the rung is decided by the estimate and not by scheduling.
		const { stats, index, root } = await built(bulkFiles(12), {
			budget: BETWEEN_RUNGS,
			concurrency: 1,
		});
		expect(stats.tier).toBe("reduced");
		expect(stats.degradeReason).toContain("above the 5 MB limit");
		expect(stats.degradeReason).toContain(
			"indexing declarations only, without fields, enum values or doc comments",
		);
		// Every declaration survives; the 8,000 fields and the doc comment of each
		// do not, and that is the whole saving the rung buys.
		expect(stats.fileCount).toBe(12);
		expect(stats.symbolCount).toBe(12);
		expect(shapeOf(index, path.join(root, "bulk_0.proto"))).toEqual([
			"message demo.bulk0.Bulk",
		]);
		expect(index.symbol("demo.bulk0.Bulk")?.doc).toBeUndefined();
		expect(index.symbol("demo.bulk0.Bulk.field_0")).toBeUndefined();
	});

	test("drops to onDemand when even a reduced index would not fit", async () => {
		const { stats, index } = await built(
			{ "bulk.proto": bulkProto("demo.bulk", 8000) },
			{ budget: { maxMemoryMB: 0.05, maxFiles: 100 } },
		);
		expect(stats.tier).toBe("onDemand");
		expect(stats.degradeReason).toContain("even a reduced index");
		expect(stats.degradeReason).toContain("above the 0.05 MB limit");
		expect(stats.degradeReason).toContain("workspace indexing is off");
		expect(index.symbol("demo.bulk.Bulk")).toBeUndefined();
	});

	test("tells the host which rung it dropped to and why", async () => {
		const seen: { tier: string; reason: string }[] = [];
		await built(bulkFiles(12), {
			budget: BETWEEN_RUNGS,
			concurrency: 1,
			onDegrade: (tier, reason) => seen.push({ tier, reason }),
		});
		// One rung, reported once: a second callback would mean the mid-build heap
		// check had knocked it down again.
		expect(seen).toHaveLength(1);
		expect(seen[0].tier).toBe("reduced");
		// The user has to be able to act on it: the reason names the measurement,
		// the limit and the feature that was switched off.
		expect(seen[0].reason).toMatch(/2\.7 MB of proto in 12 files/);
		expect(seen[0].reason).toMatch(/5 MB limit/);
		expect(seen[0].reason).toMatch(/declarations only/);
	});

	test("does not report a degrade when nothing degraded", async () => {
		const seen: string[] = [];
		const { stats } = await built(DEMO, {
			onDegrade: (_tier, reason) => seen.push(reason),
		});
		expect(seen).toEqual([]);
		expect(stats.degradeReason).toBeUndefined();
	});

	test("an onDemand index ignores updates instead of half-indexing", async () => {
		const { index, root } = await built(DEMO, {
			budget: { maxMemoryMB: 256, maxFiles: 1 },
		});
		await index.update(path.join(root, "a/v1/patient.proto"));
		expect(index.stats().fileCount).toBe(0);
		expect(index.stats().tier).toBe("onDemand");
	});

	test("a rebuild starts again at the top of the ladder", async () => {
		const root = workspace(DEMO);
		const index = newIndex({ budget: { maxMemoryMB: 256, maxFiles: 2 } });
		expect((await index.build([root])).tier).toBe("onDemand");
		const generous = newIndex({ budget: DEFAULT_INDEX_BUDGET });
		const again = await generous.build([root]);
		expect(again.tier).toBe("full");
		expect(again.degradeReason).toBeUndefined();
	});
});

describe("annotations", () => {
	const OPTIONS: Record<string, string> = {
		"opt/v1/annotations.proto": `syntax = "proto3";

package demo.opt.v1;

import "google/protobuf/descriptor.proto";

// tool marks an rpc as callable by an agent.
extend google.protobuf.MethodOptions {
  optional ToolSpec tool = 50001;
}

message ToolSpec {
  string name = 1;
}
`,
	};

	test("derives a descriptor from the extend block during the same read", async () => {
		const { index, stats } = await built(OPTIONS);
		expect(stats.annotationCount).toBe(1);
		const [descriptor] = index.annotations().all();
		expect(descriptor).toMatchObject({
			fqn: "demo.opt.v1.tool",
			name: "tool",
			namespace: "demo.opt.v1",
			target: "Method",
			type: "ToolSpec",
			number: 50001,
		});
		expect(index.annotations().get("demo.opt.v1.tool")).toBeDefined();
	});

	test("records the extend itself as a symbol", async () => {
		const { index, root } = await built(OPTIONS);
		expect(
			shapeOf(index, path.join(root, "opt/v1/annotations.proto")),
		).toContain("extend demo.opt.v1.MethodOptions");
	});

	test("scans nothing when annotation scanning is switched off", async () => {
		const { index, stats } = await built(OPTIONS, { scanAnnotations: false });
		expect(stats.annotationCount).toBe(0);
		expect(index.annotations().all()).toEqual([]);
	});

	test("forgets a removed file's annotations", async () => {
		const { index, root } = await built(OPTIONS);
		index.remove(path.join(root, "opt/v1/annotations.proto"));
		expect(index.annotations().all()).toEqual([]);
		expect(index.stats().annotationCount).toBe(0);
	});

	test("holds no annotations for a workspace with no custom options", () => {
		expect(demo.annotations().all()).toEqual([]);
	});
});

describe("change notification", () => {
	test("fires on build, update and removal, and stops on dispose", async () => {
		const root = workspace({
			"a.proto": `syntax = "proto3";

package demo.v1;

message A {
  string a = 1;
}
`,
		});
		const index = newIndex();
		let changes = 0;
		const subscription = index.onDidChange(() => {
			changes++;
		});

		await index.build([root]);
		expect(changes).toBe(1);
		await index.update(path.join(root, "a.proto"));
		expect(changes).toBe(2);
		index.remove(path.join(root, "a.proto"));
		expect(changes).toBe(3);

		subscription.dispose();
		await index.build([root]);
		expect(changes).toBe(3);
	});

	test("dispose empties the index and drops its listeners", async () => {
		const { index, root } = await built(DEMO);
		let changes = 0;
		index.onDidChange(() => {
			changes++;
		});
		index.dispose();
		expect(index.stats()).toMatchObject({ fileCount: 0, symbolCount: 0 });
		expect(index.symbol("demo.a.v1.Patient")).toBeUndefined();
		expect(index.files()).toEqual([]);
		// A disposed index refuses further work rather than resurrecting itself.
		await index.update(path.join(root, "a/v1/patient.proto"));
		expect(index.stats().fileCount).toBe(0);
		expect(changes).toBe(0);
	});
});

describe.skipIf(!hasReferenceCorpus())("against the real corpus", () => {
	/** One version's `SubjectChoice`, out of the 87 the corpus declares. */
	const SUBJECT_CHOICE =
		"protobuf.fhir.financial.general.v5.types.SubjectChoice";

	let corpus: ProtoIndexImpl;
	let stats: IndexStats;

	beforeAll(async () => {
		// One build for the whole block: 9,280 files and ~26 MB of text is the
		// scale this index exists for, but it is not something to repeat per test.
		corpus = newIndex({ scanAnnotations: false });
		stats = await corpus.build([REFERENCE_PROTO_ROOT as string]);
	});

	test("indexes the whole corpus at the full tier", () => {
		expect(stats.tier).toBe("full");
		expect(stats.degradeReason).toBeUndefined();
		expect(stats.fileCount).toBeGreaterThan(9000);
		// 76,346 when this was written: 11,825 declarations — messages, enums,
		// services, extends — and 64,521 fields, enum values and rpcs. The floor
		// sits well below that but several times above the declaration-only count,
		// so it still fails if the members silently stop being indexed; the ceiling
		// catches double-ingestion. Roughly eight symbols per file.
		expect(stats.symbolCount).toBeGreaterThan(60_000);
		expect(stats.symbolCount).toBeLessThan(150_000);
		expect(stats.symbolCount).toBeGreaterThan(stats.fileCount * 5);
		expect(stats.bytesRead).toBeGreaterThan(20_000_000);
	});

	test("keeps every SubjectChoice declaration under its own package", () => {
		const found = corpus.searchSymbols("SubjectChoice", 500);
		const exact = found.filter((s) => s.name === "SubjectChoice");
		expect(exact.length).toBeGreaterThan(80);
		// Distinct fqns, one per package: the bare name is worth nothing here.
		expect(new Set(exact.map((s) => s.fqn)).size).toBe(exact.length);
		expect(corpus.symbol("SubjectChoice")).toBeUndefined();
		expect(corpus.symbol(SUBJECT_CHOICE)).toMatchObject({
			name: "SubjectChoice",
			kind: "message",
		});
	});

	test("finds the one use of one SubjectChoice, not the 87 namesakes", () => {
		// `grep -c 'SubjectChoice subject'` over the corpus is 87. Renaming by
		// simple name rewrote every one of them; the index answers with the single
		// reference that genuinely resolves to this package's type.
		const refs = corpus.referencesTo(SUBJECT_CHOICE);
		expect(refs).toHaveLength(1);
		const file = corpus.file(refs[0].fileId);
		expect(path.basename(file?.path ?? "")).toBe("data_requirement.proto");
		expect(file?.packageName).toBe("protobuf.fhir.financial.general.v5.types");
		expect(refs[0]).toMatchObject({
			typeName: "SubjectChoice",
			resolvedFqn: SUBJECT_CHOICE,
		});
	});
});
