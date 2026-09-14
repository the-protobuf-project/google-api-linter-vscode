/**
 * The contract between the extension host and the webview panels.
 *
 * Types only — no runtime code and no imports. This file is compiled twice,
 * once by `tsconfig.json` for the host (CommonJS, Node libs) and once by
 * `tsconfig.webview.json` for the panels (ESM, DOM libs). Anything executable
 * here would have to satisfy both, so nothing executable belongs here.
 *
 * A webview cannot touch the `vscode` API, share memory with the host, or hold
 * a `vscode.Uri`. Everything crossing the boundary is structured-clonable, so
 * locations travel as a plain path plus a zero-based line, and the host turns
 * them back into a `Uri` when it acts on them.
 */

/* ------------------------------------------------------------------ *
 * Dependencies
 * ------------------------------------------------------------------ */

/** Where a dependency stands relative to what the workspace declares. */
export type DepState =
	/** In a `buf.yaml` `deps:` list and unpacked in the module cache. */
	| "declared"
	/** Declared, but no matching directory in the module cache. */
	| "missing"
	/** In the module cache but no `buf.yaml` asks for it. */
	| "cached"
	/** Cached, and the registry reports it no longer exists. */
	| "orphaned";

/** How far behind the registry a pinned commit is. Absent until checked. */
export interface UpdateStatus {
	/** Newest commit on the module's default label. */
	readonly latestCommit: string;
	/** ISO-8601 creation time of {@link latestCommit}. */
	readonly latestTime: string;
	/**
	 * Commits between the pinned one and the newest, or `undefined` when the
	 * pinned commit is not on the label's first page — "behind by an unknown
	 * amount" is a different statement from "behind by zero".
	 */
	readonly behind?: number;
	/** Set when the registry rejected the lookup, e.g. a deleted module. */
	readonly error?: string;
}

/** One buf module the workspace depends on, or merely has cached. */
export interface BufDep {
	/** Full reference, e.g. `buf.build/googleapis/googleapis`. */
	readonly name: string;
	/** Registry host, e.g. `buf.build`. */
	readonly remote: string;
	readonly owner: string;
	/** Module name without owner or remote, e.g. `googleapis`. */
	readonly module: string;
	/** Commit from `buf.lock`, or the cached directory when unlocked. */
	readonly commit: string;
	/** `b5:…` digest from `buf.lock`, when the lock recorded one. */
	readonly digest?: string;
	/** Unpacked `…/<commit>/files` directory, when present locally. */
	readonly cachePath?: string;
	/** `.proto` files under {@link cachePath}. Absent when not cached. */
	readonly protoCount?: number;
	/** Absolute path of the `buf.yaml` whose `deps:` names it. */
	readonly declaredIn?: string;
	readonly state: DepState;
	readonly update?: UpdateStatus;
}

/** How a `buf.gen.yaml` plugin entry names its plugin. */
export type GenPluginKind =
	/** `remote:` — runs on the BSR. */
	| "remote"
	/** `local:` — a binary on PATH. */
	| "local"
	/** `protoc_builtin:` — a language built into protoc. */
	| "protoc_builtin";

/** One entry of a `buf.gen.yaml` `plugins:` list. */
export interface GenPlugin {
	/** The plugin as written, e.g. `buf.build/protocolbuffers/plugins/go`. */
	readonly ref: string;
	readonly kind: GenPluginKind;
	/** Output directory, relative to the `buf.gen.yaml`. */
	readonly out: string;
	/** `opt:` values, normalised to a list even when written as a scalar. */
	readonly opt: readonly string[];
	/** `revision:` for remote plugins, when pinned. */
	readonly revision?: number;
}

/** A parsed `buf.gen.yaml`. */
export interface GenConfig {
	/** Absolute path of the file. */
	readonly path: string;
	/** `version:` as written — `v1` and `v2` shapes differ. */
	readonly version: string;
	/** True when `managed.enabled` is set. */
	readonly managed: boolean;
	readonly plugins: readonly GenPlugin[];
}

/** One buf module in the workspace and what it depends on. */
export interface ModuleDeps {
	/** Absolute directory holding the `buf.yaml`. */
	readonly root: string;
	/** `name:` from the `buf.yaml`, when it has one. */
	readonly name?: string;
	readonly deps: readonly BufDep[];
}

/** Everything the Dependencies view and the Registry panel render. */
export interface DependencyModel {
	readonly modules: readonly ModuleDeps[];
	readonly gen: readonly GenConfig[];
	/** Cached modules no `buf.yaml` declares, including orphans. */
	readonly undeclared: readonly BufDep[];
	/** True once update status has been fetched at least once. */
	readonly updatesChecked: boolean;
	/** Set when the model could not be built at all. */
	readonly error?: string;
}

/* ------------------------------------------------------------------ *
 * Symbol detail
 * ------------------------------------------------------------------ */

/** A point in a file. Zero-based, matching `vscode.Position`. */
export interface Loc {
	/** Absolute filesystem path. */
	readonly path: string;
	readonly line: number;
	readonly character?: number;
}

/** One lint finding, already attributed to a symbol. */
export interface ProblemDetail {
	/** e.g. `core::0192::has-comments`. */
	readonly ruleId: string;
	readonly message: string;
	readonly docUrl?: string;
	readonly severity: "error" | "warning" | "info";
	readonly loc: Loc;
	/**
	 * Findings collapsed into this one. `api-linter` reports some rules once
	 * per field, so a message repeated across five fields is one row with a
	 * count rather than five rows.
	 */
	readonly occurrences: number;
	/** The lines the collapsed occurrences came from, ascending. */
	readonly lines: readonly number[];
}

/** One field of a message. */
export interface FieldDetail {
	readonly name: string;
	/** Type as written, e.g. `google.protobuf.Timestamp`. */
	readonly type: string;
	readonly number: number;
	readonly repeated: boolean;
	/** `google.api.field_behavior` values set on the field. */
	readonly behaviors: readonly string[];
	readonly doc?: string;
	readonly loc: Loc;
	/** Findings whose range falls inside this field's line. */
	readonly problemCount: number;
}

/** One key of a custom option's message body. */
export interface AnnotationKey {
	readonly key: string;
	/** Value as written, or `undefined` when the key is absent. */
	readonly value?: string;
	/** Rule that requires this key, when it is absent and one does. */
	readonly requiredBy?: string;
	readonly requiredByUrl?: string;
}

/** One custom option applied to the selected symbol. */
export interface AnnotationDetail {
	/** e.g. `google.api.resource`. */
	readonly name: string;
	readonly keys: readonly AnnotationKey[];
}

/** One RPC of a service. */
export interface RpcDetail {
	readonly name: string;
	readonly requestType: string;
	readonly responseType: string;
	readonly clientStreaming: boolean;
	readonly serverStreaming: boolean;
	/** `google.api.http` rule, rendered as `POST /v1/…`, when present. */
	readonly httpRule?: string;
	readonly loc: Loc;
	readonly problemCount: number;
}

/** What the Details panel shows for one selected symbol. */
export interface SymbolDetail {
	readonly name: string;
	/** Fully-qualified name, e.g. `library.v1.Book`. */
	readonly fqn: string;
	readonly kind: "service" | "rpc" | "message" | "enum" | "field" | "file";
	readonly package?: string;
	readonly loc: Loc;
	/** Leading comment, markers already stripped. */
	readonly doc?: string;
	/** True when a `google.api.resource` option is present. */
	readonly isResource: boolean;
	readonly fields: readonly FieldDetail[];
	readonly rpcs: readonly RpcDetail[];
	readonly enumValues: readonly { name: string; number: number }[];
	readonly annotations: readonly AnnotationDetail[];
	readonly problems: readonly ProblemDetail[];
	/** Sum of {@link ProblemDetail.occurrences}, not `problems.length`. */
	readonly problemTotal: number;
}

/* ------------------------------------------------------------------ *
 * Messages: host → panel
 * ------------------------------------------------------------------ */

/** Sent to the Details panel whenever the tree selection changes. */
export interface DetailsUpdate {
	readonly type: "details/update";
	/** `null` clears the panel — nothing is selected. */
	readonly detail: SymbolDetail | null;
}

/** Sent to the Registry panel when the dependency model is rebuilt. */
export interface RegistryUpdate {
	readonly type: "registry/update";
	readonly model: DependencyModel;
}

/** Scopes the Registry panel to one registry host. */
export interface RegistryFocus {
	readonly type: "registry/focus";
	/** Host to select, e.g. `buf.build`. `null` clears the scope. */
	readonly remote: string | null;
}

/** Long operations report progress rather than freezing a button. */
export interface TaskProgress {
	readonly type: "task/progress";
	/** Correlates with the `taskId` the panel sent. */
	readonly taskId: string;
	readonly state: "running" | "done" | "failed";
	readonly message?: string;
}

export type HostMessage =
	| DetailsUpdate
	| RegistryUpdate
	| RegistryFocus
	| TaskProgress;

/* ------------------------------------------------------------------ *
 * Messages: panel → host
 * ------------------------------------------------------------------ */

/** Open a file at a line in the editor. */
export interface RevealRequest {
	readonly type: "reveal";
	readonly loc: Loc;
}

/** Open a URL in the system browser. */
export interface OpenExternalRequest {
	readonly type: "openExternal";
	readonly url: string;
}

/** Append a dependency to a `buf.yaml` and run `buf dep update`. */
export interface AddDepRequest {
	readonly type: "dep/add";
	readonly taskId: string;
	/** Module reference, e.g. `buf.build/the-protobuf-project/rfc`. */
	readonly name: string;
	/** Absolute path of the `buf.yaml` to edit. */
	readonly bufYaml: string;
}

/** Run `buf dep update` for one module directory. */
export interface UpdateDepsRequest {
	readonly type: "dep/update";
	readonly taskId: string;
	readonly root: string;
}

/** Fetch update status from the registry for every known module. */
export interface CheckUpdatesRequest {
	readonly type: "dep/checkUpdates";
	readonly taskId: string;
}

/** Run `buf generate` for one module directory. */
export interface GenerateRequest {
	readonly type: "gen/run";
	readonly taskId: string;
	readonly root: string;
}

/** Sent once when a panel's script has mounted and wants its first payload. */
export interface ReadyNotice {
	readonly type: "ready";
}

export type PanelMessage =
	| ReadyNotice
	| RevealRequest
	| OpenExternalRequest
	| AddDepRequest
	| UpdateDepsRequest
	| CheckUpdatesRequest
	| GenerateRequest;
