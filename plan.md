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
Prototype validated: 98 annotations, 11 namespaces, 495 body messages, 65 ms.

**Highlighting must use semantic tokens.** TextMate grammars are static files and cannot be driven by
an index. Use `DocumentSemanticTokensProvider` + `contributes.semanticTokenTypes` /
`semanticTokenScopes`.

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
- [ ] **0.1** (A) Remove `runBufSyntaxCheck` from the per-file lint path. Run `buf build` at most once
      per workspace, debounced, fan diagnostics out by file.
- [ ] **0.2** (B) `formatAllProtos` → one `buf format -w` per module, not per file.
- [ ] **0.3** (A) Batch `lintWorkspace` into one api-linter process per module, chunked under ARG_MAX.
- [ ] **0.4** (C) `spawnSync` → async `spawn`. Removes the event-loop freeze.
- [ ] **0.5** (E) Proto view: no scan on activation, lazy per-section, file-count ceiling.
- [ ] **0.6** (H) Delete `server.ts` + `extension-lsp.ts`; drop `vscode-languageclient` /
      `vscode-languageserver` / `vscode-languageserver-textdocument` from `package.json`.

### Phase 1 — the index

- [ ] **1.1** (D) Symbol index: gitignore-aware walk, `fs.readFile`, parse, **discard text**, packed
      arrays + interned strings. Budget: ≤150 MB for 9,280 files.
- [ ] **1.2** (D) Incremental re-index on a single `FileSystemWatcher`; patch one file's slice.
- [ ] **1.3** (D) Memory ladder: pre-flight file/byte count picks starting tier; degrade
      full → reduced → on-demand → refuse, each with a user-visible reason.
- [ ] **1.4** (G) Rewrite five providers to read the index; `openTextDocument` reserved for the
      active editor only.
- [ ] **1.5** (G) Index by **fully-qualified** name (file `package` + import resolution), then
      re-enable cross-file rename.
- [ ] **1.6** (C) Module graph: discover *every* `buf.yaml` and `buf.work.yaml`; map
      `moduleRoot → {roots, deps, lintConfig}`; resolve each file to its module by longest prefix.
- [ ] **1.7** (C) Dependency resolution via `buf.lock` → module cache. Delete `runBufExport`.
- [ ] **1.8** (E) Proto view reads the index instead of scanning.

### Phase 1a — annotations

- [ ] **1a.1** (F) Annotation registry extracted from `extend google.protobuf.*Options` during the
      index walk. Prototype exists and is validated.
- [ ] **1a.2** (F) `DocumentSemanticTokensProvider` for annotation highlighting; custom token types
      contributed with scope fallbacks.
- [ ] **1a.3** (F) Hover: option name → derived card; body field → that field's comment.
- [ ] **1a.4** (F) Target-aware completion; snippets generated from the message shape.
- [ ] **1a.5** (F) Diagnostics: unknown annotation, wrong target, unknown body field, missing import,
      per-file extension-number collision.
- [ ] **1a.6** (G) Remove hardcoded MCP from `protoScanner.ts` / `completionProvider.ts` / snippets.

### Integration

- [ ] **I.1** Register new providers in `extension.ts`; wire the index lifecycle.
- [ ] **I.2** `package.json`: semantic token contributions, new settings
      (`gapi.index.maxMemoryMB`, `gapi.index.maxFiles`), drop removed deps.
- [ ] **I.3** Full verify: `typecheck`, `format:check`, `lint`, `compile`, plus a measured
      before/after on protobuf-fhir.

---

## Verification

Run from the extension directory:

```bash
bun run typecheck && bun run format:check && bun run lint && bun run compile
```

Benchmarks live in the session scratchpad but are reproducible: index build time and RSS against
`../protobuf`, `buf format` batched vs per-file, api-linter batched vs per-file.

**Known repo blockers in protobuf-fhir** (not extension bugs, but they break `buf export` and make
measurements untrustworthy): `Integer64` is referenced in 54 `attachment.proto` files but defined
nowhere; the root `buf.yaml` declares no `modules:` so the nested `google-api-linter-vscode/`
checkout is compiled into the FHIR module.

---

## Status log

- 2026-09-13 — Branch created. Contracts written. Tracks A–H dispatched in parallel.
