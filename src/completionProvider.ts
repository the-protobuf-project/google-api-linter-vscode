import * as path from "node:path";
import * as vscode from "vscode";
import { getProtoPaths } from "./utils/configReader";
import { findProtoFiles } from "./utils/fileUtils";

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
 * Provides completions with type hints for Protocol Buffers:
 * messages, services, RPC, field types, options (e.g. google.api.http), and keywords.
 */
export class ProtoCompletionProvider implements vscode.CompletionItemProvider {
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
		// MCP (grpc-mcp-gateway) options – https://github.com/the-protobuf-project/grpc-mcp-gateway
		{
			label: "mcp.protobuf.service",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (mcp.protobuf.service)",
			documentation: new vscode.MarkdownString(
				"**MCP service option.** App metadata (name, version, description) for the MCP server.\n\n`app: { name, version, description }`",
			),
			insertText:
				'(mcp.protobuf.service) = { app: { name: "$1", version: "$2", description: "$3" } };',
			insertTextFormat: 2,
		},
		{
			label: "mcp.protobuf.tool",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (mcp.protobuf.tool)",
			documentation:
				"MCP tool option: override auto-generated tool name or description on an RPC.",
			insertText: '(mcp.protobuf.tool) = { description: "$1" };',
			insertTextFormat: 2,
		},
		{
			label: "mcp.protobuf.prompt",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (mcp.protobuf.prompt)",
			documentation:
				"MCP prompt template on RPC. `name`, `description`, `schema` (proto message for prompt args).",
			insertText:
				'(mcp.protobuf.prompt) = { name: "$1", description: "$2", schema: "$3" };',
			insertTextFormat: 2,
		},
		{
			label: "mcp.protobuf.elicitation",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (mcp.protobuf.elicitation)",
			documentation:
				"MCP confirmation dialog before RPC runs. `message`, `schema` (proto for confirmation).",
			insertText:
				'(mcp.protobuf.elicitation) = { message: "$1", schema: "$2" };',
			insertTextFormat: 2,
		},
		{
			label: "mcp.protobuf.field",
			kind: vscode.CompletionItemKind.Property,
			detail: "(mcp.protobuf.field)",
			documentation:
				"MCP field option: JSON Schema metadata (description, examples, format) for tool inputSchema.",
			insertText:
				'(mcp.protobuf.field) = { description: "$1", examples: "$2", format: "$3" }',
			insertTextFormat: 2,
		},
		{
			label: "mcp.protobuf.enum",
			kind: vscode.CompletionItemKind.Property,
			detail: "option (mcp.protobuf.enum)",
			documentation: "MCP enum-level description.",
			insertText: '(mcp.protobuf.enum) = { description: "$1" };',
			insertTextFormat: 2,
		},
		{
			label: "mcp.protobuf.enum_value",
			kind: vscode.CompletionItemKind.Property,
			detail: "(mcp.protobuf.enum_value)",
			documentation: "MCP description on an enum value.",
			insertText: '(mcp.protobuf.enum_value) = { description: "$1" }',
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

		const importPathItems = await this.getImportPathCompletions(
			document,
			position,
			linePrefix,
		);
		if (importPathItems.length > 0) {
			return new vscode.CompletionList(importPathItems, false);
		}

		const specs = this.getCompletionsForContext(context, linePrefix);
		const items = specs.map((spec) => this.toCompletionItem(spec));
		return new vscode.CompletionList(items, false);
	}

	/** When cursor is inside import "...", suggest .proto paths from workspace and configured proto_paths. */
	private async getImportPathCompletions(
		document: vscode.TextDocument,
		_position: vscode.Position,
		linePrefix: string,
	): Promise<vscode.CompletionItem[]> {
		const importMatch = linePrefix.match(
			/import\s*(?:public\s+)?["']([^"']*)$/,
		);
		if (!importMatch) {
			return [];
		}

		const pathPrefix = importMatch[1];
		const docDir = path.dirname(document.uri.fsPath);
		const protoUris = await findProtoFiles();
		const protoPathDirs = await getProtoPaths();
		const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
			(f) => f.uri.fsPath,
		);
		const allRoots = [
			...new Set([docDir, ...protoPathDirs, ...workspaceRoots]),
		];

		const pathToLabel = new Map<string, string>();
		for (const uri of protoUris) {
			const fsPath = uri.fsPath;
			for (const root of allRoots) {
				if (!fsPath.startsWith(root)) {
					continue;
				}
				const rel = path.relative(root, fsPath).replace(/\\/g, "/");
				if (rel.startsWith("..")) {
					continue;
				}
				if (!rel.endsWith(".proto")) {
					continue;
				}
				const existing = pathToLabel.get(rel);
				if (existing === undefined || rel.length < existing.length) {
					pathToLabel.set(rel, rel);
				}
			}
		}

		const items: vscode.CompletionItem[] = [];
		for (const rel of pathToLabel.keys()) {
			if (pathPrefix && !rel.startsWith(pathPrefix)) {
				continue;
			}
			const item = new vscode.CompletionItem(
				rel,
				vscode.CompletionItemKind.File,
			);
			item.detail = "Import path";
			item.documentation = `Import ${rel}`;
			item.insertText = rel;
			items.push(item);
		}
		return items.sort((a, b) =>
			(a.insertText as string).localeCompare(b.insertText as string),
		);
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
