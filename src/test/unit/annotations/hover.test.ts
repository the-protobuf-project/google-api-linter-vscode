/**
 * Tests for `AnnotationHoverProvider`.
 *
 * The provider picks one of three cards from what the cursor is sitting on, and
 * the choice is the whole feature: hovering `ttl` inside `(cache.v1.cache) = {
 * ttl: {...} }` must document `ttl`, not the option that contains it. Body
 * fields are therefore tested before option names inside the provider, and the
 * tests below pin that ordering along with the range each card highlights — a
 * range that covers the wrong text underlines the wrong word in the editor even
 * when the card itself is right.
 *
 * Every line of every card is derived from the `extend` block and the option
 * body message, so the assertions read card text rather than internal state:
 * that is what a reader actually sees, and the only thing that proves nothing
 * is hardcoded.
 */

import { describe, expect, test } from "bun:test";
import type { Hover, TextDocument } from "vscode";
import { extractAnnotations } from "../../../annotations/extractor";
import { AnnotationHoverProvider } from "../../../annotations/hover";
import { AnnotationRegistryImpl } from "../../../annotations/registry";
import { AnnotationSource } from "../../../annotations/resolve";
import {
	atCursor,
	hasReferenceCorpus,
	referenceRegistry,
} from "../support/fixtures";
import { CancellationTokenNone } from "../support/vscode";

let fileSeq = 0;

/**
 * Builds a registry from proto sources keyed by import path.
 *
 * The `path` given to each file is what puts an absolute path in the "defined
 * in" footer, so the link case below has something to link to.
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
): AnnotationHoverProvider {
	return new AnnotationHoverProvider(new AnnotationSource(undefined, registry));
}

/** A hover request and the buffer it ran against. */
interface Hovered {
	readonly hover: Hover | undefined;
	readonly document: TextDocument;
}

/**
 * Hovers the `▮` in a fixture.
 * @param registry - Registry the provider reads, or undefined for none
 * @param marked - Proto source with exactly one cursor marker
 * @param cancelled - Request a cancelled token instead of a live one
 * @returns The hover, if any, and the document it came from
 */
function hoverAt(
	registry: AnnotationRegistryImpl | undefined,
	marked: string,
	cancelled = false,
): Hovered {
	const { document, position } = atCursor(marked);
	const token = cancelled
		? { ...CancellationTokenNone, isCancellationRequested: true }
		: CancellationTokenNone;
	return {
		document,
		hover: providerFor(registry).provideHover(
			document,
			position as never,
			token as never,
		),
	};
}

/**
 * Markdown of the rendered card.
 *
 * The stub `Hover` keeps whatever the provider handed it; the provider passes a
 * single `MarkdownString`, which the real class would wrap in an array. Reading
 * it directly is the difference.
 *
 * @param hover - The hover under test
 * @returns Card source, or an empty string when there was no hover
 */
function cardOf(hover: Hover | undefined): string {
	return (
		(hover?.contents as unknown as { value: string } | undefined)?.value ?? ""
	);
}

/** Source text the hover highlights. */
function highlighted(hovered: Hovered): string {
	return hovered.hover
		? hovered.document.getText(hovered.hover.range as never)
		: "";
}

/**
 * One annotation bundle: an enum-valued option and one with a nested message
 * body, both documented, one carrying a godoc-style example.
 */
const DEMO_ANNOTATIONS = `syntax = "proto3";
package demo.v1;

enum Behavior {
  BEHAVIOR_UNSPECIFIED = 0;
  // The consumer may leave the field unset.
  OPTIONAL = 1;
  // The consumer must set the field.
  REQUIRED = 2;
}

message StringRules {
  // Anchored regular expression the value must match.
  string pattern = 1;
  uint64 min_len = 2;
}

message FieldRules {
  // Constraints applied to a string field.
  StringRules string = 1;
  bool required = 2;
  Behavior behavior = 3;
}

extend google.protobuf.FieldOptions {
  // How consumers should treat this field.
  //
  //     string id = 1 [(demo.v1.demo_behavior) = REQUIRED];
  optional Behavior demo_behavior = 60001;
  // Validation rules for the field.
  optional FieldRules demo_field = 60002;
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

describe("annotation card", () => {
	test("documents the option name under the cursor", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_be▮havior) = REQUIRED];
}
`,
			).hover,
		);
		expect(card).toContain("### `(demo.v1.demo_behavior)`");
		expect(card).toContain("**field** option · `Behavior` · field 60001");
	});

	test("carries the doc comment and the example block", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.▮demo_behavior) = REQUIRED];
}
`,
			).hover,
		);
		expect(card).toContain("How consumers should treat this field.");
		expect(card).toContain(
			"```proto\nstring id = 1 [(demo.v1.demo_behavior) = REQUIRED];\n```",
		);
	});

	test("lists the members of an enum-valued option", () => {
		// The option takes an enum directly, so the members belong on the card:
		// the type name alone does not tell the reader what to write.
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_beh▮avior) = REQUIRED];
}
`,
			).hover,
		);
		expect(card).toContain(
			"**Values** `BEHAVIOR_UNSPECIFIED` · `OPTIONAL` · `REQUIRED`",
		);
	});

	test("lists every body field of a message-valued option", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_fi▮eld).required = true];
}
`,
			).hover,
		);
		expect(card).toContain("**Fields**");
		expect(card).toContain("- `string` — _StringRules_");
		expect(card).toContain("- `required` — _bool_");
		expect(card).toContain("- `behavior` — _Behavior_");
		// Only the enum-typed field gets a value hint; `StringRules` is a message.
		expect(card).toContain("`BEHAVIOR_UNSPECIFIED` · `OPTIONAL` · `REQUIRED`");
	});

	test("links the footer to the declaring file", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_fie▮ld) = {}];
}
`,
			).hover,
		);
		expect(card).toContain(
			"_Defined in_ [`demo/v1/annotations.proto:31`](file:///repo/demo/v1/annotations.proto#L31)",
		);
	});

	test("never trusts the card, whose text comes from the workspace", () => {
		const { hover } = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_be▮havior) = REQUIRED];
}
`,
		);
		const contents = hover?.contents as unknown as {
			isTrusted: boolean;
			supportHtml: boolean;
		};
		// The card embeds doc comments and examples read out of workspace
		// protos. Trusted markdown activates `command:` links, so a comment in
		// someone else's repository could put a live command in this hover.
		// The footer links with `file://`, which renders untrusted, so nothing
		// here ever needed it.
		expect(contents.isTrusted).toBeFalsy();
		expect(contents.supportHtml).toBe(false);
	});

	test("highlights exactly the option name", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_be▮havior) = REQUIRED];
}
`,
		);
		expect(highlighted(hovered)).toBe("demo.v1.demo_behavior");
	});

	test("highlights a rooted name including its leading dot", () => {
		// `analyzeProtoDocument` reports the name range from the dot onwards even
		// though the resolved fqn drops it, so the underline covers what was
		// written rather than a substring of it.
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(.demo.v1.demo_beh▮avior) = REQUIRED];
}
`,
		);
		expect(highlighted(hovered)).toBe(".demo.v1.demo_behavior");
		expect(cardOf(hovered.hover)).toContain("### `(demo.v1.demo_behavior)`");
	});

	test("documents an option written unqualified inside its own package", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`syntax = "proto3";
package demo.v1;
import "demo/v1/annotations.proto";
message M {
  string id = 1 [(demo_beh▮avior) = REQUIRED];
}
`,
			).hover,
		);
		expect(card).toContain("### `(demo.v1.demo_behavior)`");
	});

	test("documents an option the file never imports", () => {
		// Hover is how a reader finds out what an unfamiliar option is, so it
		// answers regardless of the import closure. The missing import is
		// diagnostics' business, not this provider's.
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`syntax = "proto3";
package use.v1;
message M {
  string id = 1 [(demo.v1.demo_beh▮avior) = REQUIRED];
}
`,
			).hover,
		);
		expect(card).toContain("### `(demo.v1.demo_behavior)`");
	});

	test("says nothing about an option no extend block declares", () => {
		expect(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.no_such_▮option) = 1];
}
`,
			).hover,
		).toBeUndefined();
	});

	test("says nothing on the parenthesis before the name", () => {
		expect(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [▮(demo.v1.demo_behavior) = REQUIRED];
}
`,
			).hover,
		).toBeUndefined();
	});

	test("documents an option attached to a message rather than a field", () => {
		// The card describes the annotation as declared; whether the target is
		// legal here is a diagnostic, not a reason to withhold the card.
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  option (demo.v1.demo_b▮ehavior) = REQUIRED;
}
`,
			).hover,
		);
		expect(card).toContain("**field** option");
	});
});

describe("field card", () => {
	test("documents a field reached through a dotted accessor", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).string.pat▮tern = "^a$"];
}
`,
		);
		const card = cardOf(hovered.hover);
		expect(card).toContain("### `string.pattern`");
		expect(card).toContain("`string` · field 1 · in `(demo.v1.demo_field)`");
		expect(card).toContain("Anchored regular expression the value must match.");
		expect(highlighted(hovered)).toBe("pattern");
	});

	test("documents the intermediate segment of an accessor path", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).str▮ing.pattern = "^a$"];
}
`,
		);
		const card = cardOf(hovered.hover);
		expect(card).toContain("### `string`");
		expect(card).toContain("Constraints applied to a string field.");
		// A message-typed field expands into the fields legal one level down.
		expect(card).toContain("**`demo.v1.StringRules` fields**");
		expect(card).toContain("- `min_len` — _uint64_");
		expect(highlighted(hovered)).toBe("string");
	});

	test("documents a field written inside a text-format body", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {
    string: { patt▮ern: "^a$" }
    required: true
  }];
}
`,
		);
		expect(cardOf(hovered.hover)).toContain("### `string.pattern`");
		expect(highlighted(hovered)).toBe("pattern");
	});

	test("lists the members of an enum-valued body field", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).beha▮vior = OPTIONAL];
}
`,
			).hover,
		);
		expect(card).toContain(
			"**Values** `BEHAVIOR_UNSPECIFIED` · `OPTIONAL` · `REQUIRED`",
		);
	});

	test("beats the option name when the cursor could mean either", () => {
		// The body field is the inner region, so it must be tested first. Landing
		// on the annotation card here would document the wrong thing entirely.
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).requi▮red = true];
}
`,
			).hover,
		);
		expect(card).toContain("### `required`");
		expect(card).not.toContain("**Fields**");
	});

	test("says nothing about a field the body does not declare", () => {
		expect(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field).no_such_fi▮eld = 1];
}
`,
			).hover,
		).toBeUndefined();
	});

	test("says nothing about a field of an unknown option", () => {
		expect(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.no_such_option).fi▮eld = 1];
}
`,
			).hover,
		).toBeUndefined();
	});
});

describe("declaration card", () => {
	test("documents the extension field an extend block declares", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			DEMO_ANNOTATIONS.replace(
				"demo_behavior = 60001",
				"demo_beh▮avior = 60001",
			),
		);
		const card = cardOf(hovered.hover);
		expect(card).toContain("### `(demo.v1.demo_behavior)`");
		expect(card).toContain(
			"_Used as_ `option (demo.v1.demo_behavior) = …;` on a field.",
		);
		expect(highlighted(hovered)).toBe("demo_behavior");
	});

	test("names the right element for a Method option", () => {
		const source = `syntax = "proto3";
package rpcopt.v1;

extend google.protobuf.MethodOptions {
  optional string tool = 60003;
}
`;
		const registry = registryFrom({ "rpcopt/v1/annotations.proto": source });
		const card = cardOf(
			hoverAt(registry, source.replace("tool = 60003", "to▮ol = 60003")).hover,
		);
		expect(card).toContain("**rpc** option · `string` · field 60003");
		expect(card).toContain("on a rpc.");
	});

	test("says nothing about a declaration the registry has not seen", () => {
		// The buffer's own `extend` block is in the model, but the card is
		// rendered from the indexed descriptor, so an unsaved bundle documents
		// nothing until a scan has reached it.
		const source = `syntax = "proto3";
package fresh.v1;

extend google.protobuf.MessageOptions {
  optional string lo▮cal = 60004;
}
`;
		expect(hoverAt(DEMO_REGISTRY, source).hover).toBeUndefined();
	});

	test("says nothing inside an extend block that is not an options message", () => {
		const source = `syntax = "proto3";
package demo.v1;

extend some.other.Message {
  optional string not_an_▮option = 9;
}
`;
		expect(hoverAt(DEMO_REGISTRY, source).hover).toBeUndefined();
	});
});

describe("value card", () => {
	test("documents the enum member assigned to an option", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = REQU▮IRED];
}
`,
			).hover,
		);
		expect(card).toContain("### `REQUIRED`");
		expect(card).toContain(
			"`demo.v1.Behavior` · value 2 · assigned to `(demo.v1.demo_behavior)`",
		);
		expect(card).toContain("The consumer must set the field.");
	});

	test("documents a member assigned to a body field", () => {
		// The enum is reached through the body message, not through the
		// option's own type, which is the case that used to resolve to nothing.
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_field) = {
    behavior: OPTI▮ONAL
  }];
}
`,
			).hover,
		);
		expect(card).toContain("### `OPTIONAL`");
		expect(card).toContain("assigned to `behavior` in `(demo.v1.demo_field)`");
		expect(card).toContain("The consumer may leave the field unset.");
	});

	test("lists the alternatives with the current one marked", () => {
		// The question a reader hovers a value to ask is "is this the right
		// one", which only the other members answer.
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = REQ▮UIRED];
}
`,
			).hover,
		);
		expect(card).toContain("**`Behavior` values**");
		expect(card).toContain("- `BEHAVIOR_UNSPECIFIED` = 0");
		expect(card).toContain(
			"- `OPTIONAL` = 1 — The consumer may leave the field unset.",
		);
		expect(card).toContain("- **`REQUIRED`** = 2");
	});

	test("says a value the enum does not declare is not one", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = REQU▮IRE];
}
`,
			).hover,
		);
		expect(card).toContain("**Not a value of** `demo.v1.Behavior`");
		// Still lists what is legal: the card exists to fix the mistake.
		expect(card).toContain("- `REQUIRED` = 2");
	});

	test("highlights the value alone", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = REQ▮UIRED];
}
`,
		);
		expect(highlighted(hovered)).toBe("REQUIRED");
	});

	test("windows a long enum around the value under the cursor", () => {
		// `Unit` in the VSS vocabulary has 76 members. Listing all of them
		// produces a hover nobody reads, and listing the first twelve never
		// contains the one being hovered.
		const values = Array.from(
			{ length: 40 },
			(_, i) => `  VALUE_${i} = ${i};`,
		).join("\n");
		const registry = registryFrom({
			"wide/v1/annotations.proto": `syntax = "proto3";
package wide.v1;

enum Wide {
${values}
}

extend google.protobuf.FieldOptions {
  // Picks one of many.
  optional Wide wide = 60003;
}
`,
		});
		const card = cardOf(
			hoverAt(
				registry,
				`syntax = "proto3";
package use.v1;
import "wide/v1/annotations.proto";
message M {
  string id = 1 [(wide.v1.wide) = VALUE_3▮0];
}
`,
			).hover,
		);
		expect(card).toContain("### `VALUE_30`");
		expect(card).toContain("- **`VALUE_30`** = 30");
		// Two before it, so it reads as part of a list rather than the top of one.
		expect(card).toContain("- `VALUE_28` = 28");
		expect(card).not.toContain("`VALUE_27` = 27");
		expect(card).not.toContain("`VALUE_0` = 0");
		expect(card).toContain("_40 values in all;");
	});

	test("links the file the enum is declared in", () => {
		const card = cardOf(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavior) = REQUIR▮ED];
}
`,
			).hover,
		);
		expect(card).toContain("_Defined in_ [`demo/v1/annotations.proto:4`]");
	});
});

describe("nothing to document", () => {
	/** Cursor positions that are ordinary proto, not annotation syntax. */
	const plain = [
		["a message name", `${DEMO_HEADER}message ▮M {\n  string id = 1;\n}\n`],
		["a field name", `${DEMO_HEADER}message M {\n  string i▮d = 1;\n}\n`],
		["a field type", `${DEMO_HEADER}message M {\n  str▮ing id = 1;\n}\n`],
		["the package statement", `syntax = "proto3";\npackage u▮se.v1;\n`],
		["an import path", `${DEMO_HEADER.replace("demo/v1", "demo▮/v1")}`],
		[
			"an rpc signature",
			`${DEMO_HEADER}service S {\n  rpc Get(Get▮Request) returns (GetResponse);\n}\n`,
		],
		["a comment", `${DEMO_HEADER}// demo.v1.demo_b▮ehavior lives next door\n`],
		[
			"a bool value",
			`${DEMO_HEADER}message M {\n  string id = 1 [(demo.v1.demo_field).required = tr▮ue];\n}\n`,
		],
		[
			"a string literal",
			`${DEMO_HEADER}message M {\n  string id = 1 [(demo.v1.demo_field).string.pattern = "demo.v1.dem▮o_field"];\n}\n`,
		],
	] as const;

	for (const [what, fixture] of plain) {
		test(`says nothing on ${what}`, () => {
			expect(hoverAt(DEMO_REGISTRY, fixture).hover).toBeUndefined();
		});
	}

	test("says nothing in an empty buffer", () => {
		expect(hoverAt(DEMO_REGISTRY, "▮").hover).toBeUndefined();
	});

	test("says nothing before an index exists", () => {
		expect(
			hoverAt(
				undefined,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_beh▮avior) = REQUIRED];
}
`,
			).hover,
		).toBeUndefined();
	});

	test("says nothing once cancelled", () => {
		expect(
			hoverAt(
				DEMO_REGISTRY,
				`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_beh▮avior) = REQUIRED];
}
`,
				true,
			).hover,
		).toBeUndefined();
	});
});

describe("offsets", () => {
	test("highlights the right text after CRLF line endings", () => {
		// The scanner counts `\r` as a character; a range computed without it
		// would slide one column left per preceding line.
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`syntax = "proto3";\r\npackage use.v1;\r\nimport "demo/v1/annotations.proto";\r\nmessage M {\r\n  string id = 1 [(demo.v1.demo_be▮havior) = REQUIRED];\r\n}\r\n`,
		);
		expect(highlighted(hovered)).toBe("demo.v1.demo_behavior");
	});

	test("highlights the right text after an astral-plane character", () => {
		// A surrogate pair is two UTF-16 units; both the model and the document
		// count them the same way, so the range stays on the name.
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}// 🏥 hospital resources
message M {
  string id = 1 [(demo.v1.demo_beh▮avior) = REQUIRED];
}
`,
		);
		expect(highlighted(hovered)).toBe("demo.v1.demo_behavior");
	});

	test("survives a buffer that ends mid-option", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_fi▮eld) = {
    string: {
`,
		);
		expect(cardOf(hovered.hover)).toContain("### `(demo.v1.demo_field)`");
	});

	test("highlights the last name in a buffer with no trailing newline", () => {
		const hovered = hoverAt(
			DEMO_REGISTRY,
			`${DEMO_HEADER}message M {
  string id = 1 [(demo.v1.demo_behavi▮or) = REQUIRED];
}`,
		);
		expect(highlighted(hovered)).toBe("demo.v1.demo_behavior");
	});
});

describe("against the real corpus", () => {
	test.skipIf(!hasReferenceCorpus())(
		"documents google.api.field_behavior from its own extend block",
		async () => {
			const registry = await referenceRegistry();
			const card = cardOf(
				hoverAt(
					registry,
					`syntax = "proto3";
package use.v1;
import "google/api/field_behavior.proto";
message M {
  string id = 1 [(google.api.field_beh▮avior) = OPTIONAL];
}
`,
				).hover,
			);
			expect(card).toContain("### `(google.api.field_behavior)`");
			expect(card).toContain("**field** option");
			expect(card).toContain("`OPTIONAL`");
			expect(card).toContain("_Defined in_");
		},
	);

	test.skipIf(!hasReferenceCorpus())(
		"documents a buf.validate.field path two levels deep",
		async () => {
			const registry = await referenceRegistry();
			const hovered = hoverAt(
				registry,
				`syntax = "proto3";
package use.v1;
import "buf/validate/validate.proto";
message M {
  string id = 1 [(buf.validate.field).string.patt▮ern = "^a$"];
}
`,
			);
			expect(cardOf(hovered.hover)).toContain("### `string.pattern`");
			expect(cardOf(hovered.hover)).toContain("in `(buf.validate.field)`");
			expect(highlighted(hovered)).toBe("pattern");
		},
	);
});
