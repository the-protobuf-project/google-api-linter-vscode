import * as path from "node:path";
import * as vscode from "vscode";
import type {
	IndexedFile,
	IndexedSymbol,
	SymbolKind as IndexedSymbolKind,
	ProtoIndex,
} from "./index/types";
import { isProtoFile } from "./utils/fileUtils";
import {
	flattenSymbols,
	type ProtoSymbol,
	parseProtoDocument,
} from "./utils/protoParser";

/**
 * Cap on the symbols returned for a single query.
 *
 * Go to Symbol in Workspace re-queries on every keystroke and its picker never
 * shows more than a screenful. The previous implementation opened all 9,280
 * workspace documents per keystroke and returned every match; the index answers
 * from memory, and the cap keeps a one-character query from materialising tens
 * of thousands of `SymbolInformation` objects.
 */
const MAX_RESULTS = 500;

const kindMap: Record<ProtoSymbol["kind"], vscode.SymbolKind> = {
	message: vscode.SymbolKind.Class,
	service: vscode.SymbolKind.Interface,
	enum: vscode.SymbolKind.Enum,
	rpc: vscode.SymbolKind.Method,
	field: vscode.SymbolKind.Field,
	enumValue: vscode.SymbolKind.Constant,
};

const indexedKindMap: Record<IndexedSymbolKind, vscode.SymbolKind> = {
	message: vscode.SymbolKind.Class,
	service: vscode.SymbolKind.Interface,
	enum: vscode.SymbolKind.Enum,
	rpc: vscode.SymbolKind.Method,
	field: vscode.SymbolKind.Field,
	enumValue: vscode.SymbolKind.Constant,
	extend: vscode.SymbolKind.Class,
};

/**
 * Provides workspace-wide symbol search (Go to Symbol in Workspace) for messages, services, enums, rpcs.
 *
 * Backed entirely by the symbol index. Without an index — or in the `onDemand`
 * tier, where no workspace index exists — the provider degrades to the active
 * editor's own symbols. It never walks the workspace opening documents: VS Code
 * retains every document opened through `openTextDocument` for the life of the
 * session, which is what grew the host to ~60 GB on a 9,280-file repo.
 */
export class ProtoWorkspaceSymbolProvider
	implements vscode.WorkspaceSymbolProvider
{
	/**
	 * @param index - Symbol index. Optional so the extension can wire providers
	 *   before the index exists; absent means current-file-only results.
	 */
	constructor(private readonly index?: ProtoIndex) {}

	async provideWorkspaceSymbols(
		query: string,
		token: vscode.CancellationToken,
	): Promise<vscode.SymbolInformation[]> {
		const index = this.workspaceIndex();
		if (!index) {
			return this.activeDocumentSymbols(query);
		}

		const results: vscode.SymbolInformation[] = [];
		for (const symbol of index.searchSymbols(query, MAX_RESULTS)) {
			if (token.isCancellationRequested) {
				break;
			}
			const file = index.file(symbol.fileId);
			if (!file) {
				continue;
			}
			results.push(this.toSymbolInformation(symbol, file));
		}
		return results;
	}

	/**
	 * The index only answers workspace questions when it actually holds one.
	 * `onDemand` is the tier that means "no workspace index", so callers must
	 * degrade rather than reach for a workspace scan.
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

	private toSymbolInformation(
		symbol: IndexedSymbol,
		file: IndexedFile,
	): vscode.SymbolInformation {
		const container =
			symbol.parentFqn ??
			(file.packageName || path.basename(file.path, ".proto"));
		return new vscode.SymbolInformation(
			symbol.name,
			indexedKindMap[symbol.kind] ?? vscode.SymbolKind.Class,
			container,
			new vscode.Location(
				vscode.Uri.file(file.path),
				new vscode.Range(
					symbol.line,
					symbol.startCol,
					symbol.line,
					symbol.endCol,
				),
			),
		);
	}

	/**
	 * Degraded mode: symbols of the document already open in the active editor.
	 * That document is already resident, so this costs no retained memory.
	 */
	private activeDocumentSymbols(query: string): vscode.SymbolInformation[] {
		const document = vscode.window.activeTextEditor?.document;
		if (!document || !isProtoFile(document.fileName)) {
			return [];
		}

		const q = query.toLowerCase();
		const containerName = path.basename(document.uri.fsPath, ".proto");
		const results: vscode.SymbolInformation[] = [];
		for (const s of flattenSymbols(parseProtoDocument(document))) {
			if (q && !s.name.toLowerCase().includes(q)) {
				continue;
			}
			results.push(
				new vscode.SymbolInformation(
					s.name,
					kindMap[s.kind],
					s.detail ?? containerName,
					new vscode.Location(document.uri, s.selectionRange),
				),
			);
			if (results.length >= MAX_RESULTS) {
				break;
			}
		}
		return results;
	}
}
