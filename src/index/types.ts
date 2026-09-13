/**
 * Shared contracts for the proto index.
 *
 * Every track builds against this file. It is owned by the integrator: do not
 * change a type here without updating plan.md and the tracks that consume it.
 *
 * Design rules these types exist to enforce:
 *   1. The index never retains file text. Parse, extract, discard.
 *   2. Nothing calls vscode.workspace.openTextDocument in bulk — that leaks
 *      documents VS Code can never release. The index reads via node fs.
 *   3. Symbols are keyed by fully-qualified name. Simple-name matching is what
 *      made rename rewrite 154 files at once on protobuf-fhir.
 */

/** Kinds of top-level or nested declaration the index records. */
export type SymbolKind =
	| "message"
	| "enum"
	| "service"
	| "rpc"
	| "field"
	| "enumValue"
	| "extend";

/** A file the index knows about. Paths are absolute. */
export interface IndexedFile {
	readonly id: number;
	readonly path: string;
	/** `package foo.bar.v1;` — empty string when the file declares none. */
	readonly packageName: string;
	/** Import paths exactly as written, e.g. `google/api/field_behavior.proto`. */
	readonly imports: readonly string[];
	/** Owning module root from the module graph, or undefined if outside one. */
	readonly moduleRoot?: string;
	/** mtimeMs at index time, used to decide whether a re-parse is needed. */
	readonly mtimeMs: number;
}

/** One declaration. `fqn` is package-qualified; `name` is the bare identifier. */
export interface IndexedSymbol {
	readonly fqn: string;
	readonly name: string;
	readonly kind: SymbolKind;
	readonly fileId: number;
	/** 0-based. */
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
	/** Enclosing symbol's fqn for nested declarations. */
	readonly parentFqn?: string;
	/** For rpc: `(Request) returns (Response)`. For field: the type name. */
	readonly detail?: string;
	/** Leading `//` comment, already stripped of markers. Omitted in reduced tiers. */
	readonly doc?: string;
}

/** A use of a type — field types, rpc request/response, map key/value. */
export interface IndexedReference {
	/** As written, possibly unqualified or partially qualified. */
	readonly typeName: string;
	/** Resolved fqn, or undefined when resolution failed. */
	readonly resolvedFqn?: string;
	readonly fileId: number;
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
}

/* ------------------------------------------------------------------ *
 * Annotations (track F)
 * ------------------------------------------------------------------ */

/** The `google.protobuf.*Options` message an extension extends. */
export type AnnotationTarget =
	| "File"
	| "Message"
	| "Field"
	| "Oneof"
	| "Enum"
	| "EnumValue"
	| "Service"
	| "Method";

/** One field inside an option body message. */
export interface AnnotationField {
	readonly name: string;
	readonly type: string;
	readonly number: number;
	readonly repeated: boolean;
	readonly doc?: string;
	/** Resolved fqn of the field's message type, when it is a message. */
	readonly messageFqn?: string;
}

/**
 * A custom option, derived wholly from its `extend` block. Nothing here is
 * hardcoded: the extension's stale `mcp.protobuf.*` strings are exactly what
 * this type exists to delete.
 */
export interface AnnotationDescriptor {
	/** `package` + field name, e.g. `mcp.v1.tool`. */
	readonly fqn: string;
	/** Bare field name, e.g. `tool`. */
	readonly name: string;
	/** Namespace, e.g. `mcp.v1`. */
	readonly namespace: string;
	readonly target: AnnotationTarget;
	/** Option body message type name as written in the extend block. */
	readonly type: string;
	readonly number: number;
	readonly repeated: boolean;
	readonly doc?: string;
	/** Indented block from the leading comment, godoc-style. */
	readonly example?: string;
	/** Import path a consuming file needs, e.g. `mcp/v1/annotations.proto`. */
	readonly importPath: string;
	readonly fileId: number;
	readonly line: number;
}

/** Resolved option body, looked up lazily — not built during the walk. */
export interface AnnotationBody {
	readonly fqn: string;
	readonly fields: readonly AnnotationField[];
}

export interface AnnotationRegistry {
	/** Every discovered annotation. */
	all(): readonly AnnotationDescriptor[];
	/** Exact lookup by fully-qualified option name. */
	get(fqn: string): AnnotationDescriptor | undefined;
	/** Annotations legal on a given proto element. */
	byTarget(target: AnnotationTarget): readonly AnnotationDescriptor[];
	/** Option body fields, resolved on demand. */
	body(descriptor: AnnotationDescriptor): AnnotationBody | undefined;
	/**
	 * Extension slots claimed by more than one distinct annotation. Protobuf
	 * requires uniqueness per extendee, so two here cannot be imported together.
	 */
	collisions(): readonly {
		target: AnnotationTarget;
		number: number;
		claimants: readonly AnnotationDescriptor[];
	}[];
}

/* ------------------------------------------------------------------ *
 * Module graph (track C)
 * ------------------------------------------------------------------ */

export interface BufDependency {
	/** e.g. `buf.build/googleapis/googleapis`. */
	readonly name: string;
	readonly commit: string;
	/** Absolute path in the buf module cache, when present locally. */
	readonly cachePath?: string;
}

export interface ProtoModule {
	/** Absolute directory containing the buf.yaml that declares this module. */
	readonly root: string;
	/** Absolute import roots for files in this module. */
	readonly roots: readonly string[];
	readonly deps: readonly BufDependency[];
	/** Absolute path to the governing `.api-linter.yaml`, if any. */
	readonly apiLinterConfig?: string;
	readonly name?: string;
}

export interface ModuleGraph {
	modules(): readonly ProtoModule[];
	/** Owning module for a file, by longest-prefix match. */
	forFile(absolutePath: string): ProtoModule | undefined;
	/**
	 * Every `--proto-path` needed to compile this file: its module's roots plus
	 * each dependency's cache path. Never invokes `buf export`.
	 */
	protoPathsFor(absolutePath: string): readonly string[];
}

/* ------------------------------------------------------------------ *
 * Memory tiers (track D)
 * ------------------------------------------------------------------ */

/**
 * Degrade ladder. The user's requirement is a hard ceiling that fails loudly,
 * never unbounded growth.
 */
export type IndexTier =
	/** Everything, including doc comments and field-level symbols. */
	| "full"
	/** Top-level symbols only; doc comments dropped. */
	| "reduced"
	/** No workspace index. Per-file features only; workspace features off. */
	| "onDemand";

export interface IndexBudget {
	readonly maxMemoryMB: number;
	readonly maxFiles: number;
}

export interface IndexStats {
	readonly tier: IndexTier;
	readonly fileCount: number;
	readonly symbolCount: number;
	readonly annotationCount: number;
	readonly bytesRead: number;
	readonly buildMs: number;
	readonly approxHeapMB: number;
	/** Set when the tier was lowered; user-visible, names the limit hit. */
	readonly degradeReason?: string;
}

/* ------------------------------------------------------------------ *
 * The index
 * ------------------------------------------------------------------ */

export interface ProtoIndex {
	/** Build from scratch. Safe to call again; replaces prior contents. */
	build(roots: readonly string[]): Promise<IndexStats>;
	/** Re-parse exactly one file and patch its slice. */
	update(absolutePath: string): Promise<void>;
	/** Drop one file's entries. */
	remove(absolutePath: string): void;

	stats(): IndexStats;
	files(): readonly IndexedFile[];
	file(id: number): IndexedFile | undefined;
	fileByPath(absolutePath: string): IndexedFile | undefined;

	/** Exact fully-qualified lookup. The basis of safe rename. */
	symbol(fqn: string): IndexedSymbol | undefined;
	/** Substring match on the bare name, for Go to Symbol. */
	searchSymbols(query: string, limit?: number): readonly IndexedSymbol[];
	/** Declarations in one file. */
	symbolsInFile(fileId: number): readonly IndexedSymbol[];
	/**
	 * Uses of a fully-qualified type. Only references that resolve to this exact
	 * fqn — never simple-name matches across packages.
	 */
	referencesTo(fqn: string): readonly IndexedReference[];

	annotations(): AnnotationRegistry;

	/** Fires when a build or update changes contents. */
	onDidChange(listener: () => void): { dispose(): void };
	dispose(): void;
}
