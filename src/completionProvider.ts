import * as path from "node:path";
import * as vscode from "vscode";
import type { IndexedFile, ProtoIndex } from "./index/types";

/** Completion item with type hint (detail) and documentation */
interface ProtoCompletionSpec {
	label: string;
	kind: vscode.CompletionItemKind;
	detail: string;
	documentation: string | vscode.MarkdownString;
	insertText?: string;
	insertTextFormat?: 1 | 2; // 1 = PlainText, 2 = Snippet
}

/**
 * Cap on import-path suggestions offered at once. With an empty prefix every
 * indexed file is a candidate; the list is marked incomplete when it is hit, so
 * VS Code re-queries as the user narrows the path.
 */
const IMPORT_COMPLETION_LIMIT = 200;

/**
 * Provides completions with type hints for Protocol Buffers:
 * messages, services, RPC, field types, options (e.g. google.api.http), and keywords.
 *
 * Custom annotation options are deliberately absent: they are derived from the
 * `extend google.protobuf.*Options` blocks in the index by the annotation
 * completion provider. Hardcoding them here is what left `mcp.protobuf.*` in
 * the list two generations after the namespace became `mcp.v1.*`, inserting
 * option names that do not compile.
 */
export class ProtoCompletionProvider implements vscode.CompletionItemProvider {
	/**
	 * @param index - Symbol index, used for import-path completion. Optional so
	 *   the extension can wire providers before the index exists; absent means no
	 *   import-path suggestions.
	 */
	constructor(private readonly index?: ProtoIndex) {}

	private readonly topLevelKeywords: ProtoCompletionSpec[] = [
		{
			label: "syntax",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				'Declare proto syntax version. Use `"proto3"` for Protocol Buffers 3.',
		},
		{
			label: "package",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Package name for this file. Prevents name clashes (e.g. `package my.api.v1;`).",
		},
		{
			label: "option",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				'Set file-level or field-level options (e.g. `option (google.api.http) = { get: "/v1/foo" };`).',
		},
		{
			label: "import",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Import another .proto file. Use `public` for transitive imports.",
		},
		{
			label: "message",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Define a message type. Contains named fields with types and field numbers.",
		},
		{
			label: "enum",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Define an enum type. Values must be unique and start at 0 or use explicit numbers.",
		},
		{
			label: "service",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Define an RPC service. Contains `rpc` methods with request/response types.",
		},
	];

	private readonly scalarTypes: ProtoCompletionSpec[] = [
		{
			label: "double",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "64-bit floating point. Wire type: fixed64 (1).",
		},
		{
			label: "float",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "32-bit floating point. Wire type: fixed32 (5).",
		},
		{
			label: "int32",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation:
				"Signed 32-bit int. Variable-length encoding. Use for negative numbers.",
		},
		{
			label: "int64",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation:
				"Signed 64-bit int. Variable-length encoding. Use for negative numbers.",
		},
		{
			label: "uint32",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Unsigned 32-bit int. Variable-length encoding.",
		},
		{
			label: "uint64",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Unsigned 64-bit int. Variable-length encoding.",
		},
		{
			label: "sint32",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation:
				"Signed 32-bit int. ZigZag encoding. Good for negative-heavy data.",
		},
		{
			label: "sint64",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Signed 64-bit int. ZigZag encoding.",
		},
		{
			label: "fixed32",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation:
				"Unsigned 32-bit int. Always 4 bytes. Use for hashes, IDs.",
		},
		{
			label: "fixed64",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Unsigned 64-bit int. Always 8 bytes.",
		},
		{
			label: "sfixed32",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Signed 32-bit int. Always 4 bytes.",
		},
		{
			label: "sfixed64",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Signed 64-bit int. Always 8 bytes.",
		},
		{
			label: "bool",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Boolean. Encoded as 0 or 1.",
		},
		{
			label: "string",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "UTF-8 encoded text. Must be valid UTF-8.",
		},
		{
			label: "bytes",
			kind: vscode.CompletionItemKind.TypeParameter,
			detail: "scalar",
			documentation: "Arbitrary byte sequence. Use for binary data.",
		},
	];

	private readonly fieldModifiers: ProtoCompletionSpec[] = [
		{
			label: "optional",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "modifier",
			documentation:
				"Field may be omitted (proto3 optional, distinct from default zero value).",
		},
		{
			label: "repeated",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "modifier",
			documentation: "Field can be repeated (list). Order is preserved.",
		},
		{
			label: "reserved",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Reserve field numbers or names so they cannot be reused (e.g. `reserved 2, 15, 9 to 11;`).",
		},
		{
			label: "oneof",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"At most one of the fields in the oneof is set. Saves space.",
		},
		{
			label: "map",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Map type. Key must be integer or string (e.g. `map<string, int32> name_to_id = 1;`).",
		},
	];

	private readonly serviceKeywords: ProtoCompletionSpec[] = [
		{
			label: "rpc",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Define an RPC method: `rpc MethodName(Request) returns (Response);` Use `stream` for client/server streaming.",
		},
		{
			label: "option",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Service- or method-level option (e.g. `(google.api.http)` for HTTP mapping).",
		},
	];

	private readonly rpcKeywords: ProtoCompletionSpec[] = [
		{
			label: "stream",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Streaming RPC. Use before request type for client stream, before response for server stream, or both for bidi.",
		},
		{
			label: "returns",
			kind: vscode.CompletionItemKind.Keyword,
			detail: "keyword",
			documentation:
				"Introduces the response type: `returns (ResponseType)` or `returns (stream ResponseType)`.",
		},
	];

	private readonly commonOptions: ProtoCompletionSpec[] = [
		{
			label: "google.api.http",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (google.api.http)",
			documentation: new vscode.MarkdownString(
				'HTTP mapping for this RPC. Fields: `get`, `post`, `put`, `patch`, `delete` (path string), `body` (request field name).\n\nExample:\n`option (google.api.http) = { get: "/v1/resources/{id}"; };`',
			),
			insertText: "(google.api.http) = { $1 };",
			insertTextFormat: 2,
		},
		{
			label: "google.api.method_signature",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (google.api.method_signature)",
			documentation:
				"Declare which request fields are used as method parameters (e.g. for client code generation).",
			insertText: '(google.api.method_signature) = "$1";',
			insertTextFormat: 2,
		},
		{
			label: "google.api.resource",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (google.api.resource)",
			documentation:
				"Marks a message as a resource (type, pattern, name_field, etc.).",
			insertText: '(google.api.resource) = { type: "$1", pattern: "$2" };',
			insertTextFormat: 2,
		},
	];

	private readonly httpOptionFields: ProtoCompletionSpec[] = [
		{
			label: "get",
			kind: vscode.CompletionItemKind.Property,
			detail: "string",
			documentation: 'HTTP GET path template (e.g. `"/v1/things/{id}"`).',
		},
		{
			label: "post",
			kind: vscode.CompletionItemKind.Property,
			detail: "string",
			documentation: "HTTP POST path. Request body is the request message.",
		},
		{
			label: "put",
			kind: vscode.CompletionItemKind.Property,
			detail: "string",
			documentation: "HTTP PUT path.",
		},
		{
			label: "patch",
			kind: vscode.CompletionItemKind.Property,
			detail: "string",
			documentation: "HTTP PATCH path.",
		},
		{
			label: "delete",
			kind: vscode.CompletionItemKind.Property,
			detail: "string",
			documentation: "HTTP DELETE path.",
		},
		{
			label: "body",
			kind: vscode.CompletionItemKind.Property,
			detail: "string",
			documentation:
				'Request field name whose value is the HTTP body (e.g. `"payload"`).',
		},
	];

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<
		vscode.CompletionItem[] | vscode.CompletionList | null | undefined
	> {
		const linePrefix = document
			.lineAt(position)
			.text.substring(0, position.character);
		const context = this.inferContext(document, position);

		const importPathItems = this.getImportPathCompletions(
			document,
			position,
			linePrefix,
		);
		if (importPathItems.length > 0) {
			return new vscode.CompletionList(
				importPathItems,
				importPathItems.length >= IMPORT_COMPLETION_LIMIT,
			);
		}

		const specs = this.getCompletionsForContext(context, linePrefix);
		const items = specs.map((spec) => this.toCompletionItem(spec));
		return new vscode.CompletionList(items, false);
	}

	/**
	 * When the cursor is inside `import "…"`, suggests the import paths of files
	 * the index knows about.
	 *
	 * Each file yields exactly one path, relative to its own module root — the
	 * only root an import path is valid against. The previous implementation
	 * called `findProtoFiles()` and `getProtoPaths()` on every keystroke and then
	 * cross-produced 9,280 files against every root, building a completion item
	 * per pairing before filtering. Here the typed prefix filters plain strings,
	 * and items are built only for the survivors.
	 */
	private getImportPathCompletions(
		document: vscode.TextDocument,
		_position: vscode.Position,
		linePrefix: string,
	): vscode.CompletionItem[] {
		const importMatch = linePrefix.match(
			/import\s*(?:public\s+)?["']([^"']*)$/,
		);
		if (!importMatch) {
			return [];
		}
		const index = this.workspaceIndex();
		if (!index) {
			// No workspace index: there is nothing to suggest from the current file
			// alone, and scanning the workspace per keystroke is the bug being removed.
			return [];
		}

		const pathPrefix = importMatch[1];
		const files = index.files();
		const rootSet = new Set<string>(
			(vscode.workspace.workspaceFolders ?? []).map((f) =>
				path.resolve(f.uri.fsPath),
			),
		);
		for (const file of files) {
			if (file.moduleRoot) {
				rootSet.add(path.resolve(file.moduleRoot));
			}
		}
		const roots = [...rootSet];

		const currentPath = document.uri.fsPath;
		const matches: string[] = [];
		const seen = new Set<string>();
		for (const file of files) {
			if (file.path === currentPath) {
				continue;
			}
			const rel = importPathFor(file, roots);
			if (
				!rel ||
				(pathPrefix && !rel.startsWith(pathPrefix)) ||
				seen.has(rel)
			) {
				continue;
			}
			seen.add(rel);
			matches.push(rel);
		}

		matches.sort((a, b) => a.localeCompare(b));
		return matches.slice(0, IMPORT_COMPLETION_LIMIT).map((rel) => {
			const item = new vscode.CompletionItem(
				rel,
				vscode.CompletionItemKind.File,
			);
			item.detail = "Import path";
			item.documentation = `Import ${rel}`;
			item.insertText = rel;
			return item;
		});
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

	private inferContext(
		document: vscode.TextDocument,
		position: vscode.Position,
	): ProtoContext {
		const text = document.getText(new vscode.Range(0, 0, position.line + 1, 0));
		const lines = text.split("\n");
		let braceDepth = 0;
		const blockAtDepth: ("message" | "service" | "enum")[] = [];
		let pendingBlock: "message" | "service" | "enum" | undefined;
		let inOneof = 0;
		let afterOption = false;
		let inHttpOption = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			if (trimmed.startsWith("//") || trimmed.startsWith("/*")) {
				continue;
			}

			if (/^\s*oneof\s+\w+/.test(line)) {
				inOneof++;
			}

			if (/^\s*(message|extend)\s+\w+/.test(line)) {
				pendingBlock = "message";
			} else if (/^\s*service\s+\w+/.test(line)) {
				pendingBlock = "service";
			} else if (/^\s*enum\s+\w+/.test(line)) {
				pendingBlock = "enum";
			}

			for (const ch of line) {
				if (ch === "{") {
					braceDepth++;
					blockAtDepth[braceDepth] =
						pendingBlock ?? blockAtDepth[braceDepth - 1];
					pendingBlock = undefined;
					if (afterOption && trimmed.includes("google.api.http")) {
						inHttpOption = true;
					}
				} else if (ch === "}") {
					braceDepth--;
					if (inHttpOption && braceDepth >= 0) {
						inHttpOption = false;
					}
				}
			}

			if (/^\s*option\s+/.test(line)) {
				afterOption = trimmed.includes("google.api.http");
			}
		}

		const currentBlock = braceDepth > 0 ? blockAtDepth[braceDepth] : undefined;
		const inMessage = currentBlock === "message";
		const inService = currentBlock === "service";
		const inEnum = currentBlock === "enum";

		const currentLine = lines[lines.length - 1] || "";
		const currentTrimmed = currentLine.trim();
		// inRpc: cursor is on a line that starts an rpc declaration (not an option line)
		const inRpc =
			inService &&
			/rpc\s+\w+/.test(currentTrimmed) &&
			!currentTrimmed.startsWith("option");
		// afterRpcName: current line has 'rpc Name(' but not 'returns('
		const afterRpcName =
			/rpc\s+\w+\s*\(/.test(currentTrimmed) &&
			!/returns\s*\(/.test(currentTrimmed);
		// afterReturns: current line has 'returns('
		const afterReturns = /returns\s*\(/.test(currentTrimmed);

		return {
			atLineStart:
				/^\s*$/.test(currentLine.substring(0, position.character)) ||
				/^\s*\w*$/.test(currentLine.substring(0, position.character)),
			inMessage,
			inService,
			inEnum,
			inOneof: inOneof > 0,
			inRpc,
			afterRpcName,
			afterReturns,
			inHttpOption,
			afterOptionKeyword:
				currentTrimmed.startsWith("option") && !currentTrimmed.includes("="),
			linePrefix: currentLine.substring(0, position.character),
		};
	}

	private getCompletionsForContext(
		ctx: ProtoContext,
		linePrefix: string,
	): ProtoCompletionSpec[] {
		if (
			ctx.inHttpOption &&
			/[{\s](get|post|put|patch|delete|body)?\s*:?\s*$/.test(linePrefix)
		) {
			return this.httpOptionFields;
		}
		if (
			ctx.afterOptionKeyword ||
			linePrefix.trim() === "option" ||
			/option\s+\(?[\w.]*$/.test(linePrefix)
		) {
			return this.commonOptions;
		}
		if (ctx.inService && !ctx.inRpc && ctx.atLineStart) {
			return this.serviceKeywords;
		}
		if (ctx.afterRpcName) {
			return this.rpcKeywords;
		}
		if (ctx.afterReturns) {
			return this.rpcKeywords;
		}
		if (ctx.inMessage || ctx.inOneof) {
			const hasModifier =
				/^\s*(optional|repeated|required|stream)\s+/.test(linePrefix) ||
				/^\s*map\s*</.test(linePrefix);
			if (hasModifier || /^\s*[\w.]*\s+[\w]*\s*=\s*$/.test(linePrefix)) {
				return this.scalarTypes;
			}
			if (/^\s*$/.test(linePrefix.trim()) || /^\s+\w*$/.test(linePrefix)) {
				return [...this.fieldModifiers, ...this.scalarTypes];
			}
		}
		if (ctx.inEnum && ctx.atLineStart) {
			return []; // enum values are user-defined
		}
		if (
			!ctx.inMessage &&
			!ctx.inService &&
			!ctx.inEnum &&
			(ctx.atLineStart || /^\s*\w*$/.test(linePrefix))
		) {
			return this.topLevelKeywords;
		}
		return [];
	}

	private toCompletionItem(spec: ProtoCompletionSpec): vscode.CompletionItem {
		const item = new vscode.CompletionItem(spec.label, spec.kind);
		item.detail = spec.detail;
		item.documentation =
			typeof spec.documentation === "string"
				? new vscode.MarkdownString(spec.documentation)
				: spec.documentation;
		if (spec.insertText) {
			item.insertText = new vscode.SnippetString(spec.insertText);
			// Snippet format (2) so placeholders work; supported at runtime by VS Code
			(item as { insertTextFormat?: number }).insertTextFormat =
				spec.insertTextFormat ?? 2;
		}
		return item;
	}
}

/**
 * The path an indexed file is imported by: its path relative to its module
 * root, or to the deepest known root containing it when it belongs to no
 * module. Returns undefined when no root contains the file.
 */
function importPathFor(
	file: IndexedFile,
	roots: readonly string[],
): string | undefined {
	let chosen = file.moduleRoot ? path.resolve(file.moduleRoot) : undefined;
	if (!chosen) {
		for (const root of roots) {
			if (!file.path.startsWith(`${root}${path.sep}`)) {
				continue;
			}
			if (!chosen || root.length > chosen.length) {
				chosen = root;
			}
		}
	}
	if (!chosen) {
		return undefined;
	}
	const rel = path.relative(chosen, file.path).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		return undefined;
	}
	return rel;
}

interface ProtoContext {
	atLineStart: boolean;
	inMessage: boolean;
	inService: boolean;
	inEnum: boolean;
	inOneof: boolean;
	inRpc: boolean;
	afterRpcName: boolean;
	afterReturns: boolean;
	inHttpOption: boolean;
	afterOptionKeyword: boolean;
	linePrefix: string;
}
