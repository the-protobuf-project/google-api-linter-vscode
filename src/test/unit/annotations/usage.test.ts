/**
 * Tests for annotation usage detection.
 *
 * The Proto view used to label its Annotations section with
 * `registry.all().length` — every annotation the scanner ever saw, which
 * includes the nineteen declared in googleapis and everything in the buf module
 * cache. A workspace applying three of them read as dozens. What this module
 * answers instead is which ones the project actually writes.
 *
 * Two properties carry that distinction and are the reason for most of what
 * follows. Applied is not the same as declared: googleapis declares
 * `google.api.http` and a workspace that never writes it is not using it. And
 * the scan must ignore comments and strings — there is a specific trap here,
 * covered below, that already cost this codebase a real bug.
 */

import { describe, expect, test } from "bun:test";
import {
	type AnnotationUsage,
	appliedOptionsIn,
	collectAnnotationUsage,
} from "../../../annotations/usage";
import type {
	AnnotationDescriptor,
	AnnotationRegistry,
	IndexedFile,
	ProtoIndex,
} from "../../../index/types";

/** Ids at or above this come from outside the workspace. */
const EXTERNAL = 1_000_000;

function descriptor(fqn: string): AnnotationDescriptor {
	const name = fqn.split(".").pop() ?? fqn;
	return {
		fqn,
		name,
		namespace: fqn.slice(0, fqn.length - name.length - 1),
		target: "Message",
		type: "string",
		number: 1,
		repeated: false,
		importPath: `${fqn.split(".").slice(0, -1).join("/")}/annotations.proto`,
		fileId: EXTERNAL,
		line: 1,
	};
}

/** A registry holding exactly the given fqns. */
function registryOf(fqns: readonly string[]): AnnotationRegistry {
	const all = fqns.map(descriptor);
	return {
		all: () => all,
		get: (fqn: string) => all.find((d) => d.fqn === fqn),
		byTarget: () => all,
		body: () => undefined,
		collisions: () => [],
	};
}

/** An index over the given files, with the given declared annotations. */
function indexOf(
	files: readonly { id: number; path: string }[],
	declared: readonly string[],
): ProtoIndex {
	const indexed: IndexedFile[] = files.map((f) => ({
		id: f.id,
		path: f.path,
		packageName: "acme.v1",
		imports: [],
		mtimeMs: 0,
	}));
	return {
		files: () => indexed,
		annotations: () => registryOf(declared),
	} as unknown as ProtoIndex;
}

/** Reads from a path→text map, rejecting for anything absent. */
function readerFor(
	contents: Record<string, string>,
): (path: string) => Promise<string> {
	return async (path: string) => {
		const text = contents[path];
		if (text === undefined) {
			throw new Error(`unreadable: ${path}`);
		}
		return text;
	};
}

function byFqn(
	usages: readonly AnnotationUsage[],
): Map<string, AnnotationUsage> {
	return new Map(usages.map((u) => [u.fqn, u]));
}

describe("appliedOptionsIn", () => {
	test("finds a file-scope option and a field option", () => {
		const found = appliedOptionsIn(`
option (acme.v1.owner) = "team";
message M {
  string id = 1 [(acme.v1.sensitive) = true];
}
`);
		expect(found.get("acme.v1.owner")).toBe(1);
		expect(found.get("acme.v1.sensitive")).toBe(1);
	});

	test("counts repeated applications", () => {
		const found = appliedOptionsIn(`
message M {
  string a = 1 [(acme.v1.x) = 1];
  string b = 2 [(acme.v1.x) = 2];
  string c = 3 [(acme.v1.x) = 3];
}
`);
		expect(found.get("acme.v1.x")).toBe(3);
	});

	test("ignores an option inside a line comment", () => {
		// Someone commenting out an annotation has stopped using it, and a
		// count that disagrees is worse than no count.
		expect(appliedOptionsIn("// option (acme.v1.x) = 1;").size).toBe(0);
	});

	test("ignores an option inside a block comment", () => {
		const text = ["/" + "*", "option (acme.v1.x) = 1;", "*" + "/"].join("\n");
		expect(appliedOptionsIn(text).size).toBe(0);
	});

	test("survives an http path template", () => {
		// The trap. A template's wildcard segment is a slash followed by a star
		// inside a quoted string, which a naive scan reads as a block-comment
		// opener; with no closer on the line it swallows the rest of the file.
		// That exact bug made a five-RPC service report one RPC.
		const found = appliedOptionsIn(`
service S {
  rpc A(R) returns (T) {
    option (google.api.http) = {get: "/v1/{name=users/*/todos/*}"};
  }
  rpc B(R) returns (T) {
    option (google.api.method_signature) = "name";
  }
}
`);
		expect(found.get("google.api.http")).toBe(1);
		// The declaration after the template is what proves the scan continued.
		expect(found.get("google.api.method_signature")).toBe(1);
	});

	test("does not mistake an rpc signature for an option", () => {
		// `rpc Get(Request) returns (Response)` is parentheses and identifiers,
		// which is most of what an applied option looks like.
		const found = appliedOptionsIn(
			"service S {\n  rpc Get(GetRequest) returns (Book);\n}",
		);
		expect(found.size).toBe(0);
	});
});

describe("collectAnnotationUsage", () => {
	test("reports an applied annotation with its count and files", async () => {
		const usage = await collectAnnotationUsage(
			indexOf(
				[
					{ id: 1, path: "/ws/a.proto" },
					{ id: 2, path: "/ws/b.proto" },
				],
				["acme.v1.owner"],
			),
			{
				readFile: readerFor({
					"/ws/a.proto": 'option (acme.v1.owner) = "team";',
					"/ws/b.proto":
						'message M {\n  string id = 1 [(acme.v1.owner) = "x"];\n}',
				}),
			},
		);
		const owner = byFqn(usage).get("acme.v1.owner");
		expect(owner?.count).toBe(2);
		expect([...(owner?.fileIds ?? [])].sort()).toEqual([1, 2]);
	});

	test("omits a declared annotation nobody applies", async () => {
		// The whole point. googleapis declares nineteen; a workspace using none
		// of them should show none of them.
		const usage = await collectAnnotationUsage(
			indexOf(
				[{ id: 1, path: "/ws/a.proto" }],
				["acme.v1.used", "acme.v1.never"],
			),
			{ readFile: readerFor({ "/ws/a.proto": "option (acme.v1.used) = 1;" }) },
		);
		expect(usage.map((u) => u.fqn)).toEqual(["acme.v1.used"]);
	});

	test("ignores files from outside the workspace", async () => {
		// googleapis applies its own annotations inside its own protos. Counting
		// those would report every workspace as using all of them.
		const usage = await collectAnnotationUsage(
			indexOf(
				[
					{ id: 1, path: "/ws/mine.proto" },
					{ id: EXTERNAL + 7, path: "/cache/googleapis/theirs.proto" },
				],
				["google.api.http"],
			),
			{
				readFile: readerFor({
					"/ws/mine.proto": "message M {}",
					"/cache/googleapis/theirs.proto":
						'option (google.api.http) = {get: "/v1/x"};',
				}),
			},
		);
		expect(usage).toEqual([]);
	});

	test("keeps going when one file cannot be read", async () => {
		const usage = await collectAnnotationUsage(
			indexOf(
				[
					{ id: 1, path: "/ws/gone.proto" },
					{ id: 2, path: "/ws/here.proto" },
				],
				["acme.v1.x"],
			),
			{ readFile: readerFor({ "/ws/here.proto": "option (acme.v1.x) = 1;" }) },
		);
		expect(byFqn(usage).get("acme.v1.x")?.count).toBe(1);
	});

	test("does nothing when the registry is empty", async () => {
		// Nothing declared means nothing can be applied, so reading the
		// workspace at all would be pure cost.
		let reads = 0;
		const usage = await collectAnnotationUsage(
			indexOf([{ id: 1, path: "/ws/a.proto" }], []),
			{
				readFile: async () => {
					reads++;
					return "option (acme.v1.x) = 1;";
				},
			},
		);
		expect(usage).toEqual([]);
		expect(reads).toBe(0);
	});

	test("stops when cancelled", async () => {
		const usage = await collectAnnotationUsage(
			indexOf([{ id: 1, path: "/ws/a.proto" }], ["acme.v1.x"]),
			{
				isCancelled: () => true,
				readFile: readerFor({ "/ws/a.proto": "option (acme.v1.x) = 1;" }),
			},
		);
		expect(usage).toEqual([]);
	});
});
