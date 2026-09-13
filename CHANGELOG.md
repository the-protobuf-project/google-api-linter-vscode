# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0]

First release under the name **Protobuf AIP Linter**. The extension was
previously developed as `google-api-linter`; the identifier changed with it, so
this is a new marketplace entry rather than an upgrade.

The release is dominated by one measurement. On a 9,280-file proto workspace the
extension grew VS Code to roughly 60 GB of resident memory and never finished a
workspace lint. Every number below was reproduced on that workspace.

### Changed — performance

- **Workspace symbol index.** Symbols now come from an in-memory index built
  with `fs.readFile`, not from `vscode.workspace.openTextDocument`. Five code
  paths opened one document per proto in a loop, and VS Code never releases
  those; the workspace symbol provider did it on every keystroke. The index is
  25.5 MB and builds in 495 ms for 9,257 files.
- **Linting** runs one `api-linter` process per module, chunked under `ARG_MAX`,
  instead of one process per file — 2.562 s to 0.525 s over 100 files.
- **Syntax checking** runs `buf build` at most once per workspace, debounced,
  with diagnostics fanned out by file. It previously ran a whole-workspace
  `buf build` for every file opened: 8.5 s of CPU each time.
- **Formatting** runs one `buf format -w` per module rather than one process per
  file, which on this workspace was 1.84 s against 3.4 hours.
- **Dependency resolution** reads `buf.lock` and maps each entry to the buf
  module cache. It no longer shells out to `buf export`, which failed whenever
  the module had any compile error — precisely when a linter is wanted. The
  blocking `spawnSync` that froze the extension host is gone.
- **Module discovery** honours every `buf.yaml` and `buf.work.yaml` in the
  workspace, resolving each file to its own module by longest prefix. It
  previously used a single `buf.yaml` and ignored nested modules.

### Added

- **Annotation support derived from the schema.** Hover, completion, semantic
  highlighting and diagnostics for custom options are read from the
  `extend google.protobuf.*Options` blocks themselves — the option's legal
  targets from the extendee, its body shape from the message it names, its
  documentation and usage example from its leading comment. Nothing about any
  particular annotation is hardcoded. 59 annotations across 11 namespaces are
  discovered in the reference workspace.
- **Semantic highlighting for annotations**, and it is on by default for proto
  files. Option namespace, option name, body field and enum value each get their
  own token, and a value the enum does not declare is marked as an error in the
  editor rather than at build time.
- **Enum value completion.** Assigning an enum-typed option or body field offers
  that enum's members, in declaration order, with the proto3 zero value last.
  Types with open value sets deliberately offer nothing.
- **Version grouping in the Proto view.** Symbol sections group by the `vN`
  segment of the package and then by package. Above the file ceiling these
  sections previously showed a notice and nothing else, so a large workspace
  listed no symbols at all.

### Fixed

- **Rename Symbol was destructive.** It matched on the bare type name, so
  renaming `Address` rewrote 154 files across unrelated packages. The index is
  keyed on fully-qualified names, and a rename now touches one file.
- **Windows syntax errors never appeared.** The `file:line:col` pattern could not
  match an absolute path with a drive letter, and did not tolerate CRLF output.
  Three copies of the pattern shared both gaps.
- A reported line of 0 threw inside an event handler and left the syntax check's
  promise unsettled, so the check never returned.
- A single malformed entry in an `api-linter` findings array discarded every
  other finding in the same run.
- Fully-qualified type references written with a leading dot
  (`.google.protobuf.Duration`) matched nothing and were dropped silently, in
  four separate parsers.
- Tab-indented usage examples in annotation comments were truncated, and their
  code leaked into the rendered prose.

### Removed

- The dead language-server scaffold and its three unused `vscode-language*`
  dependencies.
- Hardcoded `mcp.protobuf.*` completions and snippets, two naming generations
  stale and silently inert. Annotation support is derived instead.
