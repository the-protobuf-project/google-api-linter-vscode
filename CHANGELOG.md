# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0]

### Added

- **Proto Registry** — a searchable browser for Buf Schema Registry modules, in
  an editor tab rather than the sidebar, with the `buf.yaml` edit shown before
  it is made. `buf dep` has no `add` subcommand, so adding a dependency edits
  the file and then runs `buf dep update`.
- **Registries view** with support for self-hosted registries via
  `gapi.registries`, and sign-in through `buf registry login <host>`.
- **Dependencies view** reading `buf.yaml`, `buf.lock` and `buf.gen.yaml`,
  replacing a section that reported a hardcoded count of two. Each codegen
  plugin can be run on its own.
- **Details panel**, in the sidebar and as an editor tab, showing a symbol's
  fields, annotations and the rules that fired on it — including option keys
  that are *absent*, which is what the rule is usually complaining about.
- **Problems view** grouped by rule, answering "which rule is firing 34 times"
  rather than "what is wrong with this file".
- **Generate API Report** — whole-workspace Markdown with per-service Mermaid
  diagrams, shared-type analysis and findings by rule.
- **Capture All Errors** — findings as a shareable Markdown report with the
  offending source lines quoted.
- **Symbol search** over the workspace index.
- **Check Setup** — inspects the toolchain and reports what is installed, what
  is missing, and how to install it on *this* machine. Hints are
  platform-specific: Homebrew on macOS, apt/dnf/pacman on Linux, winget or
  Scoop on Windows, with Go as the cross-platform fallback. A manager that is
  not installed is shown and marked rather than hidden, because on a fresh
  machine the real answer is often "install that first".
- **Install Missing Tools** — installs what is missing without touching what is
  not. Downloads into `~/.gapi` happen directly; anything owned by a package
  manager runs in a visible terminal, because several of those commands need
  `sudo` and an extension that quietly asks for a password should not be
  trusted. **Reinstall All Tools (force)** does the same but replaces what is
  already there, for a download that arrived corrupt.
- **A toolchain status-bar item**, the way a Go file reports its Go version.
  It shows the api-linter version, turns amber when something required is
  missing, and its tooltip lists every dependency with its version. Clicking it
  opens the setup check.
- `gapi.checkSetupOnStartup` (default true): offers to set things up on a
  machine that is missing something required, and stays silent otherwise.
- **Create Starter Project** — a working AIP Todo API: the resource with its
  `google.api.resource` declaration, the five standard methods with their HTTP
  bindings, and buf configuration. It lints clean as written, so the first
  finding you see is one you caused.
- **Set Up GitHub Actions CI** — a workflow using
  [setup-google-api-linter](https://github.com/the-protobuf-project/setup-google-api-linter),
  which annotates each problem inline on the diff. It finds the directory
  holding your `buf.yaml` and points the action at it.
- `gapi.lintOnStartup` (default true): lint the workspace when it opens.
- A centred empty state in Problems when nothing is wrong, with a Lint
  Workspace button, rather than a row pretending to be one.

### Fixed

- An HTTP path template no longer swallows the rest of a file. A wildcard
  segment inside a quoted string read as a block-comment opener, so everything
  after the first `google.api.http` annotation vanished from the index — a
  service with five RPCs reported one.
- Annotations are scanned from `~/.gapi` as well as the buf cache. Workspaces
  not using buf found no `extend` blocks at all, so the Annotations section
  never appeared.
- Section counts are known before a section is expanded, rather than learned by
  expanding it.
- Toolbar buttons appear: a `view/title` command renders as a button only when
  it carries an icon, and Lint and Format had none.
- Resources and messages no longer share an icon and colour.
- Every toolbar icon says what its action does. Linting and code generation no
  longer share the play icon: play means only "run codegen", which writes files.
  Linting takes scales, since an AIP linter measures against a published rule
  set, and formatting takes the paint can VS Code uses for the same action.
- `buf.gen.yaml` is found anywhere in the workspace, not only beside a
  `buf.yaml`.
- Line endings are normalised, so Windows agrees with the other platforms.

### Security

- Hovers, completion docs and tooltips no longer render as trusted Markdown.
  They are built from doc comments in workspace protos and from guidance
  fetched over the network, so a `command:` link written into either became a
  live command one click away. No link the extension emits needed trust.

### Changed

- The container is **The Protobuf Project**, and the single tree is now four
  views: Structure, Problems, Dependencies and Registries.
- Structure no longer lists files or the linter version. The Explorer already
  lists files, and the version is in the status bar.

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
