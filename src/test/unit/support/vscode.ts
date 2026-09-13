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

/** Mirrors `vscode.Position`. */
export class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
	isEqual(other: Position): boolean {
		return this.line === other.line && this.character === other.character;
	}
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
}

/** Mirrors `vscode.Location`. */
export class Location {
	constructor(
		readonly uri: Uri,
		readonly range: Range,
	) {}
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
	get path(): string {
		return this.fsPath;
	}
	toString(): string {
		return `${this.scheme}://${this.fsPath}`;
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

export class ThemeIcon {
	constructor(readonly id: string) {}
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

export class Diagnostic {
	code?: string | number;
	source?: string;
	constructor(
		readonly range: Range,
		readonly message: string,
		readonly severity?: number,
	) {}
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
};

export const window = {
	showErrorMessage: () => Promise.resolve(undefined),
	showInformationMessage: () => Promise.resolve(undefined),
	createOutputChannel: () => ({
		appendLine() {},
		dispose() {},
		show() {},
	}),
};

export const languages = {
	registerCompletionItemProvider: () => ({ dispose() {} }),
	registerHoverProvider: () => ({ dispose() {} }),
	registerDocumentSemanticTokensProvider: () => ({ dispose() {} }),
	createDiagnosticCollection: () => ({
		set() {},
		delete() {},
		clear() {},
		dispose() {},
		get: () => undefined,
	}),
};

export const commands = {
	registerCommand: () => ({ dispose() {} }),
	executeCommand: () => Promise.resolve(undefined),
};
