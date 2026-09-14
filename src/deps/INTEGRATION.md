# `src/deps` — integration notes

Written by the dependency-model track. Nothing outside `src/deps/**` and
`src/test/unit/deps/**` was touched; everything below is a request or a fact the
extension host needs, not a change that was made.

## Public surface

```ts
import {
	buildDependencyModel, // filesystem only — safe on a buf.lock watcher
	checkUpdates,         // network — user-invoked only
	invalidateDepCaches,
} from "./deps";
```

- `buildDependencyModel(options?): Promise<DependencyModel>`
  `options`: `{ graph?, cacheRoot?, isCancelled?, log? }`. Never rejects; a
  failure comes back as `DependencyModel.error` on an otherwise empty model.
  `updatesChecked` is always `false` here.
- `checkUpdates(model, options?): Promise<DependencyModel>`
  `options`: `{ bufPath?, run?, timeoutMs?, concurrency?, isCancelled?, log? }`.
  Returns a *new* model; the input is never mutated, so a panel may still be
  rendering it.

## Requests on files this track does not own

### 1. `BufDep.digest` is always `undefined` until `BufDependency` carries one

`protocol.ts` has `BufDep.digest?: string` ("`b5:…` digest from `buf.lock`"), but
`BufDependency` in `src/index/types.ts` has only `{name, commit, cachePath?}`,
and `readBufLock` in `src/utils/moduleGraph.ts` reads `entry.digest` nowhere.

This track deliberately did **not** re-parse `buf.lock` to recover it — a second
lock parser is exactly the duplication the module graph exists to prevent. To
light the field up, the integrator should:

1. add `readonly digest?: string` to `BufDependency` (`src/index/types.ts`);
2. carry `entry.digest` through `readBufLock` and `resolveDependency`
   (`src/utils/moduleGraph.ts`);
3. add `digest: dep.digest` to `toBufDep` in `src/deps/depModel.ts`.

Until then the Registry panel must treat a missing digest as "not recorded"
rather than as "unlocked".

### 2. `buf dep add` does not exist

Verified against the CLI: `buf dep` has only `graph`, `prune` and `update`. The
`AddDepRequest` (`dep/add`) handler therefore cannot shell out — it has to
append the reference to the `deps:` list in the named `buf.yaml` as text and
then run `buf dep update` in that directory. No helper for that lives in
`src/deps`, because it edits workspace files and belongs with the other
workspace-mutating commands.

### 3. Invalidate the module graph before rebuilding after a write

`getModuleGraph()` serves its cached graph outright for 15 s
(`FAST_TTL_MS`). A rebuild triggered straight after `buf dep update` finishes
will otherwise show the pre-update dependency set. Call
`invalidateModuleGraphCache()` first, then `buildDependencyModel()`.

`invalidateDepCaches()` only clears memoised `.proto` counts, which are keyed by
a commit-scoped cache path and are immutable in practice; it is not needed on a
normal refresh.

## Facts the host wiring depends on

- **`checkUpdates` is the only network call in this track.** It must be reachable
  only from the `dep/checkUpdates` message. Calling it on activation, on a file
  watcher, or inside `buildDependencyModel` would make the Dependencies view
  unusable offline, behind a proxy and in CI.
- **`gapi.bufPath` is read by the host, not here.** Pass it as
  `checkUpdates(model, { bufPath })`. This track never calls
  `workspace.getConfiguration`.
- **`ModuleDeps.root` is the directory holding the `buf.yaml`**, as the protocol
  comment says — not `ProtoModule.root`. A v2 manifest declaring several module
  roots carries one `deps:` list, so those roots collapse into a single row whose
  `name` is the first named module's. Rows fall back to the module root only when
  no `buf.yaml` is found within 8 levels above it.
- **`UpdateStatus.behind === undefined` means "behind by an unknown amount"**, not
  zero: the pinned commit was not on the page the registry returned. Render it as
  such.
- **A failed lookup still produces an `UpdateStatus`**, with `latestCommit` and
  `latestTime` empty and the failure in `error`, because those two fields are
  required by the type. A deleted module additionally flips `BufDep.state` to
  `"orphaned"` wherever it appears, declared or merely cached.
