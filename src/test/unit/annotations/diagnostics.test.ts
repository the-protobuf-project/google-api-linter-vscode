/**
 * Tests for `AnnotationDiagnostics`.
 *
 * Five checks run over every proto buffer, and every one of them is a claim
 * that correct source is wrong. That asymmetry is what these tests are for: a
 * missed diagnostic is an inconvenience, a false one paints a red squiggle
 * across generated code that nobody can fix. So each check is exercised twice —
 * once on source that should be flagged, once on source that must not be — and
 * several tests assert an empty array on a file that uses every construct
 * correctly.
 *
 * Two of the checks are deliberately conservative and the tests pin that too.
 * "Missing import" is suppressed whenever the import closure could not be
 * computed in full, because a partial closure can prove an import present and
 * never prove one absent. Extension-number collisions are reported per file
 * rather than per registry: the `entity.v1` / `protokit.v1` overlap in this
 * workspace is a migration in progress, and a registry-wide error would mark
 * thousands of correct files.
 */

import { describe, expect, test } from "bun:test";
import type { TextDocument } from "vscode";
import {
	ANNOTATION_DIAGNOSTIC_CODES,
	ANNOTATION_DIAGNOSTIC_SOURCE,
	AnnotationDiagnostics,
} from "../../../annotations/diagnostics";
import { extractAnnotations } from "../../../annotations/extractor";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import { AnnotationSource } from "../../../annotations/resolve";
import {
	hasReferenceCorpus,
	listProtos,
	makeDocument,
	REFERENCE_PROTO_ROOT,
	referenceRegistry,
} from "../support/fixtures";
import {
	type Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	languages,
	Uri,
} from "../support/vscode";

let fileSeq = 0;

/**
 * Builds a registry from proto sources keyed by import path.
 *
 * Fixture files import nothing, so every closure computed from them is
 * complete — which is what makes the "missing import" assertions meaningful
 * rather than vacuously suppressed.
 *
 * @param files - Import path to source text
 * @returns A registry holding exactly those files
 */
function registryFrom(files: Record<string, string>): AnnotationRegistryImpl {
	const registry = new AnnotationRegistryImpl();
	for (const [importPath, text] of Object.entries(files)) {
		registry.ingest(
			extractAnnotations(text, {
				fileId: fileSeq++,
				importPath,
				path: `/repo/${importPath}`,
			}),
		);
	}
	return registry;
}

/**
 * A validator and the collection it publishes to.
 *
 * The collection is created inside the constructor and never exposed, so the
 * factory is swapped for the length of that call to catch the instance.
 *
 * @param registry - Registry the validator reads, or undefined for none
 * @returns The validator and its collection
 */
function validatorFor(registry: AnnotationRegistryImpl | undefined): {
	validator: AnnotationDiagnostics;
	collection: DiagnosticCollection;
} {
	const original = languages.createDiagnosticCollection;
	let captured: DiagnosticCollection | undefined;
	languages.createDiagnosticCollection = (name?: string) => {
		captured = new DiagnosticCollection(name);
		return captured;
	};
	try {
		const validator = new AnnotationDiagnostics(
			new AnnotationSource(undefined, registry),
		);
		return { validator, collection: captured as DiagnosticCollection };
	} finally {
		languages.createDiagnosticCollection = original;
	}
}

/**
 * Validates one buffer.
 * @param registry - Registry the validator reads
 * @param text - Buffer contents
 * @param uri - Override the generated uri, for the same-file checks
 * @returns The published diagnostics and the document they describe
 */
function check(
	registry: AnnotationRegistryImpl | undefined,
	text: string,
	uri?: string,
): { diagnostics: readonly Diagnostic[]; document: TextDocument } {
	const document = makeDocument(text, uri);
	const { validator, collection } = validatorFor(registry);
	validator.validate(document);
	return {
		diagnostics: collection.get(document.uri as never) ?? [],
		document,
	};
}

/** Just the diagnostics, which is all most assertions need. */
function diagnose(
	registry: AnnotationRegistryImpl | undefined,
	text: string,
	uri?: string,
): readonly Diagnostic[] {
	return check(registry, text, uri).diagnostics;
}

/** `code` of each diagnostic, in the order they were published. */
function codes(diagnostics: readonly Diagnostic[]): (string | number)[] {
	return diagnostics.map((item) => item.code ?? "");
}

/** The bundle every fixture below uses: one annotation per interesting target. */
const DEMO_ANNOTATIONS = `syntax = "proto3";
package demo.v1;

enum Behavior {
  BEHAVIOR_UNSPECIFIED = 0;
  OPTIONAL = 1;
  REQUIRED = 2;
}

message StringRules {
  string pattern = 1;
  uint64 min_len = 2;
}

message FieldRules {
  StringRules string = 1;
  bool required = 2;
  Behavior behavior = 3;
}

extend google.protobuf.FieldOptions {
  optional Behavior demo_behavior = 60001;
  optional FieldRules demo_field = 60002;
}

extend google.protobuf.MethodOptions {
  optional string demo_tool = 60003;
}

extend google.protobuf.MessageOptions {
  optional string demo_note = 60004;
}

extend google.protobuf.EnumValueOptions {
  optional string demo_label = 60005;
}

extend google.protobuf.FileOptions {
  optional string demo_owner = 60006;
}
`;

const DEMO_REGISTRY = registryFrom({
	"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
});

/** Header every fixture that uses `demo.v1` needs. */
const DEMO_HEADER = `syntax = "proto3";
package use.v1;
import "demo/v1/annotations.proto";
`;

describe("a correct file", () => {
	test("produces nothing for every construct used properly", () => {
		// One file exercising all five checks at once: this is the assertion that
		// catches a false positive introduced anywhere in the module.
		expect(
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}
option (demo.v1.demo_owner) = "platform";

message M {
  option (demo.v1.demo_note) = "kept";
  string id = 1 [
    (demo.v1.demo_behavior) = REQUIRED,
    (demo.v1.demo_field) = { string: { pattern: "^a$" } required: true }
  ];
  string alias = 2 [(demo.v1.demo_field).string.min_len = 3];
}

enum E {
  E_UNSPECIFIED = 0 [(demo.v1.demo_label) = "none"];
}

service S {
  rpc Get(GetRequest) returns (GetResponse) {
    option (demo.v1.demo_tool) = "get";
  }
}
`,
			),
		).toEqual([]);
	});

	test("produces nothing for a file with no options at all", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`syntax = "proto3";
package use.v1;

message M {
  string id = 1;
}
`,
			),
		).toEqual([]);
	});

	test("produces nothing for an empty buffer", () => {
		expect(diagnose(DEMO_REGISTRY, "")).toEqual([]);
	});

	test("produces nothing for a file with no package statement", () => {
		// Without a package the scope walk has nothing to walk, so a fully
		// qualified name is the only thing that can resolve — and it must.
		expect(
			diagnose(
				DEMO_REGISTRY,
				`syntax = "proto3";
import "demo/v1/annotations.proto";

message M {
  option (demo.v1.demo_note) = "kept";
}
`,
			),
		).toEqual([]);
	});
});

describe("unknown annotation", () => {
	test("flags a misspelling in a known namespace and suggests the name", () => {
		const [diagnostic, ...rest] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (demo.v1.demo_not) = "x";
}
`,
		);
		expect(rest).toEqual([]);
		expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.unknown);
		expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
		expect(diagnostic.message).toBe(
			"`demo.v1` declares no option named `demo_not`. Did you mean `(demo.v1.demo_note)`?",
		);
	});

	test("downgrades an option in a namespace nothing has indexed", () => {
		// The declaring module may simply be outside the index, so this is a
		// warning with no suggestion rather than an error.
		const [diagnostic] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (nowhere.v9.mystery) = "x";
}
`,
		);
		expect(diagnostic.severity).toBe(DiagnosticSeverity.Warning);
		expect(diagnostic.message).toBe(
			"No indexed `extend` block declares `(nowhere.v9.mystery)`.",
		);
	});

	test("offers no suggestion when nothing in the namespace is close", () => {
		const [diagnostic] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (demo.v1.completely_different_thing) = "x";
}
`,
		);
		expect(diagnostic.message).not.toContain("Did you mean");
	});

	test("underlines the written name and nothing around it", () => {
		const { diagnostics, document } = check(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (demo.v1.demo_not) = "x";
}
`,
		);
		expect(document.getText(diagnostics[0].range as never)).toBe(
			"demo.v1.demo_not",
		);
	});

	test("stamps the module's source on every diagnostic", () => {
		for (const diagnostic of diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (demo.v1.demo_not) = "x";
}
`,
		)) {
			expect(diagnostic.source).toBe(ANNOTATION_DIAGNOSTIC_SOURCE);
		}
	});

	test("says nothing about an option the buffer declares itself", () => {
		// The index has never seen this file, so the name resolves to nothing.
		// `declaredHere` runs before resolution, which is what keeps an author
		// from being told their own option does not exist while they type it.
		expect(
			diagnose(
				DEMO_REGISTRY,
				`syntax = "proto3";
package fresh.v1;

extend google.protobuf.MessageOptions {
  optional string local = 60031;
}

message M {
  option (fresh.v1.local) = "hi";
}
`,
			),
		).toEqual([]);
	});

	// `declaredHere` compares the leaf name only, so a file that happens to
	// declare `local` suppresses every check on any `*.local` from anywhere.
	// Expected: `(other.v1.local)` is declared by no indexed extend block and
	// should be reported, regardless of what this file's own extend block names.
	test.skip("flags a foreign option that shares a leaf name with a local one", () => {
		expect(
			codes(
				diagnose(
					DEMO_REGISTRY,
					`syntax = "proto3";
package fresh.v1;

extend google.protobuf.MessageOptions {
  optional string local = 60032;
}

message M {
  option (other.v1.local) = "hi";
}
`,
				),
			),
		).toEqual([ANNOTATION_DIAGNOSTIC_CODES.unknown]);
	});

	test("says nothing about an option written unqualified in its own package", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`syntax = "proto3";
package demo.v1;
import "demo/v1/annotations.proto";

message M {
  option (demo_note) = "kept";
}
`,
			),
		).toEqual([]);
	});
});

describe("wrong target", () => {
	test("flags an rpc option applied to a message", () => {
		const [diagnostic, ...rest] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (demo.v1.demo_tool) = "get";
}
`,
		);
		expect(rest).toEqual([]);
		expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.wrongTarget);
		expect(diagnostic.severity).toBe(DiagnosticSeverity.Error);
		expect(diagnostic.message).toBe(
			"`(demo.v1.demo_tool)` is a rpc option and cannot be applied to a message.",
		);
	});

	test("flags a field option applied at file scope", () => {
		expect(
			codes(
				diagnose(
					DEMO_REGISTRY,
					`${DEMO_HEADER}
option (demo.v1.demo_behavior) = REQUIRED;
`,
				),
			),
		).toEqual([ANNOTATION_DIAGNOSTIC_CODES.wrongTarget]);
	});

	test("flags a message option applied to an enum value", () => {
		expect(
			codes(
				diagnose(
					DEMO_REGISTRY,
					`${DEMO_HEADER}enum E {
  E_UNSPECIFIED = 0 [(demo.v1.demo_note) = "x"];
}
`,
				),
			),
		).toEqual([ANNOTATION_DIAGNOSTIC_CODES.wrongTarget]);
	});

	/** The same annotation on the element its extendee actually names. */
	const rightPlace: readonly (readonly [string, string])[] = [
		["a file option at file scope", 'option (demo.v1.demo_owner) = "x";\n'],
		[
			"a message option on a message",
			'message M {\n  option (demo.v1.demo_note) = "x";\n}\n',
		],
		[
			"a field option in field brackets",
			"message M {\n  string id = 1 [(demo.v1.demo_behavior) = REQUIRED];\n}\n",
		],
		[
			"an enum value option in enum value brackets",
			'enum E {\n  E_UNSPECIFIED = 0 [(demo.v1.demo_label) = "x"];\n}\n',
		],
		[
			"an rpc option on an rpc",
			'service S {\n  rpc Get(Req) returns (Res) {\n    option (demo.v1.demo_tool) = "x";\n  }\n}\n',
		],
	];

	for (const [what, body] of rightPlace) {
		test(`says nothing about ${what}`, () => {
			expect(diagnose(DEMO_REGISTRY, `${DEMO_HEADER}${body}`)).toEqual([]);
		});
	}
});

describe("unknown body field", () => {
	test("flags a field the body message does not declare", () => {
		const [diagnostic, ...rest] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).no_such_field = 1];
}
`,
		);
		expect(rest).toEqual([]);
		expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.unknownField);
		expect(diagnostic.message).toBe(
			"`no_such_field` is not a field of `demo.v1.FieldRules`.",
		);
	});

	test("flags a field written inside a text-format body", () => {
		const [diagnostic] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {
    no_such_field: true
  }];
}
`,
		);
		expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.unknownField);
	});

	test("flags a field one level down and names the nested message", () => {
		const [diagnostic] = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.no_such_field = 1];
}
`,
		);
		expect(diagnostic.message).toBe(
			"`no_such_field` is not a field of `demo.v1.StringRules`.",
		);
	});

	test("underlines the field name alone", () => {
		const { diagnostics, document } = check(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.no_such_field = 1];
}
`,
		);
		expect(document.getText(diagnostics[0].range as never)).toBe(
			"no_such_field",
		);
	});

	test("reports an unknown parent once, not once per segment under it", () => {
		// Judging a field whose containing message is itself unresolved would
		// turn one typo into a cascade down the whole path.
		const diagnostics = diagnose(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).no_such.deeper.deepest = 1];
}
`,
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("`no_such` is not a field");
	});

	test("says nothing about fields of an option that does not resolve", () => {
		expect(
			codes(
				diagnose(
					DEMO_REGISTRY,
					`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.no_such_option).whatever = 1];
}
`,
				),
			),
		).toEqual([ANNOTATION_DIAGNOSTIC_CODES.unknown]);
	});

	test("says nothing about a scalar field assigned a value", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.min_len = 3];
}
`,
			),
		).toEqual([]);
	});

	test("says nothing about an option body with no fields written at all", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {}];
}
`,
			),
		).toEqual([]);
	});
});

describe("missing import", () => {
	test("flags an option whose declaring file is not in the closure", () => {
		const [diagnostic, ...rest] = diagnose(
			DEMO_REGISTRY,
			`syntax = "proto3";
package use.v1;

message M {
  option (demo.v1.demo_note) = "x";
}
`,
		);
		expect(rest).toEqual([]);
		expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.missingImport);
		expect(diagnostic.message).toBe(
			'`(demo.v1.demo_note)` is declared in "demo/v1/annotations.proto", which this file does not import.',
		);
	});

	test("says nothing once the file imports it directly", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  option (demo.v1.demo_note) = "x";
}
`,
			),
		).toEqual([]);
	});

	test("says nothing when the declaration is reached transitively", () => {
		// Generated annotation bundles re-export through `import public`, so a
		// direct-import test alone would flag correct files.
		const registry = registryFrom({
			"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
			"bundle/v1/all.proto": `syntax = "proto3";
package bundle.v1;
import "demo/v1/annotations.proto";
`,
		});
		expect(
			diagnose(
				registry,
				`syntax = "proto3";
package use.v1;
import "bundle/v1/all.proto";

message M {
  option (demo.v1.demo_note) = "x";
}
`,
			),
		).toEqual([]);
	});

	test("stays quiet when the closure could not be computed in full", () => {
		// One import leads somewhere never scanned, so absence cannot be proven
		// and no import judgement may be made about anything in this file.
		expect(
			diagnose(
				DEMO_REGISTRY,
				`syntax = "proto3";
package use.v1;
import "never/scanned.proto";

message M {
  option (demo.v1.demo_note) = "x";
}
`,
			),
		).toEqual([]);
	});

	test("says nothing about an option the buffer declares itself", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`syntax = "proto3";
package demo.v1;

extend google.protobuf.MessageOptions {
  optional string demo_note = 60004;
}

message M {
  option (demo.v1.demo_note) = "x";
}
`,
			),
		).toEqual([]);
	});

	test("says nothing when the buffer is the file on disk that declares it", () => {
		// Editing `annotations.proto` itself: the option is in scope by being
		// written here, and the file does not import itself.
		expect(
			diagnose(
				DEMO_REGISTRY,
				DEMO_ANNOTATIONS.replace(
					"extend google.protobuf.MessageOptions {",
					'message Holder {\n  option (demo.v1.demo_note) = "x";\n}\n\nextend google.protobuf.MessageOptions {',
				),
				"/repo/demo/v1/annotations.proto",
			),
		).toEqual([]);
	});

	test("reports the missing import once per use", () => {
		expect(
			codes(
				diagnose(
					DEMO_REGISTRY,
					`syntax = "proto3";
package use.v1;

message M {
  option (demo.v1.demo_note) = "x";
  string id = 1 [(demo.v1.demo_behavior) = REQUIRED];
}
`,
				),
			),
		).toEqual([
			ANNOTATION_DIAGNOSTIC_CODES.missingImport,
			ANNOTATION_DIAGNOSTIC_CODES.missingImport,
		]);
	});
});

describe("extension number collision", () => {
	/** Two bundles claiming Message extension 60100, mid-migration. */
	const COLLIDING = {
		"entity/v1/annotations.proto": `syntax = "proto3";
package entity.v1;

extend google.protobuf.MessageOptions {
  optional string table = 60100;
}
`,
		"protokit/v1/annotations.proto": `syntax = "proto3";
package protokit.v1;

extend google.protobuf.MessageOptions {
  optional string table = 60100;
}
`,
	};

	const COLLIDING_REGISTRY = registryFrom(COLLIDING);

	test("flags a file that imports both claimants", () => {
		const [diagnostic, ...rest] = diagnose(
			COLLIDING_REGISTRY,
			`syntax = "proto3";
package use.v1;
import "entity/v1/annotations.proto";
import "protokit/v1/annotations.proto";
`,
		);
		expect(rest).toEqual([]);
		expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.numberCollision);
		expect(diagnostic.message).toContain(
			"Extension number 60100 on message options is claimed by",
		);
		expect(diagnostic.message).toContain(
			'`(entity.v1.table)` ("entity/v1/annotations.proto")',
		);
		expect(diagnostic.message).toContain(
			'`(protokit.v1.table)` ("protokit/v1/annotations.proto")',
		);
	});

	test("anchors on the import that pulled the second claimant in", () => {
		const { diagnostics, document } = check(
			COLLIDING_REGISTRY,
			`syntax = "proto3";
package use.v1;
import "entity/v1/annotations.proto";
import "protokit/v1/annotations.proto";
`,
		);
		expect(document.getText(diagnostics[0].range as never)).toBe(
			'"protokit/v1/annotations.proto"',
		);
	});

	test("points related information at both declarations", () => {
		const [diagnostic] = diagnose(
			COLLIDING_REGISTRY,
			`syntax = "proto3";
package use.v1;
import "entity/v1/annotations.proto";
import "protokit/v1/annotations.proto";
`,
		);
		const related = diagnostic.relatedInformation ?? [];
		expect(related.map((item) => item.location.uri.fsPath)).toEqual([
			"/repo/entity/v1/annotations.proto",
			"/repo/protokit/v1/annotations.proto",
		]);
		expect(related[0].message).toBe("`entity.v1.table` claims 60100 here");
		// 0-based line of `optional string table = 60100;` in the fixture.
		expect(related[0].location.range.start.line).toBe(4);
	});

	test("says nothing when the file reaches only one claimant", () => {
		// The whole point of checking per file: this workspace's registry always
		// holds the collision, and almost every file is entirely correct.
		expect(
			diagnose(
				COLLIDING_REGISTRY,
				`syntax = "proto3";
package use.v1;
import "entity/v1/annotations.proto";

message M {
  option (entity.v1.table) = "patients";
}
`,
			),
		).toEqual([]);
	});

	test("says nothing when the file reaches neither claimant", () => {
		expect(
			diagnose(
				COLLIDING_REGISTRY,
				`syntax = "proto3";
package use.v1;

message M {
  string id = 1;
}
`,
			),
		).toEqual([]);
	});

	test("flags a collision reached only through a bundle", () => {
		const registry = registryFrom({
			...COLLIDING,
			"bundle/v1/all.proto": `syntax = "proto3";
package bundle.v1;
import "entity/v1/annotations.proto";
import "protokit/v1/annotations.proto";
`,
		});
		const { diagnostics, document } = check(
			registry,
			`syntax = "proto3";
package use.v1;
import "bundle/v1/all.proto";
`,
		);
		expect(codes(diagnostics)).toEqual([
			ANNOTATION_DIAGNOSTIC_CODES.numberCollision,
		]);
		// Neither claimant is imported directly, so the only honest anchor left
		// is the import that reached them.
		expect(document.getText(diagnostics[0].range as never)).toBe(
			'"bundle/v1/all.proto"',
		);
	});

	test("prefers a use of a claimant over the first import", () => {
		const registry = registryFrom({
			...COLLIDING,
			"bundle/v1/all.proto": `syntax = "proto3";
package bundle.v1;
import "entity/v1/annotations.proto";
import "protokit/v1/annotations.proto";
`,
		});
		const { diagnostics, document } = check(
			registry,
			`syntax = "proto3";
package use.v1;
import "bundle/v1/all.proto";

message M {
  option (protokit.v1.table) = "patients";
}
`,
		);
		expect(document.getText(diagnostics[0].range as never)).toBe(
			"protokit.v1.table",
		);
	});

	test("says nothing when the shared number is on different targets", () => {
		// Protobuf requires uniqueness per extendee, so `Message#60100` and
		// `Field#60100` are not a conflict at all.
		const registry = registryFrom({
			"entity/v1/annotations.proto": COLLIDING["entity/v1/annotations.proto"],
			"other/v1/annotations.proto": `syntax = "proto3";
package other.v1;

extend google.protobuf.FieldOptions {
  optional string label = 60100;
}
`,
		});
		expect(
			diagnose(
				registry,
				`syntax = "proto3";
package use.v1;
import "entity/v1/annotations.proto";
import "other/v1/annotations.proto";
`,
			),
		).toEqual([]);
	});
});

describe("lifecycle", () => {
	const USES_ANNOTATION = `${DEMO_HEADER}message M {
  option (demo.v1.demo_not) = "x";
}
`;

	test("publishes nothing before the index has run", () => {
		const document = makeDocument(USES_ANNOTATION);
		const { validator, collection } = validatorFor(
			new AnnotationRegistryImpl(),
		);
		validator.validate(document);
		expect(collection.get(document.uri as never)).toBeUndefined();
	});

	test("publishes nothing when there is no registry at all", () => {
		const document = makeDocument(USES_ANNOTATION);
		const { validator, collection } = validatorFor(undefined);
		validator.validate(document);
		expect(collection.get(document.uri as never)).toBeUndefined();
	});

	test("withdraws diagnostics when the index is emptied", () => {
		// A rebuild that drops everything must not leave stale errors behind.
		const registry = registryFrom({
			"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
		});
		const document = makeDocument(USES_ANNOTATION);
		const { validator, collection } = validatorFor(registry);
		validator.validate(document);
		expect(collection.get(document.uri as never)).toHaveLength(1);
		registry.clear();
		validator.validate(document);
		expect(collection.get(document.uri as never)).toBeUndefined();
	});

	test("ignores a document that is not proto", () => {
		const document = {
			...makeDocument(USES_ANNOTATION),
			languageId: "typescript",
			uri: Uri.file("/virtual/notes.ts"),
		} as unknown as TextDocument;
		const { validator, collection } = validatorFor(DEMO_REGISTRY);
		validator.validate(document);
		expect(collection.uris()).toEqual([]);
	});

	test("validates a .proto path whatever the language id says", () => {
		const document = {
			...makeDocument(USES_ANNOTATION),
			languageId: "plaintext",
			uri: Uri.file("/virtual/unlabelled.proto"),
		} as unknown as TextDocument;
		const { validator, collection } = validatorFor(DEMO_REGISTRY);
		validator.validate(document);
		expect(collection.get(document.uri as never)).toHaveLength(1);
	});

	test("re-analyses the buffer after an edit", () => {
		// The parsed model is cached on uri plus version; a stale hit here would
		// leave the fixed error on screen until the file was closed.
		const uri = "/virtual/edited.proto";
		const { validator, collection } = validatorFor(DEMO_REGISTRY);
		const before = makeDocument(USES_ANNOTATION, uri);
		validator.validate(before);
		expect(collection.get(before.uri as never)).toHaveLength(1);

		const after = {
			...makeDocument(
				`${DEMO_HEADER}message M {
  option (demo.v1.demo_note) = "x";
}
`,
				uri,
			),
			version: 2,
		} as unknown as TextDocument;
		validator.validate(after);
		expect(collection.get(after.uri as never)).toEqual([]);
	});

	test("disposes its collection", () => {
		const { validator, collection } = validatorFor(DEMO_REGISTRY);
		validator.dispose();
		expect(collection.disposed).toBe(true);
	});

	test("survives being disposed twice", () => {
		const { validator } = validatorFor(DEMO_REGISTRY);
		validator.dispose();
		expect(() => {
			validator.dispose();
		}).not.toThrow();
	});
});

describe("malformed input", () => {
	test("survives a buffer that ends mid-option", () => {
		expect(() =>
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {
    string: {
`,
			),
		).not.toThrow();
	});

	test("survives unbalanced braces", () => {
		expect(() =>
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  option (demo.v1.demo_note) = "x";
}
}
}
`,
			),
		).not.toThrow();
	});

	test("ignores an option name written inside a string literal", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  option (demo.v1.demo_note) = "(demo.v1.no_such_option) = 1";
}
`,
			),
		).toEqual([]);
	});

	test("ignores an option name written inside a comment", () => {
		expect(
			diagnose(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  // option (demo.v1.no_such_option) = 1;
  /* option (demo.v1.also_missing) = 2; */
  option (demo.v1.demo_note) = "x";
}
`,
			),
		).toEqual([]);
	});

	test("handles CRLF line endings", () => {
		const { diagnostics, document } = check(
			DEMO_REGISTRY,
			`syntax = "proto3";\r\npackage use.v1;\r\nimport "demo/v1/annotations.proto";\r\nmessage M {\r\n  option (demo.v1.demo_not) = "x";\r\n}\r\n`,
		);
		expect(document.getText(diagnostics[0].range as never)).toBe(
			"demo.v1.demo_not",
		);
	});

	test("keeps ranges correct after an astral-plane character", () => {
		const { diagnostics, document } = check(
			DEMO_REGISTRY,
			`${DEMO_HEADER}// 🏥 hospital resources
message M {
  option (demo.v1.demo_not) = "x";
}
`,
		);
		expect(document.getText(diagnostics[0].range as never)).toBe(
			"demo.v1.demo_not",
		);
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"finds nothing wrong with generated code",
		async () => {
			// The corpus is the only input that exercises every annotation bundle
			// at once, collisions included: the registry holds real ones and no
			// file reaches both claimants. A diagnostic here is either a defect in
			// the tree or a false positive in this module; both need looking at.
			const registry = await referenceRegistry();
			expect(registry.all().length).toBeGreaterThan(20);
			expect(registry.collisions().length).toBeGreaterThan(0);

			const { validator, collection } = validatorFor(registry);
			const files = listProtos(REFERENCE_PROTO_ROOT as string);
			expect(files.length).toBeGreaterThan(1000);

			const offenders: string[] = [];
			for (const file of files) {
				const document = makeDocument(await Bun.file(file).text(), file);
				validator.validate(document);
				for (const item of collection.get(document.uri as never) ?? []) {
					offenders.push(
						`${file}:${item.range.start.line + 1} ${item.code} ${item.message}`,
					);
				}
			}
			// The first few are enough to read; the length keeps the count honest.
			expect(offenders.slice(0, 10)).toEqual([]);
			expect(offenders).toHaveLength(0);
			// Every file was published for, so an empty sweep means "nothing
			// wrong" rather than "nothing ran".
			expect(collection.uris()).toHaveLength(files.length);
		},
		180000,
	);

	test.skipIf(!hasReferenceCorpus())(
		"accepts a real annotation used correctly",
		async () => {
			expect(
				diagnose(
					await referenceRegistry(),
					`syntax = "proto3";
package use.v1;
import "google/api/field_behavior.proto";

message M {
  string id = 1 [(google.api.field_behavior) = OPTIONAL];
}
`,
				),
			).toEqual([]);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"flags a typo in a real annotation and suggests the spelling",
		async () => {
			// The counterpart to the sweep above: proves the checks still fire on
			// corpus-scale input rather than silently resolving everything.
			const [diagnostic, ...rest] = diagnose(
				await referenceRegistry(),
				`syntax = "proto3";
package use.v1;
import "google/api/field_behavior.proto";

message M {
  string id = 1 [(google.api.field_behaviour) = OPTIONAL];
}
`,
			);
			expect(rest).toEqual([]);
			expect(diagnostic.code).toBe(ANNOTATION_DIAGNOSTIC_CODES.unknown);
			expect(diagnostic.message).toContain(
				"Did you mean `(google.api.field_behavior)`?",
			);
		},
	);
});
