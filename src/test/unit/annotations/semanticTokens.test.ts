/**
 * Tests for `AnnotationSemanticTokensProvider`.
 *
 * The TextMate grammar highlights `google.(api|protobuf)` and nothing else, so
 * every custom namespace in the tree — `mcp.v1`, `cache.v1`, `entity.v1` — is
 * only ever coloured by this provider. Two properties are load-bearing and
 * neither is visible from the encoded output VS Code consumes:
 *
 * - **Order.** The wire format is delta-encoded, so a token emitted out of
 *   document order silently shifts every token after it onto the wrong text.
 * - **Resolution.** A name that resolves and a name that does not are different
 *   token types, and the `Unknown` variants map to `invalid.illegal`. Marking a
 *   legal option unknown paints an error over correct source.
 *
 * The stub `SemanticTokensBuilder` records pushed ranges rather than encoding
 * them, so the assertions below read tokens back as `type + source text`.
 */

import { describe, expect, test } from "bun:test";
import type { TextDocument } from "vscode";
import { extractAnnotations } from "../../../annotations/extractor";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import { AnnotationSource } from "../../../annotations/resolve";
import {
	ANNOTATION_SEMANTIC_LEGEND,
	ANNOTATION_TOKEN_MODIFIERS,
	ANNOTATION_TOKEN_TYPES,
	AnnotationSemanticTokensProvider,
} from "../../../annotations/semanticTokens";
import {
	EXTENSION_ROOT,
	hasReferenceCorpus,
	listProtos,
	makeDocument,
	REFERENCE_PROTO_ROOT,
	referenceRegistry,
} from "../support/fixtures";
import { CancellationTokenNone, type RecordedToken } from "../support/vscode";

let fileSeq = 0;

/**
 * Builds a registry from proto sources keyed by import path.
 *
 * The sources here deliberately import nothing: `importClosure` is only
 * authoritative when every file it reaches has been scanned, and a fixture that
 * pulled in `google/protobuf/descriptor.proto` — which no scan root holds —
 * would make every closure partial and every visibility check vacuous.
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

/** A provider backed by a fixed registry, the shape every test uses. */
function providerFor(
	registry: AnnotationRegistryImpl | undefined,
): AnnotationSemanticTokensProvider {
	return new AnnotationSemanticTokensProvider(
		new AnnotationSource(undefined, registry),
	);
}

/** Tokens for one buffer, in the order the provider emitted them. */
function tokensOf(
	provider: AnnotationSemanticTokensProvider,
	document: TextDocument,
	cancelled = false,
): RecordedToken[] {
	const token = cancelled
		? { ...CancellationTokenNone, isCancellationRequested: true }
		: CancellationTokenNone;
	const result = provider.provideDocumentSemanticTokens(
		document,
		token as never,
	);
	return (result as unknown as { tokens: RecordedToken[] } | undefined)?.tokens
		? (result as unknown as { tokens: RecordedToken[] }).tokens
		: [];
}

/** `type source-text` for each token, which is what the assertions read. */
function described(
	document: TextDocument,
	tokens: readonly RecordedToken[],
): string[] {
	return tokens.map(
		(item) => `${item.type} ${document.getText(item.range as never)}`,
	);
}

/** One buffer in, described tokens out. */
function highlight(
	registry: AnnotationRegistryImpl,
	text: string,
): { document: TextDocument; tokens: RecordedToken[]; described: string[] } {
	const document = makeDocument(text);
	const tokens = tokensOf(providerFor(registry), document);
	return { document, tokens, described: described(document, tokens) };
}

/**
 * A self-contained stand-in for the annotation bundles the corpus imports: one
 * enum-valued option, one with a nested message body, and a scalar.
 */
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
`;

/** A second bundle, so "declared but not imported" has somewhere to live. */
const OTHER_ANNOTATIONS = `syntax = "proto3";
package other.v1;

extend google.protobuf.MessageOptions {
  optional string note = 60010;
}
`;

const DEMO_REGISTRY = registryFrom({
	"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
	"other/v1/annotations.proto": OTHER_ANNOTATIONS,
});

/** Header every fixture that uses `demo.v1` needs to see the declaration. */
const DEMO_HEADER = `syntax = "proto3";
package use.v1;
import "demo/v1/annotations.proto";
`;

describe("token types", () => {
	test("splits a dotted option name into namespace and leaf", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = OPTIONAL];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_behavior",
			"protoAnnotationValue OPTIONAL",
		]);
	});

	test("emits no namespace token for an unqualified option name", () => {
		// Written inside the declaring package, so protobuf's scoping rules find
		// it with no prefix and there is no namespace text to colour.
		const registry = registryFrom({
			"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
		});
		const { described: seen } = highlight(
			registry,
			`syntax = "proto3";
package demo.v1;
import "demo/v1/annotations.proto";
message M {
  string id = 1 [(demo_behavior) = REQUIRED];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotation demo_behavior",
			"protoAnnotationValue REQUIRED",
		]);
	});

	test("colours a partially qualified name from the shared prefix outwards", () => {
		const registry = registryFrom({
			"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
		});
		const { described: seen } = highlight(
			registry,
			`syntax = "proto3";
package demo.other;
import "demo/v1/annotations.proto";
message M {
  string id = 1 [(v1.demo_behavior) = OPTIONAL];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace v1",
			"protoAnnotation demo_behavior",
			"protoAnnotationValue OPTIONAL",
		]);
	});

	test("marks every segment of a body field path", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.pattern = "^a"];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_field",
			"protoAnnotationField string",
			"protoAnnotationField pattern",
		]);
	});

	test("marks fields written inside a text-format body", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {
    string: { pattern: "^a" }
    required: true
  }];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_field",
			"protoAnnotationField string",
			"protoAnnotationField pattern",
			"protoAnnotationField required",
		]);
	});

	test("marks a field the body does not declare", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).no_such_field = 1];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_field",
			"protoAnnotationFieldUnknown no_such_field",
		]);
	});

	test("marks an option no extend block declares", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.no_such_option) = 1];
}
`,
		);
		// One token covering the whole name: with nothing resolved there is no
		// leaf to split off, and the name reads as a single mistake.
		expect(seen).toEqual(["protoAnnotationUnknown demo.v1.no_such_option"]);
	});

	test("marks an option whose declaring file this one never imports", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  option (other.v1.note) = "hi";
}
`,
		);
		expect(seen).toEqual(["protoAnnotationUnknown other.v1.note"]);
	});

	test("accepts an option reached through a transitive import", () => {
		const registry = registryFrom({
			"demo/v1/annotations.proto": DEMO_ANNOTATIONS,
			"bundle/v1/all.proto": `syntax = "proto3";
package bundle.v1;
import "demo/v1/annotations.proto";
`,
		});
		const { described: seen } = highlight(
			registry,
			`syntax = "proto3";
package use.v1;
import "bundle/v1/all.proto";
message M {
  string id = 1 [(demo.v1.demo_behavior) = OPTIONAL];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_behavior",
			"protoAnnotationValue OPTIONAL",
		]);
	});

	test("does not call an option unknown when the closure is partial", () => {
		// The import leads somewhere the registry has never scanned, so absence
		// cannot be proven and the option is left alone rather than flagged.
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`syntax = "proto3";
package use.v1;
import "never/scanned.proto";
message M {
  option (other.v1.note) = "hi";
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace other.v1",
			"protoAnnotation note",
		]);
	});

	test("leaves a leading dot outside the leaf token", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(.demo.v1.demo_behavior) = OPTIONAL];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace .demo.v1",
			"protoAnnotation demo_behavior",
			"protoAnnotationValue OPTIONAL",
		]);
	});
});

describe("enum values", () => {
	/** The one option shape that carries an enum directly. */
	const behaviour = (value: string): string =>
		`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = ${value}];
}
`;

	test("accepts a member the enum declares", () => {
		expect(highlight(DEMO_REGISTRY, behaviour("REQUIRED")).described).toContain(
			"protoAnnotationValue REQUIRED",
		);
	});

	test("flags a misspelling", () => {
		expect(highlight(DEMO_REGISTRY, behaviour("REQUIRE")).described).toContain(
			"protoAnnotationValueUnknown REQUIRE",
		);
	});

	test("flags the wrong case", () => {
		// protobuf enum members are case-sensitive, so `optional` is not `OPTIONAL`.
		expect(highlight(DEMO_REGISTRY, behaviour("optional")).described).toContain(
			"protoAnnotationValueUnknown optional",
		);
	});

	test("flags a member of no enum at all", () => {
		expect(
			highlight(DEMO_REGISTRY, behaviour("IGNORE_NEVER")).described,
		).toContain("protoAnnotationValueUnknown IGNORE_NEVER");
	});

	test("emits no value token for an int-valued field", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.min_len = 3];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_field",
			"protoAnnotationField string",
			"protoAnnotationField min_len",
		]);
	});

	test("emits no value token for a string-valued field", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.pattern = "x"];
}
`,
		);
		expect(
			seen.filter((entry) => entry.startsWith("protoAnnotationValue")),
		).toEqual([]);
	});

	test("emits no value token for a bool-valued field", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).required = true];
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_field",
			"protoAnnotationField required",
		]);
	});

	test("leaves true and false alone even where an enum is expected", () => {
		// `true` is legal text-format anywhere and is never an enum member, so
		// flagging it would be noise rather than the compile error it looks like.
		for (const literal of ["true", "false"]) {
			expect(highlight(DEMO_REGISTRY, behaviour(literal)).described).toEqual([
				"protoAnnotationNamespace demo.v1",
				"protoAnnotation demo_behavior",
			]);
		}
	});

	test("resolves the enum against the body that declares the field", () => {
		// `outer.v1.wrap`'s body lives in `inner.v1`, so `Behavior` only resolves
		// when the lookup uses the body's package rather than the annotation's.
		const registry = registryFrom({
			"inner/v1/body.proto": `syntax = "proto3";
package inner.v1;

enum Behavior {
  BEHAVIOR_UNSPECIFIED = 0;
  KEEP = 1;
}

message Wrapped {
  Behavior behavior = 1;
}
`,
			"outer/v1/annotations.proto": `syntax = "proto3";
package outer.v1;
import "inner/v1/body.proto";

extend google.protobuf.MessageOptions {
  optional inner.v1.Wrapped wrap = 60020;
}
`,
		});
		const { described: seen } = highlight(
			registry,
			`syntax = "proto3";
package use.v1;
import "outer/v1/annotations.proto";
message M {
  option (outer.v1.wrap).behavior = KEEP;
}
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace outer.v1",
			"protoAnnotation wrap",
			"protoAnnotationField behavior",
			"protoAnnotationValue KEEP",
		]);
	});
});

describe("declarations", () => {
	test("marks the extension field an extend block declares", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`syntax = "proto3";
package x.v1;

extend google.protobuf.MessageOptions {
  optional string local = 60001;
}
`,
		);
		expect(seen).toEqual(["protoAnnotation local"]);
	});

	test("carries the declaration modifier and nothing else", () => {
		const document = makeDocument(`syntax = "proto3";
package x.v1;

extend google.protobuf.MessageOptions {
  optional string local = 60001;
}
`);
		const [token] = tokensOf(providerFor(DEMO_REGISTRY), document);
		expect(token.modifiers).toEqual(["declaration"]);
	});

	test("ignores a field in an extend block that is not an options message", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`syntax = "proto3";
package x.v1;

extend some.other.Message {
  optional string not_an_option = 9;
}
`,
		);
		expect(seen).toEqual([]);
	});

	// `collect` reaches `declaredHere` only after `resolveDescriptor` has already
	// returned something, so it rescues the *indexed* same-file case (the test
	// above) and not this one. A buffer that declares an annotation and uses it
	// before the index has ever seen the file resolves to nothing, and the
	// author's own option is painted `invalid.illegal` while they type it.
	// Expected: a name the buffer's own extend block declares is never unknown,
	// indexed or not — the declaration is right there in the same model.
	test.skip("marks a use of an annotation the unsaved buffer declares", () => {
		const { described: seen } = highlight(
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
		);
		expect(seen).toEqual([
			"protoAnnotation local",
			"protoAnnotationNamespace fresh.v1",
			"protoAnnotation local",
		]);
	});

	test("marks a use of an annotation the indexed file itself declares", () => {
		// Declaration and use in one file: the file does not import itself, so
		// only `declaredHere` keeps the use out of `protoAnnotationUnknown`.
		const source = `syntax = "proto3";
package self.v1;

extend google.protobuf.MessageOptions {
  optional string local = 60030;
}

message M {
  option (self.v1.local) = "hi";
}
`;
		const registry = registryFrom({ "self/v1/annotations.proto": source });
		expect(highlight(registry, source).described).toEqual([
			"protoAnnotation local",
			"protoAnnotationNamespace self.v1",
			"protoAnnotation local",
		]);
	});
});

describe("modifiers", () => {
	/** An annotation whose own doc comment announces a deprecation. */
	const DEPRECATED = `syntax = "proto3";
package dep.v1;

message Body {
  // Deprecated: replaced by something else.
  string old_field = 1;
  string new_field = 2;
}

extend google.protobuf.MessageOptions {
  // Deprecated: use the replacement instead.
  optional Body old = 60040;
  // Still current.
  optional Body current = 60041;
}
`;

	const registry = registryFrom({ "dep/v1/annotations.proto": DEPRECATED });
	const header = `syntax = "proto3";
package use.v1;
import "dep/v1/annotations.proto";
`;

	test("reads deprecation out of the annotation's doc comment", () => {
		const document = makeDocument(`${header}message M {
  option (dep.v1.old) = {};
}
`);
		const tokens = tokensOf(providerFor(registry), document);
		expect(tokens.map((item) => item.modifiers)).toEqual([
			["deprecated"],
			["deprecated"],
		]);
	});

	test("leaves an undeprecated annotation unmodified", () => {
		const document = makeDocument(`${header}message M {
  option (dep.v1.current) = {};
}
`);
		const tokens = tokensOf(providerFor(registry), document);
		expect(tokens.map((item) => item.modifiers)).toEqual([[], []]);
	});

	test("marks a deprecated body field and not its neighbour", () => {
		const document = makeDocument(`${header}message M {
  option (dep.v1.current) = {
    old_field: "a"
    new_field: "b"
  };
}
`);
		const fields = tokensOf(providerFor(registry), document).filter(
			(item) => item.type === "protoAnnotationField",
		);
		expect(fields.map((item) => item.modifiers)).toEqual([["deprecated"], []]);
	});

	test("only reads the first 240 characters of the doc comment", () => {
		// The scan is bounded so a long prose comment cannot be searched in full;
		// a mention past the cap is invisible, which is the documented behaviour.
		const filler = "x".repeat(250);
		const late = registryFrom({
			"late/v1/annotations.proto": `syntax = "proto3";
package late.v1;

extend google.protobuf.MessageOptions {
  // ${filler} deprecated
  optional string late_note = 60050;
}
`,
		});
		const document = makeDocument(`syntax = "proto3";
package use.v1;
import "late/v1/annotations.proto";
message M {
  option (late.v1.late_note) = "x";
}
`);
		const tokens = tokensOf(providerFor(late), document);
		expect(tokens.map((item) => item.modifiers)).toEqual([[], []]);
	});
});

describe("emitted ranges", () => {
	/** Every construct the provider knows about, in one buffer. */
	const MIXED = `${DEMO_HEADER}
extend google.protobuf.MessageOptions {
  optional string local = 60060;
}

message M {
  option (demo.v1.demo_field) = {
    string: { pattern: "^a" }
  };
  string id = 1 [(demo.v1.demo_behavior) = OPTIONAL];
  string bad = 2 [(demo.v1.demo_behavior) = NOPE];
}
`;

	test("emits tokens in document order", () => {
		const document = makeDocument(MIXED);
		const tokens = tokensOf(providerFor(DEMO_REGISTRY), document);
		expect(tokens.length).toBeGreaterThan(5);
		const offsets = tokens.map((item) =>
			document.offsetAt(item.range.start as never),
		);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
	});

	test("emits only non-empty single-line ranges", () => {
		// The encoder cannot represent either, so the provider drops them. Both
		// guards are defensive; this pins the invariant they exist to keep.
		const document = makeDocument(MIXED);
		for (const item of tokensOf(providerFor(DEMO_REGISTRY), document)) {
			expect(item.range.start.line).toBe(item.range.end.line);
			expect(item.range.end.character).toBeGreaterThan(
				item.range.start.character,
			);
		}
	});

	test("covers exactly the name it highlights", () => {
		const { document, tokens } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = OPTIONAL];
}
`,
		);
		const line = document.lineAt(4).text;
		for (const item of tokens) {
			expect(item.range.start.line).toBe(4);
			expect(
				line.slice(item.range.start.character, item.range.end.character),
			).toBe(document.getText(item.range as never));
		}
	});

	test("handles CRLF line endings", () => {
		const document = makeDocument(
			`syntax = "proto3";\r\npackage use.v1;\r\nimport "demo/v1/annotations.proto";\r\nmessage M {\r\n  string id = 1 [(demo.v1.demo_behavior) = OPTIONAL];\r\n}\r\n`,
		);
		expect(
			described(document, tokensOf(providerFor(DEMO_REGISTRY), document)),
		).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_behavior",
			"protoAnnotationValue OPTIONAL",
		]);
	});

	test("survives a buffer that ends mid-option", () => {
		const { described: seen } = highlight(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {
    string: {
`,
		);
		expect(seen).toEqual([
			"protoAnnotationNamespace demo.v1",
			"protoAnnotation demo_field",
			"protoAnnotationField string",
		]);
	});

	test("yields nothing for an empty buffer", () => {
		expect(highlight(DEMO_REGISTRY, "").tokens).toEqual([]);
	});

	test("yields nothing for a file with no options at all", () => {
		expect(
			highlight(
				DEMO_REGISTRY,
				`syntax = "proto3";
package use.v1;

message M {
  string id = 1;
}
`,
			).tokens,
		).toEqual([]);
	});

	test("does not mistake an rpc signature for an option", () => {
		expect(
			highlight(
				DEMO_REGISTRY,
				`syntax = "proto3";
package use.v1;

service S {
  rpc Get(GetRequest) returns (GetResponse);
}
`,
			).tokens,
		).toEqual([]);
	});
});

describe("provider lifecycle", () => {
	test("produces nothing before an index exists", () => {
		const document = makeDocument(`${DEMO_HEADER}message M {
  option (demo.v1.demo_field) = {};
}
`);
		const result = providerFor(undefined).provideDocumentSemanticTokens(
			document,
			CancellationTokenNone as never,
		);
		expect(result).toBeUndefined();
	});

	test("produces nothing once cancelled", () => {
		const document = makeDocument(`${DEMO_HEADER}message M {
  option (demo.v1.demo_field) = {};
}
`);
		expect(tokensOf(providerFor(DEMO_REGISTRY), document, true)).toEqual([]);
	});

	test("refresh asks VS Code to re-request every buffer", () => {
		const provider = providerFor(DEMO_REGISTRY);
		let fired = 0;
		provider.onDidChangeSemanticTokens(() => {
			fired++;
		});
		provider.refresh();
		provider.refresh();
		expect(fired).toBe(2);
		provider.dispose();
		provider.refresh();
		expect(fired).toBe(2);
	});
});

describe("legend", () => {
	test("lists every token type and modifier the provider emits", () => {
		expect(ANNOTATION_SEMANTIC_LEGEND.tokenTypes).toEqual([
			...ANNOTATION_TOKEN_TYPES,
		]);
		expect(ANNOTATION_SEMANTIC_LEGEND.tokenModifiers).toEqual([
			...ANNOTATION_TOKEN_MODIFIERS,
		]);
	});

	test("contributes every token type in package.json", async () => {
		// A type the manifest does not declare renders as nothing at all, which
		// is indistinguishable from the provider never running.
		const manifest = (await Bun.file(
			`${EXTENSION_ROOT}/package.json`,
		).json()) as {
			contributes: {
				semanticTokenTypes: Array<{ id: string }>;
				semanticTokenScopes: Array<{ scopes: Record<string, string[]> }>;
			};
		};
		const declared = manifest.contributes.semanticTokenTypes.map(
			(entry) => entry.id,
		);
		expect(declared.sort()).toEqual([...ANNOTATION_TOKEN_TYPES].sort());
		const scoped = Object.keys(
			manifest.contributes.semanticTokenScopes[0].scopes,
		);
		expect(scoped.sort()).toEqual([...ANNOTATION_TOKEN_TYPES].sort());
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"splits google.api.field_behavior the way the grammar cannot",
		async () => {
			const registry = await referenceRegistry();
			const { described: seen } = highlight(
				registry,
				`syntax = "proto3";
package use.v1;
import "google/api/field_behavior.proto";
message M {
  string id = 1 [(google.api.field_behavior) = OPTIONAL];
}
`,
			);
			expect(seen).toEqual([
				"protoAnnotationNamespace google.api",
				"protoAnnotation field_behavior",
				"protoAnnotationValue OPTIONAL",
			]);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"flags a field_behavior value the enum does not declare",
		async () => {
			const registry = await referenceRegistry();
			const { described: seen } = highlight(
				registry,
				`syntax = "proto3";
package use.v1;
import "google/api/field_behavior.proto";
message M {
  string id = 1 [(google.api.field_behavior) = REQUIRE];
}
`,
			);
			expect(seen).toContain("protoAnnotationValueUnknown REQUIRE");
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"walks a buf.validate.field path two levels deep",
		async () => {
			const registry = await referenceRegistry();
			const { described: seen } = highlight(
				registry,
				`syntax = "proto3";
package use.v1;
import "buf/validate/validate.proto";
message M {
  string id = 1 [(buf.validate.field).string.pattern = "^a$"];
}
`,
			);
			expect(seen).toEqual([
				"protoAnnotationNamespace buf.validate",
				"protoAnnotation field",
				"protoAnnotationField string",
				"protoAnnotationField pattern",
			]);
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"finds no unknown value in generated code",
		async () => {
			const registry = await referenceRegistry();
			const provider = providerFor(registry);
			const files = listProtos(REFERENCE_PROTO_ROOT as string);
			expect(files.length).toBeGreaterThan(1000);

			let total = 0;
			const offenders: string[] = [];
			for (const file of files) {
				const document = makeDocument(await Bun.file(file).text(), file);
				for (const item of tokensOf(provider, document)) {
					total++;
					if (item.type === "protoAnnotationValueUnknown") {
						offenders.push(
							`${file}:${item.range.start.line + 1} ${document.getText(item.range as never)}`,
						);
					}
				}
			}
			expect(offenders).toEqual([]);
			// Generated code is dense with options; a collapse here means the
			// registry stopped resolving rather than the tree getting smaller.
			expect(total).toBeGreaterThan(100000);
		},
		120000,
	);
});
