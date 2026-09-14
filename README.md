# Protobuf AIP Linter

Design Protocol Buffer APIs that follow the [Google AIPs](https://google.aip.dev),
without leaving the editor.

The extension runs [`api-linter`](https://github.com/googleapis/api-linter)
against your protos and then does the part a linter cannot: it explains what a
finding means, shows which symbol it belongs to, and — where the linter states
the fix — offers to write it.

---

## Start here

Install the extension and open a folder with `.proto` files in it.

On a machine that is missing something, a prompt offers to set it up:
**api-linter**, the **googleapis** protos and the **protobuf well-known types**
are downloaded into `~/.gapi`; anything a package manager owns (`buf`,
`clang-format`) is offered as a command you run in a visible terminal, with
Homebrew, apt, dnf, pacman, winget or Scoop chosen for your platform.

Nothing to try it on? **Protobuf AIP Linter: Create Starter Project** writes a
working Todo API — a resource, the five standard methods, and buf configuration.
It lints clean as written, so the first finding you see is one you caused.

---

## What it does

### Fixes the findings it reports

`api-linter` states the fix in most of its messages. When it says

> Proto files should set `option java_outer_classname = "LibraryProto"`

the editor can write that, rather than leaving you to translate prose into a
schema edit. Nineteen of the twenty-six rules a real service triggers are
fixable this way. Press <kbd>⌘.</kbd> on a finding, or take
**Fix All AIP Findings in This File** to apply every unambiguous one at once.

Seven rules are deliberately left alone. `field-behavior-required` names four
acceptable values and no way to choose between them; `request-name-reference`
needs a resource type the message never states. A lightbulb that does not appear
costs nothing; a fix that writes the wrong value into your schema costs a review
cycle.

### Shows you why a symbol is failing

Select a service or message and **Details** shows its fields with their
`field_behavior`, its annotations, and the rules that fired on it — including
option keys that are *absent*, since that is usually what the rule is
complaining about. It opens in the sidebar, or as an editor tab beside your
code.

### Groups problems by rule, not by file

The Problems view answers "which rule is firing thirty-four times, and should I
be suppressing it" — a question no per-file list can. **Capture All Errors**
turns the lot into a Markdown report with the offending lines quoted, for a bug
report or a review.

### Manages your dependencies

**Dependencies** reads `buf.yaml`, `buf.lock` and `buf.gen.yaml`: what you
declare, how far behind the registry each module is, and every codegen plugin —
each runnable on its own rather than regenerating everything.

**Proto Registry** is a searchable browser for Buf Schema Registry modules,
opened as an editor tab. Self-hosted registries work through `gapi.registries`.
Adding a dependency shows the exact `buf.yaml` edit before making it, because
`buf dep` has no `add` subcommand and that file is one you commit.

### Documents the whole API

**Generate API Report** walks the workspace and writes Markdown: every service
with its RPC table and a Mermaid diagram, the message types more than one
service depends on, the package import graph, and findings by rule. It opens
with the preview beside it, and it is a file — so it can go in a pull request,
which is where API review actually happens.

---

## Editing

- **Syntax highlighting** for Protocol Buffers, with semantic highlighting for
  custom options: namespace, option name, body field and enum value each get
  their own colour, and a value the enum does not declare is marked in the
  editor rather than at build time.
- **Annotation completion derived from your schema.** Every custom option is
  discovered from its own `extend google.protobuf.*Options` block — legal
  targets from the extendee, body shape from the message it names, documentation
  from its leading comment. Completion is target-aware, so a method option is
  never offered on a message, and accepting one inserts the missing `import`.
  Nothing is hardcoded, so options in your own modules work without an extension
  update.
- **Go to Definition, Find References, Rename** across the workspace, backed by
  an index that never opens a document to read one.
- **Format** with `buf format`, `clang-format`, or a built-in indent.
- **Import path completion**, **folding**, **signature help**, **hover
  documentation** on rules and symbols.

---

## The sidebar

| View | Answers |
| --- | --- |
| **Structure** | What is in this API — services, RPCs, resources, messages, enums, each row carrying its own finding count |
| **Problems** | Which rules are firing, and how often |
| **Dependencies** | What this workspace declares, generates, and imports against |
| **Registries** | Which schema registries you browse |

---

## Settings

| Setting | Type | Default | |
| --- | --- | --- | --- |
| `gapi.lintOnStartup` | boolean | `true` | Lint the workspace when it opens |
| `gapi.enableOnSave` | boolean | `true` | Lint on save |
| `gapi.enableOnType` | boolean | `false` | Lint while typing |
| `gapi.checkSetupOnStartup` | boolean | `true` | Offer to install missing tools |
| `gapi.binaryPath` | string | `"api-linter"` | Path to the linter |
| `gapi.configPath` | string | `""` | Path to `.api-linter.yaml` |
| `gapi.protoPath` | array | `[]` | Extra import search directories |
| `gapi.disableRules` | array | `[]` | Rules to disable, e.g. `["core::0192::has-comments"]` |
| `gapi.enableRules` | array | `[]` | Rules to enable explicitly |
| `gapi.ignoreCommentDisables` | boolean | `false` | Ignore in-proto disable comments |
| `gapi.descriptorSetIn` | array | `[]` | FileDescriptorSet files for import resolution |
| `gapi.setExitStatus` | boolean | `false` | Non-zero exit when findings exist |
| `gapi.rulesDocumentationEndpoint` | string | `"https://linter.aip.dev"` | Base URL for rule docs |
| `gapi.formatOnSave` | boolean | `true` | Format the buffer on save |
| `gapi.formatter` | string | `"buf"` | `buf`, `clang-format`, or `simple` |
| `gapi.bufPath` | string | `"buf"` | Path to `buf` |
| `gapi.clangFormatPath` | string | `"clang-format"` | Path to `clang-format` |
| `gapi.registries` | array | `[]` | Extra BSR hosts, e.g. `["buf.example.com"]` |
| `gapi.index.enabled` | boolean | `true` | Build a workspace symbol index |
| `gapi.index.maxMemoryMB` | number | `150` | Soft ceiling for the index |
| `gapi.index.maxFiles` | number | `20000` | File ceiling for the index |
| `gapi.protoView.maxFiles` | number | `5000` | File ceiling for the Structure view |
| `gapi.debugLintLogging` | boolean | `false` | Log full linter settings on every run |

---

## Configuring the linter

Rules are configured by `.api-linter.yaml`, which is a list of blocks:

```yaml
---
- included_paths:
    - "**/*.proto"
  disabled_rules:
    - core::0192::has-comments
```

Or in a single file, for a single rule:

```proto
// (-- api-linter: core::0140::reserved-words=disabled --)
string interface = 1;
```

### Excluding folders

`included_paths` and `excluded_paths` are matched against each file's path
relative to the `.api-linter.yaml` that declares them, so a block can govern one
folder only. `all` stands for every rule, which is how a tree gets silenced:

```yaml
---
- included_paths:
    - "**/*.proto"
  disabled_rules:
    - core::0192::has-comments
# Vendored protos are still linted, but no rule applies to them.
- included_paths:
    - "vendor/**/*.proto"
  disabled_rules:
    - all
```

To skip files outright — never parsed, never reported, no process spawned — list
them under `exclude` in `workspace.protobuf.yaml`. A bare directory name covers
everything beneath it:

```yaml
exclude:
  - vendor
  - third_party
  - "**/*.pb.proto"
```

`workspace.protobuf.yaml` marks a directory as a proto workspace and can list
extra `proto_path` entries. Both files are validated as you edit them.

---

## Continuous integration

**Set Up GitHub Actions CI** writes a workflow using
[setup-google-api-linter](https://github.com/the-protobuf-project/setup-google-api-linter),
which annotates each finding inline on the pull request diff:

```yaml
- uses: the-protobuf-project/setup-google-api-linter@v1
  with:
    buf: true            # resolves google/api/* from buf.yaml
    paths: "**/*.proto"
```

`buf: true` is what makes the imports resolve — without it every annotated
proto fails to compile rather than to lint.

---

## On large workspaces

The index is built from `node` filesystem reads and never opens a
`TextDocument`, because opening one per proto is what previously grew the
extension host to tens of gigabytes on a 9,000-file repository. Above the
configured ceilings it degrades deliberately rather than growing: doc comments
and field-level symbols are dropped first, then workspace-wide features switch
off and per-file ones keep working. It says which limit it hit and why.

---

## Requirements

| | |
| --- | --- |
| VS Code | 1.137.0 or later |
| `api-linter` | Downloaded automatically |
| googleapis, protobuf | Downloaded automatically into `~/.gapi` |
| `buf` | Recommended — formatting, registry, codegen |
| `clang-format` | Only if you select it as the formatter |

**Check Setup** reports the state of all five, with the install command for your
platform, and the status bar shows which `api-linter` you are actually running.

---

## Development

```bash
bun install
bun run compile      # extension + webview bundles + Tailwind
bun test             # unit tests
bun run lint         # biome
bun run package      # .vsix
```

Contributions welcome — see the repository for issues and discussion.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).

## Resources

- [Google AIPs](https://google.aip.dev) — the design guidance this enforces
- [api-linter rules](https://linter.aip.dev) — every rule, with examples
- [buf](https://buf.build/docs) — module, registry and codegen documentation
