# Performance rewrite — working plan

Durable state for this effort. Self-contained: a fresh session (or a different machine, or a
different cloud account) should be able to read this file alone and continue.

- **Branch:** `perf/index-rewrite`
- **Started:** 2026-09-13
- **Reference repo for all measurements:** `../` (protobuf-fhir), 9,280 protos, 578,679 lines

---

## Why

Measured on protobuf-fhir. Every number reproduced locally, not estimated.

| Operation | As built | Done correctly | Factor |
|---|---|---|---|
| Format every proto | 3.4 h (9,280 × 1.33 s serial) | 1.84 s (`buf format -w .`) | ~6,700× |
| Syntax check during workspace lint | 21.9 CPU-hours (9,280 × 8.5 s) | 8.5 s CPU (one `buf build`) | ~9,280× |
| api-linter over 100 files | 2.562 s (100 processes) | 0.525 s (1 process) | 4.9× |
| Full symbol index | ~60 GB RSS (9,280 open TextDocuments) | 94.4 MB / 336 ms (`fs.readFile`) | ~640× |
| Resolve buf deps | 1.7 s blocking `spawnSync`, **fails on this repo** | ~0 ms (read `buf.lock`) | no process |

Three root causes:

1. **Memory.** `vscode.workspace.openTextDocument` called in a loop over every proto in five places.
   VS Code never releases those documents. `workspaceSymbolProvider` does it *per keystroke*.
2. **CPU.** `runBufSyntaxCheck` runs a whole-workspace `buf build` per file. `lintWorkspace` and
   `formatAllProtos` are serial one-process-per-file loops. `getBufProtoPaths` uses `spawnSync`,
   freezing the extension host.
3. **Dependencies.** `findBufConfig` uses exactly one `buf.yaml`; ignores nested/multiple modules and
   `buf.work.yaml`; depends on `buf export`, which fails whenever the module has any compile error.

Hard requirement from the user: **extension host ≤ 40 MB, index ≤ 150 MB soft / 200 MB hard, with a
degrade ladder that fails loudly rather than consuming the machine.**

---

## Key mechanisms (validated)

**Dependency resolution without `buf export`.** Read `buf.lock`, map each `name` + `commit` to
`~/.cache/buf/v3/modules/b5/<name>/<commit>/files`, use those directly as `--proto-path`. Verified:
resolves all 22 imports of a heavy FHIR file in 30 ms, no subprocess, no temp dir, and works on a
repo that does not currently compile.

**Annotations are self-describing.** Every custom annotation is an `extend google.protobuf.*Options`
block that declares its own FQN (`package` + field name), legal targets (the extendee), body shape
(the field's message type), documentation (leading `//` comment), usage example (godoc-style indented
block in that comment), field number, and source location. Never hardcode annotation names — the
extension currently hardcodes `mcp.protobuf.*`, which is two generations stale (current is
`mcp.v1.*`), so MCP completion, snippets, and the Proto view MCP section are all silently dead.
Validated against the real buf module cache: **59 annotations across 11 namespaces in 59 ms**, plus
the 3 extension-number collisions between `entity.v1` and `protokit.v1`. (An earlier prototype
reported 98; that double-counted the same annotation once per cached module *commit* — `store` has 5
cached commits, `googleapis` 4. Deduplicated by fqn the prototype finds 58, and the shipped extractor
finds 59 because it also catches `google.api.field_behavior` #1052, which the prototype's stricter
regex missed.)

**Highlighting must use semantic tokens.** TextMate grammars are static files and cannot be driven by
an index. Use `DocumentSemanticTokensProvider` + `contributes.semanticTokenTypes` /
`semanticTokenScopes`.

---

## Published write-ups

- Diagnosis + phase plan — https://claude.ai/code/artifact/047cabce-dd9b-4cb1-a417-93ea0a5652a4
- Annotation design — https://claude.ai/code/artifact/2b951219-a2ed-4d21-be3b-acba788e2c87

Both were republished 2026-09-13 after an account switch made the originals unreachable. Artifacts
are convenience copies; **this file is the durable state.**

---

## Contracts

Interfaces are defined up front so every track builds against them concurrently instead of waiting.
**Do not change a contract file without updating this plan and notifying the other tracks.**

- `src/index/types.ts` — symbol index, module graph, annotation registry contracts.

---

## Track ownership

**Hard rule: a track only edits files it owns.** Integration files (`src/extension.ts`,
`package.json`) are owned by the integrator only.

| Track | Owns | Depends on |
|---|---|---|
| A — Lint pipeline | `src/linterProvider.ts`, `src/utils/linterUtils.ts` | contracts |
| B — Format & commands | `src/commands.ts`, `src/formatProvider.ts` | contracts |
| C — Module & dep resolution | `src/utils/bufConfigReader.ts`, `src/utils/configReader.ts`, `src/utils/protoImportRoots.ts`, `src/utils/moduleGraph.ts` (new) | contracts |
| D — Index core | `src/index/**` (new, except `types.ts`) | contracts |
| E — Proto view | `src/protoView.ts`, `src/protoScanner.ts` | D's contract |
| F — Annotations | `src/annotations/**` (new) | D's contract |
| G — Providers on index | `src/workspaceSymbolProvider.ts`, `src/referenceProvider.ts`, `src/renameProvider.ts`, `src/definitionProvider.ts`, `src/completionProvider.ts` | D's contract |
| H — Dead code | `src/server.ts`, `src/extension-lsp.ts` (delete) | — |
| Integrator | `src/extension.ts`, `package.json`, `src/index/types.ts` | all |

---

## Tasks

### Phase 0 — stop the bleeding

- [x] **0.7** Neutralise destructive Rename Symbol — scoped to current file, package-aware matching.
      *Done before this branch; 155 edits across 154 files → 1 edit in 1 file.*
- [x] **0.1** (A) Remove `runBufSyntaxCheck` from the per-file lint path. Run `buf build` at most once
      per workspace, debounced, fan diagnostics out by file. *Done.*
- [x] **0.2** (B) `formatAllProtos` → one `buf format -w` per module, not per file. *Done.*
- [x] **0.3** (A) Batch `lintWorkspace` into one api-linter process per module, chunked under ARG_MAX. *Done.*
- [x] **0.4** (C) `spawnSync` → async `spawn`. *Done — both calls gone; deps resolve with no subprocess at all.*
- [x] **0.5** (E) Proto view: no scan on activation, lazy per-section, file-count ceiling. *Done.*
- [x] **0.6** (H) Delete `server.ts` + `extension-lsp.ts`. *Done — both were unreachable. The three
      `vscode-language*` dependencies they pulled in are removed at integration, in one pass with the
      lockfile, to avoid racing concurrent agents.*

### Phase 1 — the index

- [x] **1.1** (D) Symbol index. *Done — 9,257 files / 76,346 symbols / 495 ms / **25.5 MB
      retained** against 24.9 MB of source read.*
- [x] **1.2** (D) Incremental re-index. *Done — one file update is 0–1 ms, no rebuild.*
- [x] **1.3** (D) Memory ladder. *Done — all three tiers exercised; each reason names the limit,
      the observed size and what was switched off.*
- [x] **1.4** (G) Rewrite five providers to read the index. *Done — zero `openTextDocument` call
      sites across all five, stricter than the rule required.*
- [x] **1.5** (G) Index by **fully-qualified** name, then re-enable cross-file rename. *Done —
      verified against the reference repo: renaming `Address` touches 1–2 files, was 154.*
- [x] **1.6** (C) Module graph: every `buf.yaml` and `buf.work.yaml`, per-file longest-prefix
      resolution. *Done.*
- [x] **1.7** (C) Dependency resolution via `buf.lock` → module cache. *Done — `runBufExport` deleted.*
- [x] **1.8** (E) Proto view reads the index instead of scanning. *Done.*

### Phase 1a — annotations

- [x] **1a.1** (F) Annotation registry extracted from `extend google.protobuf.*Options`. *Done —
      59 annotations / 11 namespaces / 59 ms against the real module cache.*
- [x] **1a.2** (F) `DocumentSemanticTokensProvider` for annotation highlighting. *Done.*
- [x] **1a.3** (F) Hover: option name, body field, and `extend` declaration. *Done.*
- [x] **1a.4** (F) Target-aware completion; snippets generated from the message shape. *Done.*
- [x] **1a.5** (F) Diagnostics: unknown annotation, wrong target, unknown body field, missing
      import, per-file extension-number collision. *Done.*
- [x] **1a.6** (G) Hardcoded MCP removed everywhere. *All nine stale snippets deleted, including
      the `mcp/protobuf/annotations.proto` import snippet.*

### Phase 1b — value completion and version grouping

Both items came from using the extension on this repo, not from the original plan.

- [x] **1b.1** Enum value completion at value position. *`contextAt` answers a structural question
      — statement / bracket list / option body — which is all a name completion needs, so
      `(google.api.field_behavior) = ▮` offered annotation **names**: a list of every option legal
      on the element, none of which is a legal thing to type there. Added `valuePositionAt`, which
      reads the offsets the model already parsed (so a value split across lines resolves the same
      as an inline one) and reports the option or body field being assigned. Enum and `bool` types
      get items; open sets — string, int — deliberately get none.*
- [x] **1b.2** Enum values in the type hint. *`renderFieldCard` listed them already; the annotation
      card and the body-field completion detail did not. An option with no body message — which is
      `google.api.field_behavior`, used 59,617 times in this repo — fell through the card renderer
      entirely and showed no values at all. Also fixed a latent resolution bug: field types resolved
      against the annotation's namespace rather than the declaring body's, which missed every enum
      whose option body lives in another package.*
- [x] **1b.3** Symbol sections group by package version. *Above the file ceiling the root pushed one
      "exceeds the view limit" notice **and no sections at all**, so on this workspace the Proto view
      listed zero symbols — they were indexed and reachable from every other provider, just not
      listed here. The refusal existed because a flat list of 9,502 siblings is what stalls the tree,
      so the fix is to remove the width rather than the section: group by the `vN` segment of the
      package, then by package stem. Derived from the indexed `package` statement, so a workspace
      with no versioned packages simply never groups, and a single-version workspace skips the
      version level rather than rendering one node wrapping everything.*

- [x] **1b.4** Annotation highlighting actually renders. *The semantic tokens provider was correct
      and registered, and the `package.json` contributions were present — but `configurationDefaults`
      never set `editor.semanticHighlighting.enabled`, whose default is `configuredByTheme`. On a
      theme that does not opt in, every token was computed and thrown away. Now defaulted to `true`
      scoped to `[proto3]`/`[protobuf]` only, so nothing else in the editor changes and a user can
      still override it.*
- [x] **1b.5** Enum values highlighted. *`= OPTIONAL` carried no token: the grammar paints the whole
      bracket uniformly as `support.other.proto`, so the value read the same as the option name. Two
      new types — `protoAnnotationValue` (superType `enumMember`) and `protoAnnotationValueUnknown`
      (`invalid.illegal`) — reusing the enum resolution added in 1b.1/1b.2. A value the enum does not
      declare is marked wrong in the editor instead of at `buf build`. The `package.json` block is
      now **generated** from `SEMANTIC_TOKEN_*_CONTRIBUTION` in `support.ts` rather than pasted, since
      "paste verbatim" is exactly what drifts.*

### Integration

- [x] **I.1** Register new providers in `extension.ts`; wire the index lifecycle. *Done.*
- [x] **I.2** `package.json`: semantic token contributions, budget settings, three dead
      `vscode-language*` deps dropped. *Done.*
- [x] **I.3** Full verify. *`typecheck`, `format:check`, `lint` (0 errors), `compile` all pass;
      the 790 KB bundle parses. Measured results below.*

---

## Integration notes

Collected from each track as it lands. The integrator owns `src/extension.ts` and `package.json`.

### From Track A (lint pipeline) — landed

1. **Dispose the provider.** `ApiLinterProvider` now owns a second `DiagnosticCollection`
   (`google-api-linter-syntax`), a debounce timer, and possibly an in-flight `buf` child process.
   Push it into `context.subscriptions` or it leaks on deactivate.
2. **Trigger the syntax check.** Per-file lint no longer runs `buf` at all, so syntax errors will not
   appear until `linterProvider.scheduleWorkspaceSyntaxCheck()` is called. Wire it into the existing
   `onDidSaveTextDocument` handler for `.proto` files and once after activation. It is debounced and
   self-coalescing, so calling it on every save is safe.
3. No constructor change; `getBinaryManager` / `lintDocument` / `lintUri` / `lintWorkspace` keep their
   signatures, so `commands.ts` needs nothing.

**Why a second collection:** a shared one would have the workspace `buf build` pass and the per-file
api-linter pass overwrite each other. Diagnostic `source` strings are unchanged
(`google-api-linter`, `google-api-linter (syntax)`), so `statusBar.ts`, `protoView.ts` and
`hoverProvider.ts` keep filtering correctly.

---

### From Track G (providers) — landed

- All five constructors take `ProtoIndex` as an **optional trailing** parameter, so `extension.ts`
  compiles untouched and can be wired incrementally. Pass the **same** instance to each; every
  provider checks `stats().tier === "onDemand"` and degrades itself.
- Wire at `extension.ts`: `ProtoDefinitionProvider`, `ProtoReferenceProvider`, `ProtoRenameProvider`,
  `ProtoWorkspaceSymbolProvider`, `ProtoCompletionProvider`.
- Track D's incremental re-index matters for rename safety: a stale index degrades safely but
  silently, so re-index on save.
- With MCP entries deleted from `completionProvider`, **nothing offers custom option completions
  until Track F's provider is registered.**
- User-visible: Go to Symbol caps at 500, import completion at 200; definition now lands on the
  symbol name rather than column 0.

### From Track E (Proto view) — landed

- `registerProtoView(..., resolveTypeToLocation, index?, fileCeiling?)` — both new args optional and
  trailing. Wire `gapi.protoView.maxFiles` to the 8th; nothing in the file reads configuration itself.
- The provider is now disposable and self-registers into `context.subscriptions` — do not dispose it
  separately.
- The `mcp` section and `mcpSubsection` node kind are gone, replaced by a derived `annotations`
  section. Any `package.json` menu/when-clause referencing those ids must be updated. Command ids are
  unchanged.

---

### From Track F (annotations) — landed

Entry point, already pushed onto `context.subscriptions` for you and also returned:

```ts
import { registerAnnotationSupport } from "./annotations/support";
const annotations = registerAnnotationSupport(context, index); // index may be undefined
```

`AnnotationSupport extends vscode.Disposable`, exposes `.semanticTokens`, `.diagnostics`,
`.refresh()`, and subscribes to `index.onDidChange` itself — nothing needs to poke it after a build.
An undefined index makes everything a no-op.

**`package.json` must gain `contributes.semanticTokenTypes` and `contributes.semanticTokenScopes`.**
The exact JSON is mirrored as `SEMANTIC_TOKEN_TYPE_CONTRIBUTION` / `SEMANTIC_TOKEN_SCOPE_CONTRIBUTION`
in `src/annotations/support.ts` so the two cannot drift — copy from there rather than retyping. Five
token types (`protoAnnotation`, `protoAnnotationNamespace`, `protoAnnotationField`, and the two
`…Unknown` variants). Each carries a `superType` so it inherits colour from a standard type, and the
scope lists are TextMate fallbacks, so no user configuration is needed. The `Unknown` types map to
`invalid.illegal`, which every shipped theme renders as an error.

**Still to do at integration:** delete the eight stale `mcp.protobuf.*` snippets from
`snippets/proto3.json` (task 1a.6) — derived completion now supersedes them.

---

## Results

Measured on protobuf-fhir (9,257 indexed protos) after the rewrite.

| | Before | After |
|---|---|---|
| Workspace symbol index | ~60 GB RSS, retained for the session | **25.5 MB** retained, 495 ms |
| Go to Symbol | reopened all 9,280 docs **per keystroke** | index lookup, capped at 500 results |
| Format every proto | 3.4 h (9,280 serial processes) | one `buf format -w` per module |
| Workspace lint | 21.9 CPU-hours of whole-workspace `buf build` | one batched pass + one debounced `buf build` |
| Resolve buf deps | 1.7 s blocking `spawnSync`, failed on this repo | reads `buf.lock`, no subprocess |
| Rename `Address` | **154 files rewritten silently** | 1 file |
| Custom annotations | 9 hardcoded `mcp.protobuf.*` entries, all dead | 59 derived, 11 namespaces, 53 ms |
| Proto view symbol sections | **0 listed** above the ceiling — sections replaced by a notice | 11,866 reachable; widest level 246 |
| `(google.api.field_behavior) = ▮` | annotation names — nothing legal at that position | 9 enum values, in declaration order |
| Enum values on a hover card | body fields only, resolved against the wrong namespace | every enum-typed option and field |
| Annotation highlighting | computed, then discarded unless the theme opted in | on by default for proto buffers |
| Annotation tokens, whole tree | name and body key only | 236,694 tokens incl. 57,243 enum values, 0.04 ms/file |

`openTextDocument` call sites in bulk paths: **zero**. The one remaining call opens the single file
behind a clicked Proto view node.

**Correctness, not just speed.** 92 symbols in this corpus share the bare name `SubjectChoice`;
`referencesTo()` on one fully-qualified name returns 1 reference in 1 file. Simple-name matching
returned all 92, which is what made Rename destructive.

---

## Verification

Run from the extension directory:

```bash
bun run typecheck && bun run format:check && bun run lint && bun run compile
```

Benchmarks live in the session scratchpad but are reproducible: index build time and RSS against
`../protobuf`, `buf format` batched vs per-file, api-linter batched vs per-file.

**Known repo blockers in protobuf-fhir** (not extension bugs, but they break `buf export` and make
measurements untrustworthy). `Integer64` referenced in 54 `attachment.proto` files but defined
nowhere — **fixed**: FHIR R5's `integer64` was missing from `primitiveMap` in
`tools/protogen/types.go`, so the generator fell through to its complex-type fallback and emitted a
type name nothing declares; it now maps to `int64`. Still open: the root `buf.yaml` declares no
`modules:`, so the nested `google-api-linter-vscode/` checkout is compiled into the FHIR module and
contributes 10 errors to every `buf build`. Scope buf invocations with `--path protobuf` until that
is settled.

---

## Status log

- 2026-09-13 — Branch created. Contracts written (`src/index/types.ts`).
- 2026-09-13 — Track H done: dead LSP scaffold deleted. Budget settings added to `package.json`
  (`gapi.index.maxMemoryMB`, `gapi.index.maxFiles`, `gapi.index.enabled`, `gapi.protoView.maxFiles`).
- 2026-09-13 — Tracks A–G dispatched concurrently against the contract.
- 2026-09-13 — Session quota exhausted mid-run; 5 of 7 agents died. Surviving partial work from
  Tracks A and E committed as WIP rather than discarded. Re-dispatched in a wave of 4, then 1,
  with tighter scopes so each lands sooner and can be committed.
- 2026-09-13 — Track A landed: per-file `buf build` removed, workspace lint batched.
- 2026-09-13 — Tracks G and E landed: five providers off `openTextDocument` entirely, cross-file
  rename restored safely on fully-qualified names, Proto view lazy and index-backed.
- 2026-09-13 — Second quota exhaustion; Tracks C and F died again but had written most of their work.
  Committed after a format pass. Tracks B, C and F(core) landed. Corrected the annotation count from
  the prototype's inflated 98 to the true 59.
- 2026-09-13 — Remaining: Track D (index core, still nothing written after two quota deaths) and
  Track F's VS Code providers. Both re-dispatched. Then integration (I.1–I.3).
- 2026-09-13 — Track F fully landed: semantic tokens, hover, completion, diagnostics. Only Track D
  (index core) and integration remain.
- 2026-09-13 — Track D landed (index core) and integration complete. All of Phase 0, Phase 1 and
  Phase 1a are done. Remaining optional work: Phase 2 (Rust sidecar) and Phase 3, neither started.
- 2026-09-13 — Phase 1b landed: enum value completion, enum hints on hover cards, and version
  grouping in the Proto view. Verified outside the extension host against the real workspace —
  9/9 completion fixtures (including two negative cases: a name position still offers names, an
  open-valued field offers nothing), 8/8 version/stem cases, and a root-to-leaf walk reaching
  11,866 symbols with no group wider than 246. Harnesses in the session scratchpad
  (`valuecomp.js`, `grouping.js`, `tree.js`, `hints.js`); they stub `vscode` and drive the real
  compiled providers.
- 2026-09-13 — Highlighting finished: semantic highlighting defaulted on for proto buffers, and
  enum values tokenised. Swept all 9,280 protos — 236,694 tokens, 355 ms total, worst file 2 ms,
  and zero `protoAnnotationValueUnknown`, which also says the generated tree has no enum typos.
  Typo fixtures (`REQUIRE`, lowercase `optional`, `IGNORE_NEVER`) all flag; int- and string-valued
  fields correctly get no token. Harness: `tokens.js`, `sweep.js`.
