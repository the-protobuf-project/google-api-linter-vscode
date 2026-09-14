/**
 * A `vscode` module stand-in for unit tests.
 *
 * The extension's pure logic — the index, the annotation registry, the
 * completion and token providers — is deliberately free of extension-host
 * state, but most of it still imports `vscode` for value types like `Range`
 * and `CompletionItem`. Node cannot resolve that module outside the host, so
 * `bun test` loads this in its place via `mock.module` in `setup.ts`.
 *
 * Only what the tests actually touch is implemented, and each class carries the
 * real one's observable shape rather than a loose object, so a test that reads
 * `range.start.line` is reading the same field the extension does.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Mirrors `vscode.Position`.
 *
 * The comparison and derivation methods are implemented, not merely declared:
 * a test hands these to code typed against the real `vscode.Position`, so a
 * partial class fails to typecheck at every call site rather than at one.
 */
export class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
	isEqual(other: Position): boolean {
		return this.line === other.line && this.character === other.character;
	}
	isBefore(other: Position): boolean {
		return (
			this.line < other.line ||
			(this.line === other.line && this.character < other.character)
		);
	}
	isBeforeOrEqual(other: Position): boolean {
		return this.isBefore(other) || this.isEqual(other);
	}
	isAfter(other: Position): boolean {
		return !this.isBeforeOrEqual(other);
	}
	isAfterOrEqual(other: Position): boolean {
		return !this.isBefore(other);
	}
	compareTo(other: Position): number {
		if (this.isEqual(other)) {
			return 0;
		}
		return this.isBefore(other) ? -1 : 1;
	}
	// Both take the object form as well as positional arguments, matching the
	// real overloads; without it the whole class fails to satisfy
	// `vscode.Position` and every call site reports a type error.
	translate(
		lineDelta?: number | { lineDelta?: number; characterDelta?: number },
		characterDelta?: number,
	): Position {
		const delta =
			typeof lineDelta === "object" ? lineDelta : { lineDelta, characterDelta };
		return new Position(
			this.line + (delta.lineDelta ?? 0),
			this.character + (delta.characterDelta ?? 0),
		);
	}
	with(
		line?: number | { line?: number; character?: number },
		character?: number,
	): Position {
		const next = typeof line === "object" ? line : { line, character };
		return new Position(
			next.line ?? this.line,
			next.character ?? this.character,
		);
	}
}

/** Position ordering, the one comparison `Range.contains` needs. */
function isBefore(a: Position, b: Position): boolean {
	return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/** Mirrors `vscode.Range`, including the two-Position constructor overload. */
export class Range {
	readonly start: Position;
	readonly end: Position;
	constructor(
		startLineOrStart: number | Position,
		startCharacterOrEnd: number | Position,
		endLine?: number,
		endCharacter?: number,
	) {
		if (startLineOrStart instanceof Position) {
			this.start = startLineOrStart;
			this.end = startCharacterOrEnd as Position;
		} else {
			this.start = new Position(
				startLineOrStart,
				startCharacterOrEnd as number,
			);
			this.end = new Position(endLine ?? 0, endCharacter ?? 0);
		}
	}
	/** True when `other` lies inside this range, both ends included. */
	contains(other: Position | Range): boolean {
		const from = other instanceof Range ? other.start : other;
		const to = other instanceof Range ? other.end : other;
		return !isBefore(from, this.start) && !isBefore(this.end, to);
	}
}

/**
 * Mirrors `vscode.Location`, including the `Position` overload: the real class
 * widens a bare position into an empty range, so callers that pass one still
 * read `location.range.start`.
 */
export class Location {
	readonly range: Range;
	constructor(
		readonly uri: Uri,
		rangeOrPosition: Range | Position,
	) {
		this.range =
			rangeOrPosition instanceof Position
				? new Range(rangeOrPosition, rangeOrPosition)
				: rangeOrPosition;
	}
}

/** Minimal `vscode.Uri`: enough to key a document and print a path. */
export class Uri {
	private constructor(
		readonly fsPath: string,
		readonly scheme = "file",
	) {}
	static file(fsPath: string): Uri {
		return new Uri(fsPath);
	}
	static parse(value: string): Uri {
		return new Uri(value.replace(/^file:\/\//, ""));
	}
	/** Joins path segments onto a uri, as `vscode.Uri.joinPath` does. */
	static joinPath(base: Uri, ...segments: string[]): Uri {
		return new Uri(path.join(base.fsPath, ...segments), base.scheme);
	}
	get path(): string {
		return this.fsPath;
	}
	toString(): string {
		return `${this.scheme}://${this.fsPath}`;
	}
	/** Always empty: the extension only ever constructs file uris. */
	readonly authority = "";
	readonly query = "";
	readonly fragment = "";
	/** Mirrors `vscode.Uri.with`; the callers only ever change scheme or path. */
	with(change: { scheme?: string; path?: string }): Uri {
		return new Uri(change.path ?? this.fsPath, change.scheme ?? this.scheme);
	}
	toJSON(): object {
		return { scheme: this.scheme, path: this.fsPath };
	}
}

export class SnippetString {
	constructor(readonly value: string) {}
}

export class MarkdownString {
	isTrusted = false;
	constructor(public value = "") {}
	appendMarkdown(text: string): this {
		this.value += text;
		return this;
	}
}

/** Mirrors `vscode.ThemeColor`: an id resolved against the active theme. */
export class ThemeColor {
	constructor(readonly id: string) {}
}

export class ThemeIcon {
	/** The built-in folder icon, as the real module exposes it. */
	static readonly Folder = new ThemeIcon("folder");
	constructor(
		readonly id: string,
		readonly color?: ThemeColor,
	) {}
}

export class CompletionItem {
	detail?: string;
	documentation?: MarkdownString | string;
	insertText?: string | SnippetString;
	range?: Range;
	sortText?: string;
	filterText?: string;
	additionalTextEdits?: TextEdit[];
	constructor(
		readonly label: string,
		readonly kind?: number,
	) {}
}

export class CompletionList {
	constructor(
		readonly items: CompletionItem[] = [],
		readonly isIncomplete = false,
	) {}
}

export class Hover {
	constructor(
		readonly contents: MarkdownString[],
		readonly range?: Range,
	) {}
}

export class TextEdit {
	private constructor(
		readonly range: Range,
		readonly newText: string,
	) {}
	static insert(position: Position, newText: string): TextEdit {
		return new TextEdit(new Range(position, position), newText);
	}
	static replace(range: Range, newText: string): TextEdit {
		return new TextEdit(range, newText);
	}
}

export class TreeItem {
	description?: string;
	iconPath?: ThemeIcon;
	tooltip?: string;
	contextValue?: string;
	command?: unknown;
	constructor(
		public label: string,
		public collapsibleState?: number,
	) {}
}

export class EventEmitter<T> {
	private readonly listeners: Array<(value: T) => void> = [];
	readonly event = (listener: (value: T) => void): { dispose(): void } => {
		this.listeners.push(listener);
		return {
			dispose: () => {
				const at = this.listeners.indexOf(listener);
				if (at >= 0) {
					this.listeners.splice(at, 1);
				}
			},
		};
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}
	dispose(): void {
		this.listeners.length = 0;
	}
}

/** Mirrors `vscode.DiagnosticRelatedInformation`. */
export class DiagnosticRelatedInformation {
	constructor(
		readonly location: Location,
		readonly message: string,
	) {}
}

export class Diagnostic {
	code?: string | number;
	source?: string;
	relatedInformation?: DiagnosticRelatedInformation[];
	constructor(
		readonly range: Range,
		readonly message: string,
		readonly severity?: number,
	) {}
}

/**
 * Mirrors `vscode.DiagnosticCollection`, keeping what was published.
 *
 * A provider's only observable output is what it hands the collection, so the
 * real module's write-only object would make every diagnostic test vacuous.
 */
export class DiagnosticCollection {
	private readonly entries = new Map<string, readonly Diagnostic[]>();
	/** True once disposed, which the extension does on deactivation. */
	disposed = false;
	constructor(readonly name = "") {}
	set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void {
		if (diagnostics === undefined) {
			this.entries.delete(uri.toString());
			return;
		}
		this.entries.set(uri.toString(), diagnostics);
	}
	get(uri: Uri): readonly Diagnostic[] | undefined {
		return this.entries.get(uri.toString());
	}
	delete(uri: Uri): void {
		this.entries.delete(uri.toString());
	}
	clear(): void {
		this.entries.clear();
	}
	/**
	 * Iterates every uri carrying diagnostics.
	 *
	 * Part of the real API, and the only way to read a collection whole —
	 * `get` needs a uri you already have. Code that summarises findings across
	 * a workspace reaches for this rather than re-deriving the file list.
	 */
	forEach(
		callback: (
			uri: Uri,
			diagnostics: readonly Diagnostic[],
			collection: DiagnosticCollection,
		) => void,
	): void {
		for (const [key, diagnostics] of this.entries) {
			callback(Uri.parse(key), diagnostics, this);
		}
	}

	/** Uris currently carrying diagnostics. */
	uris(): string[] {
		return [...this.entries.keys()];
	}
	dispose(): void {
		this.disposed = true;
		this.entries.clear();
	}
}

/**
 * Records the ranges pushed to it, so a test can assert on tokens without
 * decoding the delta-encoded integer array the real builder emits.
 */
/** One range the provider asked to be highlighted. */
export interface RecordedToken {
	range: Range;
	type: string;
	modifiers: readonly string[];
}

export class SemanticTokensBuilder {
	readonly pushed: RecordedToken[] = [];
	constructor(readonly legend?: SemanticTokensLegend) {}
	push(range: Range, type: string, modifiers: readonly string[] = []): void {
		this.pushed.push({ range, type, modifiers });
	}
	build(): { tokens: RecordedToken[] } {
		return { tokens: this.pushed };
	}
}

export class SemanticTokensLegend {
	constructor(
		readonly tokenTypes: readonly string[],
		readonly tokenModifiers: readonly string[],
	) {}
}

export const CompletionItemKind = {
	Text: 0,
	Method: 1,
	Function: 2,
	Field: 4,
	Variable: 5,
	Class: 6,
	Property: 9,
	Enum: 12,
	Keyword: 13,
	Snippet: 14,
	Struct: 21,
	EnumMember: 19,
} as const;

export const TreeItemCollapsibleState = {
	None: 0,
	Collapsed: 1,
	Expanded: 2,
} as const;

export const DiagnosticSeverity = {
	Error: 0,
	Warning: 1,
	Information: 2,
	Hint: 3,
} as const;

export const SymbolKind = {
	Class: 4,
	Method: 5,
	Property: 6,
	Field: 7,
	Enum: 9,
	Interface: 10,
	EnumMember: 19,
	Struct: 22,
} as const;

export const ProgressLocation = {
	SourceControl: 1,
	Window: 10,
	Notification: 15,
} as const;

/** Never-cancelled token, the common case in a unit test. */
export const CancellationTokenNone = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

export const workspace = {
	getConfiguration: () => ({
		get: <T>(_key: string, fallback?: T): T | undefined => fallback,
	}),
	workspaceFolders: undefined as unknown,
	onDidChangeConfiguration: () => ({ dispose() {} }),
	/**
	 * Finds nothing by default. Globbing is the extension host's job, so a test
	 * that needs discovery assigns its own walker here and restores it after.
	 */
	findFiles: async (
		_include: string,
		_exclude?: string,
		_maxResults?: number,
	): Promise<Uri[]> => [],
	/** Owns nothing by default; assign per test to bound upward config walks. */
	getWorkspaceFolder: (_uri: Uri): { uri: Uri } | undefined => undefined,
	/** No folder is open, so the real module's fallback — the full path — applies. */
	asRelativePath: (target: Uri | string, _includeFolder?: boolean): string =>
		typeof target === "string" ? target : target.fsPath,
	/** Backed by the real filesystem: the callers only ever read file uris. */
	fs: {
		readFile: async (uri: Uri): Promise<Uint8Array> =>
			new Uint8Array(await fsp.readFile(uri.fsPath)),
		stat: async (uri: Uri): Promise<{ type: number; size: number }> => {
			const stat = await fsp.stat(uri.fsPath);
			return { type: stat.isDirectory() ? 2 : 1, size: stat.size };
		},
	},
	/** Watches nothing; a test assigns its own factory to capture the watcher. */
	createFileSystemWatcher: (pattern: string): FileSystemWatcher =>
		new FileSystemWatcher(pattern),
};

export const window = {
	showErrorMessage: () => Promise.resolve(undefined),
	showInformationMessage: () => Promise.resolve(undefined),
	createOutputChannel: () => ({
		appendLine() {},
		dispose() {},
		show() {},
	}),
	/**
	 * Runs the task straight away and returns what it returns. The real one
	 * wraps it in a notification, which is the extension host's business; a test
	 * only needs the work inside the callback to happen, and to be able to await
	 * it. The progress object accepts reports and discards them.
	 */
	withProgress: <T>(
		_options: { location?: number; title?: string; cancellable?: boolean },
		task: (
			progress: {
				report(value: { message?: string; increment?: number }): void;
			},
			token: typeof CancellationTokenNone,
		) => Thenable<T>,
	): Thenable<T> => task({ report() {} }, CancellationTokenNone),
	/**
	 * Registers nothing. The real one also contributes the built-in collapseAll
	 * command for the view id, which is why the extension calls it at all; a test
	 * that cares assigns its own factory to capture the provider it was given.
	 */
	createTreeView: (
		_viewId: string,
		_options: { treeDataProvider: unknown; showCollapseAll?: boolean },
	): { dispose(): void } => ({ dispose() {} }),
};

/**
 * Mirrors `vscode.version`.
 *
 * Anything that reports an environment — a bug-report capture, a diagnostic
 * dump — reads this, and its absence made every such test fail on a property
 * access rather than on anything it meant to assert.
 */
export const version = "1.137.0-test";

/** Mirrors `vscode.extensions`. Nothing is installed in a unit test. */
export const extensions = {
	getExtension(_id: string): undefined {
		return undefined;
	},
	all: [] as unknown[],
};

export const languages = {
	registerCompletionItemProvider: () => ({ dispose() {} }),
	registerHoverProvider: () => ({ dispose() {} }),
	registerDocumentSemanticTokensProvider: () => ({ dispose() {} }),
	createDiagnosticCollection: (name?: string) => new DiagnosticCollection(name),
	/** Never fires; a test assigns its own to drive the diagnostic refresh. */
	onDidChangeDiagnostics: (_listener: () => void): { dispose(): void } => ({
		dispose() {},
	}),
};

export const commands = {
	registerCommand: () => ({ dispose() {} }),
	executeCommand: () => Promise.resolve(undefined),
};

/**
 * Mirrors `vscode.Disposable`, which the extension uses as a teardown hook: a
 * callback pushed onto `context.subscriptions` so a timer is cleared when the
 * extension deactivates. Running that callback is the only observable part.
 */
export class Disposable {
	disposed = false;
	constructor(private readonly callOnDispose?: () => void) {}
	dispose(): void {
		this.disposed = true;
		this.callOnDispose?.();
	}
}

/**
 * A `vscode.FileSystemWatcher` that keeps its handlers rather than watching
 * anything. The extension wires refreshes to these, so a test fires them by
 * hand to prove a `buf.lock` write reaches the tree — and only once.
 */
export class FileSystemWatcher {
	readonly onCreate: Array<() => void> = [];
	readonly onChange: Array<() => void> = [];
	readonly onDelete: Array<() => void> = [];
	disposed = false;
	constructor(readonly pattern = "") {}
	onDidCreate(listener: () => void): { dispose(): void } {
		this.onCreate.push(listener);
		return { dispose() {} };
	}
	onDidChange(listener: () => void): { dispose(): void } {
		this.onChange.push(listener);
		return { dispose() {} };
	}
	onDidDelete(listener: () => void): { dispose(): void } {
		this.onDelete.push(listener);
		return { dispose() {} };
	}
	/** Fires every handler, as a save that creates then changes a file would. */
	fireAll(): void {
		for (const listener of [
			...this.onCreate,
			...this.onChange,
			...this.onDelete,
		]) {
			listener();
		}
	}
	dispose(): void {
		this.disposed = true;
	}
}
