import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ProtoIndex } from "./index/types";
import { getProtoImportSearchRoots } from "./utils/protoImportRoots";
import { type ProtoSymbol, parseProtoDocument } from "./utils/protoParser";

/** `package foo.bar.v1;` */
const RE_PACKAGE = /^package\s+([A-Za-z0-9_.]+)\s*;/m;

/** A possibly package-qualified type name, e.g. `Foo` or `google.protobuf.Any`. */
const RE_QUALIFIED_NAME = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

/** A bare identifier — safe to interpolate into a definition regex. */
const RE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The package a proto file declares, read from its text.
 *
 * Used when the index has not seen the file yet (a new or unsaved file), so
 * navigation still resolves against the workspace.
 */
export function packageOf(text: string): string {
	return text.match(RE_PACKAGE)?.[1] ?? "";
}

/**
 * The enclosing message/service/enum names at a position, outermost first.
 *
 * Protobuf resolves a type name against the innermost enclosing scope first, so
 * `Bar` written inside `message Foo` in package `p` means `p.Foo.Bar` when that
 * exists and `p.Bar` otherwise.
 */
export function enclosingScopeChain(
	document: vscode.TextDocument,
	position: vscode.Position,
): string[] {
	const chain: string[] = [];
	const descend = (symbols: readonly ProtoSymbol[]): void => {
		for (const s of symbols) {
			if (
				(s.kind === "message" || s.kind === "service" || s.kind === "enum") &&
				s.range.contains(position)
			) {
				chain.push(s.name);
				if (s.children) {
					descend(s.children);
				}
				return;
			}
		}
	};
	descend(parseProtoDocument(document));
	return chain;
}

/**
 * Candidate fully-qualified names for a type as written, innermost scope first.
 *
 * A leading `.` makes the name absolute, exactly as protoc treats it. Every
 * other name is tried against each enclosing scope and finally at the root.
 *
 * @param written - The type name as it appears in the source.
 * @param packageName - The referring file's `package`, or `""`.
 * @param scopeChain - Enclosing declaration names, outermost first.
 */
export function protoFqnCandidates(
	written: string,
	packageName: string,
	scopeChain: readonly string[],
): string[] {
	const bare = written.replace(/^\./, "");
	if (written.startsWith(".")) {
		return [bare];
	}

	const scopes = [
		...(packageName ? packageName.split(".") : []),
		...scopeChain,
	];
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (candidate: string) => {
		if (!seen.has(candidate)) {
			seen.add(candidate);
			candidates.push(candidate);
		}
	};
	for (let i = scopes.length; i > 0; i--) {
		push(`${scopes.slice(0, i).join(".")}.${bare}`);
	}
	push(bare);
	return candidates;
}

/**
 * Resolves a type name as written at a position to the fully-qualified name the
 * index knows it by, or `undefined` when nothing resolves.
 *
 * This is the whole of task 1.5: every cross-file feature keys off the value
 * returned here. Matching on the simple name instead — the last dot-segment —
 * is what made Find References return unrelated types and made Rename rewrite
 * 154 files at once, because 76.2% of type names in the reference repo are
 * defined in more than one file.
 */
export function resolveTypeFqn(
	index: ProtoIndex,
	document: vscode.TextDocument,
	position: vscode.Position,
	written: string,
): string | undefined {
	const file = index.fileByPath(document.uri.fsPath);
	const packageName = file?.packageName ?? packageOf(document.getText());
	const candidates = protoFqnCandidates(
		written,
		packageName,
		enclosingScopeChain(document, position),
	);
	for (const candidate of candidates) {
		if (index.symbol(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Provides go-to-definition for proto types like google.protobuf.Timestamp
 *
 * Resolution order is index first (exact, fully-qualified), then the current
 * file, then this file's own imports resolved against known roots. The previous
 * last-resort — a `fast-glob` of `workspaceRoot/**<!---->/<basename>` on every
 * request — is gone: it scanned the whole workspace to answer one keystroke and
 * matched files by basename regardless of package.
 */
export class ProtoDefinitionProvider implements vscode.DefinitionProvider {
	/**
	 * @param index - Symbol index. Optional so the extension can wire providers
	 *   before the index exists; absent falls back to file-local resolution.
	 */
	constructor(private readonly index?: ProtoIndex) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.Definition | null> {
		const index = this.workspaceIndex();

		// First try google.* types (e.g., google.protobuf.Timestamp)
		let wordRange = document.getWordRangeAtPosition(
			position,
			/google\.[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*/,
		);
		if (wordRange) {
			const word = document.getText(wordRange);
			if (index) {
				const indexed = this.locationForFqn(index, word);
				if (indexed) {
					return indexed;
				}
			}
			const protoFile = await this.findProtoFile(word);
			if (protoFile) {
				return await this.findDefinitionInFile(protoFile, word);
			}
		}

		// Try local proto types (e.g., Todo, Priority, CreateTodoRequest)
		wordRange = document.getWordRangeAtPosition(position, RE_QUALIFIED_NAME);
		if (!wordRange) {
			return null;
		}

		const word = document.getText(wordRange);
		const text = document.getText();

		// Search in current file first. Only for an unqualified name: `a.b.Thing`
		// names another package's type even when this file declares a `Thing`.
		let location = word.includes(".")
			? null
			: this.findDefinitionInText(text, document.uri, word);
		if (location) {
			return location;
		}

		// The index answers the cross-file case exactly, by fully-qualified name
		if (index) {
			const fqn = resolveTypeFqn(index, document, position, word);
			if (fqn) {
				const indexed = this.locationForFqn(index, fqn);
				if (indexed) {
					return indexed;
				}
			}
		}

		// Search in imported files
		location = await this.findDefinitionInImports(text, document.uri, word);
		if (location) {
			return location;
		}

		return null;
	}

	/**
	 * The index only answers workspace questions when it actually holds one.
	 * `onDemand` is the tier that means "no workspace index".
	 */
	private workspaceIndex(): ProtoIndex | undefined {
		if (!this.index) {
			return undefined;
		}
		try {
			return this.index.stats().tier === "onDemand" ? undefined : this.index;
		} catch {
			// Index constructed but not built yet: treat as absent.
			return undefined;
		}
	}

	/** Location of an exact fully-qualified symbol, from the index. */
	private locationForFqn(
		index: ProtoIndex,
		fqn: string,
	): vscode.Location | null {
		const symbol = index.symbol(fqn);
		if (!symbol) {
			return null;
		}
		const file = index.file(symbol.fileId);
		if (!file) {
			return null;
		}
		return new vscode.Location(
			vscode.Uri.file(file.path),
			new vscode.Range(
				symbol.line,
				symbol.startCol,
				symbol.line,
				symbol.endCol,
			),
		);
	}

	/**
	 * Finds the proto file for a google.* type
	 */
	private async findProtoFile(typeName: string): Promise<string | null> {
		// Convert google.protobuf.FieldMask -> google/protobuf/field_mask.proto
		const parts = typeName.split(".");
		const typeNamePart = parts[parts.length - 1];
		// Convert CamelCase to snake_case
		const fileName = typeNamePart
			.replace(/([A-Z])/g, "_$1")
			.toLowerCase()
			.replace(/^_/, "");
		const dirPath = parts.slice(0, -1).join("/");

		const homeDir = os.homedir();

		// For google.protobuf types, the path is src/google/protobuf/...
		const isProtobufType = typeName.startsWith("google.protobuf.");

		if (isProtobufType) {
			const protoPath = `src/${dirPath}/${fileName}.proto`;
			const protobufPath = path.join(homeDir, ".gapi", "protobuf", protoPath);

			if (fs.existsSync(protobufPath)) {
				return protobufPath;
			}

			// Also check without src/ prefix
			const altProtoPath = `${dirPath}/${fileName}.proto`;
			const altProtobufPath = path.join(
				homeDir,
				".gapi",
				"protobuf",
				altProtoPath,
			);

			if (fs.existsSync(altProtobufPath)) {
				return altProtobufPath;
			}

			return null;
		}

		// For google.api types, check googleapis
		const protoPath = `${dirPath}/${fileName}.proto`;
		const googleapisPath = path.join(homeDir, ".gapi", "googleapis", protoPath);

		if (fs.existsSync(googleapisPath)) {
			return googleapisPath;
		}

		// Check in workspace .gapi/googleapis
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			for (const folder of workspaceFolders) {
				const workspacePath = path.join(
					folder.uri.fsPath,
					".gapi",
					"googleapis",
					protoPath,
				);
				if (fs.existsSync(workspacePath)) {
					return workspacePath;
				}
			}
		}

		return null;
	}

	/**
	 * Finds the definition of a type within a proto file on disk.
	 *
	 * Reads the bytes and drops them. Opening a `TextDocument` here would retain
	 * the file for the rest of the session.
	 */
	private async findDefinitionInFile(
		filePath: string,
		typeName: string,
	): Promise<vscode.Location | null> {
		const text = await this.readFileText(filePath);
		if (text === undefined) {
			return null;
		}
		return this.findDefinitionInText(text, vscode.Uri.file(filePath), typeName);
	}

	/** Reads a file's text, or `undefined` when it cannot be read. */
	private async readFileText(filePath: string): Promise<string | undefined> {
		try {
			return await fs.promises.readFile(filePath, "utf-8");
		} catch (error) {
			console.error(`Error reading proto file ${filePath}:`, error);
			return undefined;
		}
	}

	/**
	 * Finds a `message`/`enum`/`service` declaration in already-loaded text.
	 */
	private findDefinitionInText(
		text: string,
		uri: vscode.Uri,
		typeName: string,
	): vscode.Location | null {
		// Extract the type name (last part after the last dot)
		const simpleTypeName = typeName.split(".").pop() ?? typeName;
		if (!RE_IDENTIFIER.test(simpleTypeName)) {
			return null;
		}

		const definitionRegex = new RegExp(
			`^\\s*(message|enum|service)\\s+${simpleTypeName}\\s*\\{`,
		);
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (definitionRegex.test(lines[i])) {
				const position = new vscode.Position(i, 0);
				return new vscode.Location(uri, new vscode.Range(position, position));
			}
		}
		return null;
	}

	/**
	 * Resolves a type name (e.g. "CreateTodoRequest" or "google.protobuf.Timestamp")
	 * to its definition location, using the given context file for imports.
	 */
	public async resolveTypeToLocation(
		typeName: string,
		contextUri: vscode.Uri,
	): Promise<vscode.Location | null> {
		const index = this.workspaceIndex();

		if (index) {
			const file = index.fileByPath(contextUri.fsPath);
			const candidates = protoFqnCandidates(
				typeName,
				file?.packageName ?? "",
				[],
			);
			for (const candidate of candidates) {
				const location = this.locationForFqn(index, candidate);
				if (location) {
					return location;
				}
			}
		}

		if (typeName.startsWith("google.")) {
			const protoFile = await this.findProtoFile(typeName);
			if (protoFile) {
				return await this.findDefinitionInFile(protoFile, typeName);
			}
			return null;
		}

		// Fall back to the context file's own text, read and discarded.
		// Both helpers key off the name's last segment, so one pass covers the
		// qualified and unqualified spellings alike.
		const text = await this.readFileText(contextUri.fsPath);
		if (text === undefined) {
			return null;
		}
		const location = this.findDefinitionInText(text, contextUri, typeName);
		if (location) {
			return location;
		}
		return await this.findDefinitionInImports(text, contextUri, typeName);
	}

	/**
	 * Finds a definition among the files this one imports.
	 *
	 * Bounded by the file's own import list resolved against known roots — never
	 * a workspace-wide search, and never by basename alone, which cannot tell
	 * `store/v1/foo.proto` from `payment/v1/foo.proto`.
	 */
	private async findDefinitionInImports(
		text: string,
		fromUri: vscode.Uri,
		typeName: string,
	): Promise<vscode.Location | null> {
		const importRegex = /^\s*import\s+('|")(.+\.proto)('|")\s*;\s*$/gim;
		const imports: string[] = [];
		let match: RegExpExecArray | null;
		for (;;) {
			match = importRegex.exec(text);
			if (!match) {
				break;
			}
			imports.push(match[2]);
		}
		if (imports.length === 0) {
			return null;
		}

		const searchRootsSeen = new Set<string>();
		const searchRoots: string[] = [];
		const pushRoot = (r: string | undefined) => {
			if (!r) {
				return;
			}
			const n = path.resolve(r);
			if (!searchRootsSeen.has(n)) {
				searchRootsSeen.add(n);
				searchRoots.push(n);
			}
		};
		pushRoot(path.dirname(fromUri.fsPath));
		pushRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
		for (const r of await getProtoImportSearchRoots(undefined)) {
			pushRoot(r);
		}

		for (const importPath of imports) {
			// Search using the full import path relative to each known root
			// (preserves directory structure so store/v1/foo.proto ≠ payment/v1/foo.proto)
			for (const root of searchRoots) {
				const candidate = path.join(root, importPath);
				try {
					if (!fs.existsSync(candidate)) {
						continue;
					}
				} catch {
					continue;
				}
				const location = await this.findDefinitionInFile(candidate, typeName);
				if (location) {
					return location;
				}
			}
		}

		return null;
	}
}
