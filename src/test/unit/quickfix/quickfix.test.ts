/**
 * Tests for linter-driven quick fixes.
 *
 * Every message quoted here is verbatim output from `api-linter 2.3.1` run
 * against a real AIP service, not a paraphrase. That matters because the whole
 * design rests on the linter stating its own fix — if the wording these parse
 * were invented, the tests would pass against a linter that does not exist.
 *
 * The rule the module follows, and most of what is asserted below: decline
 * rather than guess. A lightbulb that does not appear costs a reader nothing.
 * A fix that writes the wrong value into their schema costs them a review
 * cycle, and teaches them to stop trusting the fixes that are right.
 */

import { describe, expect, test } from "bun:test";
import {
	applyChanges,
	changeFor,
	fieldOptionChange,
	fileOptionInsertion,
	methodOptionChange,
	resourceKeyChange,
	withoutCollisions,
} from "../../../quickfix/edits";
import { intendedFix, pluralise } from "../../../quickfix/rules";

const CTX = {
	packageName: "library.v1",
	fileStem: "library",
	resourceSingular: "book",
};

describe("reading the fix out of the message", () => {
	test("takes the classname the linter names", () => {
		const fix = intendedFix(
			"core::0191::java-outer-classname",
			'Proto files should set `option java_outer_classname = "LibraryProto"`.',
			CTX,
		);
		expect(fix).toEqual({
			kind: "fileOption",
			option: "java_outer_classname",
			value: '"LibraryProto"',
		});
	});

	test("derives java_package, which the message names but does not value", () => {
		const fix = intendedFix(
			"core::0191::java-package",
			"Proto files must set `option java_package`.",
			CTX,
		);
		// AIP-191 prescribes the proto package under `com.`.
		expect(fix).toEqual({
			kind: "fileOption",
			option: "java_package",
			value: '"com.library.v1"',
		});
	});

	test("declines java_package when the file declares no package", () => {
		expect(
			intendedFix(
				"core::0191::java-package",
				"Proto files must set `option java_package`.",
				{},
			),
		).toBeUndefined();
	});

	test("takes a method signature verbatim", () => {
		expect(
			intendedFix(
				"core::0133::method-signature",
				'Create methods should include `(google.api.method_signature) = "parent,book"`',
				CTX,
			),
		).toEqual({
			kind: "methodOption",
			option: "(google.api.method_signature)",
			value: '"parent,book"',
		});
	});

	test("names both the field and the behaviour it needs", () => {
		expect(
			intendedFix(
				"core::0148::field-behavior",
				"The `create_time` field should include `(google.api.field_behavior) = OUTPUT_ONLY`.",
				CTX,
			),
		).toEqual({
			kind: "fieldOption",
			field: "create_time",
			option: "(google.api.field_behavior)",
			value: "OUTPUT_ONLY",
		});
	});

	test("knows the resource name field is always `name`", () => {
		// The message says only "resource name field must have field_behavior
		// IDENTIFIER" — the field is implied by what the rule is about.
		expect(
			intendedFix(
				"core::0203::resource-name-identifier",
				"resource name field must have field_behavior IDENTIFIER",
				CTX,
			),
		).toEqual({
			kind: "fieldOption",
			field: "name",
			option: "(google.api.field_behavior)",
			value: "IDENTIFIER",
		});
	});

	test("derives a plural only when the singular is known", () => {
		const message = "Resources should declare plural.";
		expect(intendedFix("core::0123::resource-plural", message, CTX)).toEqual({
			kind: "resourceKey",
			key: "plural",
			value: '"books"',
		});
		// Without a singular there is nothing to pluralise, and inventing one
		// would put a wrong string in the schema.
		expect(
			intendedFix("core::0123::resource-plural", message, {}),
		).toBeUndefined();
	});

	test("declines the rules that state no single answer", () => {
		// Four acceptable values and no way to choose between them.
		expect(
			intendedFix(
				"core::0203::field-behavior-required",
				'google.api.field_behavior annotation must be set on "title" and contain one of, "{"IMMUTABLE", "OPTIONAL", "OUTPUT_ONLY", "REQUIRED"}"',
				CTX,
			),
		).toBeUndefined();

		// Needs a resource type this module cannot see.
		expect(
			intendedFix(
				"core::0131::request-name-reference",
				"The `name` field should include a `google.api.resource_reference` annotation.",
				CTX,
			),
		).toBeUndefined();

		// A structural change, not an annotation.
		expect(
			intendedFix(
				"core::0133::request-id-field",
				"create methods should contain a singular `string book_id` field.",
				CTX,
			),
		).toBeUndefined();
	});
});

describe("pluralise", () => {
	test("handles the regular cases", () => {
		expect(pluralise("book")).toBe("books");
		expect(pluralise("box")).toBe("boxes");
		expect(pluralise("branch")).toBe("branches");
		expect(pluralise("company")).toBe("companies");
	});
});

describe("placement", () => {
	const FILE = [
		'syntax = "proto3";',
		"",
		"package library.v1;",
		"",
		'option java_package = "com.library.v1";',
		"",
		"message Book {",
		"  option (google.api.resource) = {",
		'    type: "library.googleapis.com/Book"',
		'    pattern: "shelves/{shelf}/books/{book}"',
		"  };",
		"",
		"  string name = 1;",
		"  string title = 2 [(google.api.field_behavior) = OPTIONAL];",
		"}",
		"",
		"service LibraryService {",
		"  rpc GetBook(GetBookRequest) returns (Book) {",
		'    option (google.api.http) = {get: "/v1/{name=shelves/*/books/*}"};',
		"  }",
		"  rpc DeleteBook(DeleteBookRequest) returns (Empty);",
		"}",
	];

	test("groups a new file option with the existing ones", () => {
		const change = fileOptionInsertion(FILE, "java_multiple_files", "true");
		expect(change?.line).toBe(5);
		expect(change?.text).toBe("option java_multiple_files = true;");
	});

	test("creates an options block on a field that has none", () => {
		const change = fieldOptionChange(
			FILE,
			"name",
			"(google.api.field_behavior)",
			"IDENTIFIER",
			12,
		);
		expect(change?.text).toBe(
			"  string name = 1 [(google.api.field_behavior) = IDENTIFIER];",
		);
	});

	test("appends into a field's existing options block", () => {
		const change = fieldOptionChange(
			FILE,
			"title",
			"(google.api.resource_reference)",
			"{}",
			13,
		);
		expect(change?.text).toContain("OPTIONAL, (google.api.resource_reference)");
		expect(change?.text.endsWith("];")).toBe(true);
	});

	test("declines a field whose options already span lines", () => {
		// Reflowing an existing multi-line block is a formatting decision, and
		// getting it wrong shows up as a diff nobody asked for.
		const multiline = [
			"  string name = 1 [",
			"    (google.api.field_behavior) = REQUIRED",
			"  ];",
		];
		expect(fieldOptionChange(multiline, "name", "(x)", "Y", 0)).toBeUndefined();
	});

	test("adds a method option inside an existing rpc body", () => {
		const change = methodOptionChange(
			FILE,
			17,
			"(google.api.method_signature)",
			'"name"',
		);
		expect(change?.kind).toBe("insertLine");
		expect(change?.line).toBe(18);
	});

	test("opens a body on an rpc that ends in a semicolon", () => {
		const change = methodOptionChange(
			FILE,
			20,
			"(google.api.method_signature)",
			'"name"',
		);
		expect(change?.kind).toBe("replaceLine");
		expect(change?.text).toContain("returns (Empty) {");
		expect(change?.text).toContain("option (google.api.method_signature)");
		expect(change?.text.trimEnd().endsWith("}")).toBe(true);
	});

	test("adds a resource key after the last one", () => {
		const change = resourceKeyChange(FILE, "singular", '"book"', 7);
		expect(change?.line).toBe(10);
		expect(change?.text).toBe('    singular: "book"');
	});

	test("declines a resource key that is already declared", () => {
		expect(resourceKeyChange(FILE, "pattern", '"x"', 7)).toBeUndefined();
	});

	test("declines a resource key when no resource is declared", () => {
		expect(
			resourceKeyChange(["message M {", "}"], "plural", '"xs"'),
		).toBeUndefined();
	});
});

describe("composing a fix-all", () => {
	test("drops a second change to the same line rather than corrupting it", () => {
		// The bug this exists for. Every change is computed against the original
		// text, so two replacements of one line cannot both apply: the second
		// would rewrite text the first produced. Applying both duplicated a
		// field declaration and produced a proto that would not compile.
		const changes = [
			{ kind: "replaceLine" as const, line: 3, text: "first" },
			{ kind: "replaceLine" as const, line: 3, text: "second" },
			{ kind: "replaceLine" as const, line: 5, text: "other" },
		];
		const kept = withoutCollisions(changes);
		expect(kept).toHaveLength(2);
		expect(kept[0].text).toBe("first");
	});

	test("applies bottom-up so earlier line numbers stay valid", () => {
		const lines = ["a", "b", "c"];
		const out = applyChanges(lines, [
			{ kind: "insertLine", line: 0, text: "top" },
			{ kind: "insertLine", line: 2, text: "middle" },
		]);
		expect(out.split("\n")).toEqual(["top", "a", "b", "middle", "c"]);
	});

	test("routes each fix kind to its placement", () => {
		const lines = ["package p;", "message M {", "  string a = 1;", "}"];
		expect(
			changeFor(lines, {
				kind: "fileOption",
				option: "x",
				value: "true",
			})?.kind,
		).toBe("insertLine");
		expect(
			changeFor(
				lines,
				{ kind: "fieldOption", field: "a", option: "(o)", value: "V" },
				2,
			)?.kind,
		).toBe("replaceLine");
	});

	test("declines a method option with no line to anchor it", () => {
		// Which rpc is meant comes from the finding's own position; without one
		// there is no way to know.
		expect(
			changeFor(["rpc A(R) returns (S);"], {
				kind: "methodOption",
				option: "(o)",
				value: "V",
			}),
		).toBeUndefined();
	});
});
