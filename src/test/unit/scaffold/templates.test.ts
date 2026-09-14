/**
 * Tests for the scaffolded starter project and CI workflow.
 *
 * The load-bearing guarantee is that the starter lints clean. A starter that
 * arrives with errors teaches the wrong lesson on the first run — the reader
 * cannot tell the template's mistakes from their own — so the templates are
 * pure data precisely so this suite can generate them and check.
 *
 * Two of the assertions here are regressions. The first draft put the protos
 * under a `protobuf/` prefix the package did not name, which trips
 * `core::0191::proto-package`, and declared the `Priority` enum between two
 * messages, which trips `core::0191::file-layout`. Both were found by running
 * the real linter against generated output rather than by reading it.
 */

import { describe, expect, test } from "bun:test";
import {
	ciWorkflow,
	packageDirectory,
	starterFiles,
} from "../../../scaffold/templates";

/** The starter as generated for a conventional package. */
const FILES = starterFiles({ packageName: "acme.todo.v1", withCi: true });

/** One generated file's contents, by path. */
function file(path: string): string {
	const found = FILES.find((f) => f.path === path);
	expect(found, `no generated file at ${path}`).toBeDefined();
	return (found as { contents: string }).contents;
}

describe("packageDirectory", () => {
	test("mirrors the package exactly, with nothing above it", () => {
		// `core::0191::proto-package` compares a file's directory against its
		// package, so any extra leading segment is an error in the starter.
		expect(packageDirectory("acme.todo.v1")).toBe("acme/todo/v1");
		expect(packageDirectory("a.b.c.d.v2")).toBe("a/b/c/d/v2");
	});
});

describe("starter layout", () => {
	test("writes the protos where the package says they go", () => {
		expect(FILES.map((f) => f.path)).toContain("acme/todo/v1/todo.proto");
		expect(FILES.map((f) => f.path)).toContain(
			"acme/todo/v1/todo_service.proto",
		);
	});

	test("declares the package the directory implies", () => {
		expect(file("acme/todo/v1/todo.proto")).toContain("package acme.todo.v1;");
		expect(file("acme/todo/v1/todo_service.proto")).toContain(
			"package acme.todo.v1;",
		);
	});

	test("puts the enum after every message", () => {
		// `core::0191::file-layout`. An enum declared between two messages is a
		// finding, and it is the kind a reader would copy without noticing.
		const proto = file("acme/todo/v1/todo.proto");
		const lastMessage = proto.lastIndexOf("\nmessage ");
		const theEnum = proto.indexOf("\nenum ");
		expect(theEnum).toBeGreaterThan(lastMessage);
	});

	test("carries the options AIP-191 asks every file for", () => {
		for (const name of [
			"acme/todo/v1/todo.proto",
			"acme/todo/v1/todo_service.proto",
		]) {
			const proto = file(name);
			expect(proto).toContain("option java_multiple_files = true;");
			expect(proto).toContain('option java_package = "com.acme.todo.v1";');
			expect(proto).toMatch(/option java_outer_classname = "\w+";/);
		}
	});

	test("states a field_behavior on every field of the resource", () => {
		const proto = file("acme/todo/v1/todo.proto");
		// `core::0203::field-behavior-required` fires on any field without one,
		// and `resource-name-identifier` wants `name` specifically IDENTIFIER.
		expect(proto).toContain(
			"string name = 1 [(google.api.field_behavior) = IDENTIFIER];",
		);
		const resourceBody = proto.slice(
			proto.indexOf("message Todo {"),
			proto.indexOf("// Request for TodoService.GetTodo."),
		);
		const fields = resourceBody.match(/^\s+\S+ \w+ = \d+/gm) ?? [];
		expect(fields.length).toBeGreaterThan(0);
		expect(resourceBody.match(/field_behavior/g)?.length).toBe(fields.length);
	});

	test("declares the resource with both singular and plural", () => {
		// `core::0123::resource-singular` and `-plural` are the two findings a
		// hand-written resource most often carries.
		const proto = file("acme/todo/v1/todo.proto");
		expect(proto).toContain('type: "acme.todo.v1/Todo"');
		expect(proto).toContain('singular: "todo"');
		expect(proto).toContain('plural: "todos"');
	});

	test("gives each standard method its http binding and signature", () => {
		const proto = file("acme/todo/v1/todo_service.proto");
		for (const rpc of [
			"GetTodo",
			"ListTodos",
			"CreateTodo",
			"UpdateTodo",
			"DeleteTodo",
		]) {
			expect(proto).toContain(`rpc ${rpc}(`);
		}
		expect(proto.match(/google\.api\.http/g)).toHaveLength(5);
		expect(proto.match(/google\.api\.method_signature/g)).toHaveLength(5);
	});

	test("names the module only when one was given", () => {
		expect(file("buf.yaml")).not.toContain("name:");
		const named = starterFiles({
			packageName: "acme.todo.v1",
			moduleName: "buf.build/acme/todo",
			withCi: false,
		});
		const yaml = named.find((f) => f.path === "buf.yaml");
		expect(yaml?.contents).toContain("name: buf.build/acme/todo");
	});

	test("includes the workflow only when asked", () => {
		expect(FILES.map((f) => f.path)).toContain(
			".github/workflows/proto-lint.yml",
		);
		const without = starterFiles({
			packageName: "acme.todo.v1",
			withCi: false,
		});
		expect(without.map((f) => f.path)).not.toContain(
			".github/workflows/proto-lint.yml",
		);
	});
});

describe("ciWorkflow", () => {
	test("pins the action and lets buf resolve googleapis", () => {
		const yaml = ciWorkflow(".").contents;
		expect(yaml).toContain(
			"uses: the-protobuf-project/setup-google-api-linter@v1",
		);
		// Without `buf: true` the action cannot resolve `google/api/*`, and
		// every annotated proto fails to compile rather than to lint.
		expect(yaml).toContain("buf: true");
		expect(yaml).toContain("uses: actions/checkout@v4");
	});

	test("omits working-directory when the module is at the root", () => {
		expect(ciWorkflow(".").contents).not.toContain("working-directory:");
	});

	test("passes the module's directory when it is not the root", () => {
		expect(ciWorkflow("proto").contents).toContain("working-directory: proto");
	});

	test("asks for the permissions inline annotations need", () => {
		const yaml = ciWorkflow(".").contents;
		expect(yaml).toContain("checks: write");
		expect(yaml).toContain("pull-requests: write");
	});
});
