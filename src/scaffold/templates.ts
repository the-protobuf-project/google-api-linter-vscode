/**
 * File contents for the starter project and the CI workflow.
 *
 * Kept as data rather than written inline at the call site so the whole
 * scaffold can be generated into a temp directory and linted in a test. A
 * starter that does not pass the linter it ships with teaches the wrong thing
 * on the first run, and that is only catchable if the templates are reachable
 * without a workspace.
 *
 * The protos are the smoke-test TODO service with one correction: the package
 * and the directory agree. `protobuf/service/` holding `protobuf.service.todo.v1`
 * trips `core::0191::proto-package`, so the layout follows the
 * `<domain>/<version>/` convention the rule expects.
 */

/** One file the scaffold writes. */
export interface ScaffoldFile {
	/** Path relative to the target directory, forward-slashed. */
	readonly path: string;
	readonly contents: string;
}

/** What to call the module in `buf.yaml`, and where its protos live. */
export interface StarterOptions {
	/** Registry module name, e.g. `buf.build/acme/todo`. Omitted when empty. */
	readonly moduleName?: string;
	/** Proto package, e.g. `acme.todo.v1`. */
	readonly packageName: string;
	/** Include the GitHub Actions workflow. */
	readonly withCi: boolean;
}

/**
 * `acme.todo.v1` → `acme/todo/v1`.
 *
 * Exactly the package, with no prefix above it. `core::0191::proto-package`
 * compares a file's directory against its package name, so any extra leading
 * segment — a `protobuf/` root, say — is a lint error in the starter itself.
 */
export function packageDirectory(packageName: string): string {
	return packageName.split(".").join("/");
}

/** `acme.todo.v1` → `com.acme.todo.v1`, the Java package AIP-191 asks for. */
function javaPackage(packageName: string): string {
	return `com.${packageName}`;
}

/**
 * The GitHub Actions workflow.
 *
 * `buf: true` with `working-directory` is what resolves `google/api/*`: the
 * action exports the module's dependencies before linting, so the imports that
 * every AIP annotation needs are present without vendoring googleapis into the
 * repository.
 *
 * @param protoDir - Directory holding `buf.yaml`, relative to the repo root
 * @returns The workflow file
 */
export function ciWorkflow(protoDir = "."): ScaffoldFile {
	const wd =
		protoDir === "." ? "" : `\n          working-directory: ${protoDir}`;
	return {
		path: ".github/workflows/proto-lint.yml",
		contents: `# Lints every .proto against the Google AIP rules on each push and pull
# request. Problems are annotated inline on the diff and summarised on the job.
#
# https://github.com/the-protobuf-project/setup-google-api-linter
name: Proto Lint

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    name: api-linter
    runs-on: ubuntu-latest
    permissions:
      # Inline annotations are written through the Checks API.
      contents: read
      checks: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: the-protobuf-project/setup-google-api-linter@v1
        with:
          # Resolves the deps in buf.yaml, so \`import "google/api/…"\` is
          # found without committing googleapis to this repository.
          buf: true${wd}
          paths: "**/*.proto"
`,
	};
}

/**
 * Every file of the starter project.
 *
 * @param options - Module name, package and whether to include CI
 * @returns Files to write, in the order they should appear
 */
export function starterFiles(options: StarterOptions): ScaffoldFile[] {
	const { packageName, moduleName, withCi } = options;
	const dir = packageDirectory(packageName);
	const java = javaPackage(packageName);
	const files: ScaffoldFile[] = [];

	files.push({
		path: "buf.yaml",
		contents: `version: v2
${moduleName ? `modules:\n  - path: .\n    name: ${moduleName}\n` : "modules:\n  - path: .\n"}deps:
  - buf.build/googleapis/googleapis
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
`,
	});

	files.push({
		path: "buf.gen.yaml",
		contents: `version: v2
managed:
  enabled: true
  override:
    - file_option: java_package_prefix
      value: com
plugins:
  - remote: buf.build/protocolbuffers/plugins/go
    out: gen/go
    opt:
      - paths=source_relative
  - remote: buf.build/grpc/plugins/go
    out: gen/go
    opt:
      - paths=source_relative
`,
	});

	files.push({
		path: ".api-linter.yaml",
		contents: `# api-linter configuration. The file is a list of rule blocks.
# Each block's included_paths / excluded_paths decide which protos it governs,
# relative to this file's directory.
# https://linter.aip.dev/configuration
---
- included_paths:
    - "**/*.proto"
  disabled_rules: []

# Silence every rule for a vendored or generated tree:
# - included_paths:
#     - "vendor/**/*.proto"
#   disabled_rules:
#     - all
`,
	});

	files.push({
		path: "workspace.protobuf.yaml",
		contents: `# Proto workspace config for the Protobuf AIP Linter extension.
# Its presence is what marks this directory as a proto workspace.

# Directories containing .proto files. Defaults to this one.
# proto_path: .

# Folders and files the linter should skip entirely. A bare directory name
# covers everything under it; * and ** work as usual.
# exclude:
#   - vendor
#   - third_party
#   - "**/*.pb.proto"
`,
	});

	/* ---------------------------------------------------------------- *
	 * The resource and its request messages
	 * ---------------------------------------------------------------- */

	files.push({
		path: `${dir}/todo.proto`,
		contents: `syntax = "proto3";

package ${packageName};

import "google/api/field_behavior.proto";
import "google/api/resource.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/timestamp.proto";

option java_multiple_files = true;
option java_outer_classname = "TodoProto";
option java_package = "${java}";

// A task a user intends to complete.
message Todo {
  option (google.api.resource) = {
    type: "${packageName}/Todo"
    pattern: "users/{user}/todos/{todo}"
    singular: "todo"
    plural: "todos"
  };

  // The resource name of the todo.
  // Format: users/{user}/todos/{todo}
  string name = 1 [(google.api.field_behavior) = IDENTIFIER];

  // Short description of what is to be done.
  string title = 2 [(google.api.field_behavior) = REQUIRED];

  // Longer detail, if the title is not enough.
  string description = 3 [(google.api.field_behavior) = OPTIONAL];

  // Whether the todo has been completed.
  bool completed = 4 [(google.api.field_behavior) = OPTIONAL];

  // How urgent the todo is.
  Priority priority = 5 [(google.api.field_behavior) = OPTIONAL];

  // When the todo was created.
  google.protobuf.Timestamp create_time = 6
      [(google.api.field_behavior) = OUTPUT_ONLY];

  // When the todo was last modified.
  google.protobuf.Timestamp update_time = 7
      [(google.api.field_behavior) = OUTPUT_ONLY];
}

// Request for TodoService.GetTodo.
message GetTodoRequest {
  // The todo to retrieve.
  // Format: users/{user}/todos/{todo}
  string name = 1 [
    (google.api.field_behavior) = REQUIRED,
    (google.api.resource_reference) = {type: "${packageName}/Todo"}
  ];
}

// Request for TodoService.ListTodos.
message ListTodosRequest {
  // The user whose todos are listed.
  // Format: users/{user}
  string parent = 1 [
    (google.api.field_behavior) = REQUIRED,
    (google.api.resource_reference) = {child_type: "${packageName}/Todo"}
  ];

  // Maximum todos to return. The server may return fewer.
  int32 page_size = 2 [(google.api.field_behavior) = OPTIONAL];

  // A page token from a previous ListTodos call.
  string page_token = 3 [(google.api.field_behavior) = OPTIONAL];
}

// Response for TodoService.ListTodos.
message ListTodosResponse {
  // The todos on this page.
  repeated Todo todos = 1;

  // Passed to the next ListTodos call, or empty when this is the last page.
  string next_page_token = 2;
}

// Request for TodoService.CreateTodo.
message CreateTodoRequest {
  // The user the todo is created under.
  // Format: users/{user}
  string parent = 1 [
    (google.api.field_behavior) = REQUIRED,
    (google.api.resource_reference) = {child_type: "${packageName}/Todo"}
  ];

  // The todo to create.
  Todo todo = 2 [(google.api.field_behavior) = REQUIRED];

  // The id to use, which becomes the last segment of the resource name.
  string todo_id = 3 [(google.api.field_behavior) = REQUIRED];
}

// Request for TodoService.UpdateTodo.
message UpdateTodoRequest {
  // The todo to update, identified by its \`name\`.
  Todo todo = 1 [(google.api.field_behavior) = REQUIRED];

  // Which fields of the todo to replace.
  google.protobuf.FieldMask update_mask = 2
      [(google.api.field_behavior) = OPTIONAL];
}

// Request for TodoService.DeleteTodo.
message DeleteTodoRequest {
  // The todo to delete.
  // Format: users/{user}/todos/{todo}
  string name = 1 [
    (google.api.field_behavior) = REQUIRED,
    (google.api.resource_reference) = {type: "${packageName}/Todo"}
  ];
}

// How urgent a todo is.
//
// Declared after every message: core::0191::file-layout wants top-level enums
// to come last.
enum Priority {
  // Not specified. The default for a todo that never set one.
  PRIORITY_UNSPECIFIED = 0;

  // Can wait indefinitely.
  PRIORITY_LOW = 1;

  // Should be done soon.
  PRIORITY_MEDIUM = 2;

  // Should be done today.
  PRIORITY_HIGH = 3;

  // Blocking something else.
  PRIORITY_URGENT = 4;
}
`,
	});

	/* ---------------------------------------------------------------- *
	 * The service
	 * ---------------------------------------------------------------- */

	files.push({
		path: `${dir}/todo_service.proto`,
		contents: `syntax = "proto3";

package ${packageName};

import "google/api/annotations.proto";
import "google/api/client.proto";
import "google/protobuf/empty.proto";
import "${dir}/todo.proto";

option java_multiple_files = true;
option java_outer_classname = "TodoServiceProto";
option java_package = "${java}";

// Manages todos. The five standard methods of AIP-131 through AIP-135.
service TodoService {
  option (google.api.default_host) = "todo.example.com";

  // Returns a single todo.
  rpc GetTodo(GetTodoRequest) returns (Todo) {
    option (google.api.http) = {get: "/v1/{name=users/*/todos/*}"};
    option (google.api.method_signature) = "name";
  }

  // Lists a user's todos.
  rpc ListTodos(ListTodosRequest) returns (ListTodosResponse) {
    option (google.api.http) = {get: "/v1/{parent=users/*}/todos"};
    option (google.api.method_signature) = "parent";
  }

  // Creates a todo under a user.
  rpc CreateTodo(CreateTodoRequest) returns (Todo) {
    option (google.api.http) = {
      post: "/v1/{parent=users/*}/todos"
      body: "todo"
    };
    option (google.api.method_signature) = "parent,todo,todo_id";
  }

  // Updates part of a todo.
  rpc UpdateTodo(UpdateTodoRequest) returns (Todo) {
    option (google.api.http) = {
      patch: "/v1/{todo.name=users/*/todos/*}"
      body: "todo"
    };
    option (google.api.method_signature) = "todo,update_mask";
  }

  // Deletes a todo.
  rpc DeleteTodo(DeleteTodoRequest) returns (google.protobuf.Empty) {
    option (google.api.http) = {delete: "/v1/{name=users/*/todos/*}"};
    option (google.api.method_signature) = "name";
  }
}
`,
	});

	files.push({
		path: "README.md",
		contents: `# Todo API

A Protocol Buffers API following the
[Google AIPs](https://google.aip.dev), generated by the Protobuf AIP Linter
extension. It lints clean as it stands, so anything the editor reports from
here is something you changed.

## Layout

\`\`\`
${dir}/
  todo.proto          the Todo resource, its requests, and the Priority enum
  todo_service.proto  TodoService: the five standard methods
\`\`\`

The directory mirrors the proto package, which is what
[AIP-191](https://google.aip.dev/191) asks for and what
\`core::0191::proto-package\` checks.

## What is worth copying

- \`Todo\` declares \`google.api.resource\` with \`singular\` and \`plural\`, so it is
  a **resource** rather than a bare message ([AIP-123](https://google.aip.dev/123)).
- Every field states its \`google.api.field_behavior\`. The linter asks for this
  on every field, and \`name\` on a resource must be \`IDENTIFIER\`.
- The five methods are Get, List, Create, Update and Delete, each with the HTTP
  binding and \`method_signature\` its AIP prescribes
  ([AIP-131](https://google.aip.dev/131)–[135](https://google.aip.dev/135)).
- \`ListTodos\` pages with \`page_size\`, \`page_token\` and \`next_page_token\`
  ([AIP-158](https://google.aip.dev/158)).

## Working on it

| Task | How |
| --- | --- |
| Lint | The extension lints on open and on save. The scales icon lints on demand |
| Format | The paint-can icon, or save with \`gapi.formatOnSave\` |
| Generate | \`buf generate\`, or the play icon in Dependencies |
| Add a dependency | Open the Proto Registry from the Dependencies view |
${withCi ? "\nCI lints every push and pull request; see `.github/workflows/proto-lint.yml`.\n" : ""}`,
	});

	if (withCi) {
		files.push(ciWorkflow("."));
	}

	return files;
}
