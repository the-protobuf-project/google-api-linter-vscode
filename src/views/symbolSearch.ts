/**
 * Symbol search for the Structure view.
 *
 * A `TreeView` has no API for a persistent search box — only the built-in
 * type-ahead, which matches visible rows and cannot reach a symbol inside a
 * collapsed section. A `QuickPick` over the index finds anything the workspace
 * declares, is keyboard-native, and costs no pixels in a 300px rail.
 *
 * Nothing here opens a `TextDocument`: every row comes from the in-memory
 * index, and only the row the user picks is ever read from disk.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { IndexedSymbol, ProtoIndex, SymbolKind } from "../index/types";

/**
 * Rows offered at once.
 *
 * `QuickPick` filters client-side, so every row is a live DOM node. A cap keeps
 * the first keystroke in a 9,000-file workspace from building a list nobody
 * will scroll to the end of; typing narrows it long before the cap bites.
 */
const MAX_RESULTS = 500;

/** Codicon per symbol kind, matching the glyphs the tree already uses. */
const KIND_ICON: Record<string, string> = {
	service: "symbol-interface",
	rpc: "symbol-method",
	message: "symbol-class",
	enum: "symbol-enum",
	field: "symbol-field",
	enumValue: "symbol-enum-member",
};

/** How kinds sort: the things an API review looks for come first. */
const KIND_RANK: Record<string, number> = {
	service: 0,
	rpc: 1,
	message: 2,
	enum: 3,
	field: 4,
};

/** One row of the picker, carrying the symbol it stands for. */
interface SymbolPick extends vscode.QuickPickItem {
	readonly symbol: IndexedSymbol;
}

/**
 * Builds one picker row.
 *
 * The bare name is the label so filtering matches what the user typed, with the
 * package and file as detail — a fully-qualified label would make every row in
 * a package share a long prefix and defeat the fuzzy match.
 */
function toPick(index: ProtoIndex, symbol: IndexedSymbol): SymbolPick {
	const file = index.file(symbol.fileId);
	const icon = KIND_ICON[symbol.kind] ?? "symbol-misc";
	const where = file
		? `${path.basename(file.path)}:${symbol.line + 1}`
		: `line ${symbol.line + 1}`;

	return {
		label: `$(${icon}) ${symbol.name}`,
		description: symbol.detail ?? file?.packageName,
		detail: symbol.doc ? `${where} — ${symbol.doc}` : where,
		symbol,
	};
}

/** Services before RPCs before messages, then alphabetically. */
function compare(a: IndexedSymbol, b: IndexedSymbol): number {
	const rank = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
	return rank !== 0 ? rank : a.name.localeCompare(b.name);
}

/**
 * Opens the symbol picker and reveals whatever the user chooses.
 *
 * @param index - The workspace index, or `undefined` when there is none
 * @param kinds - Restrict to these kinds; all kinds when omitted
 */
export async function searchSymbols(
	index: ProtoIndex | undefined,
	kinds?: readonly SymbolKind[],
): Promise<void> {
	if (!index || index.stats().tier === "onDemand") {
		const reason = index?.stats().degradeReason;
		void vscode.window.showInformationMessage(
			reason
				? `Symbol search needs the workspace index: ${reason}`
				: "Symbol search needs the workspace index, which is not available.",
		);
		return;
	}

	const picker = vscode.window.createQuickPick<SymbolPick>();
	picker.placeholder = "Search services, RPCs, messages and enums…";
	picker.matchOnDescription = true;
	picker.matchOnDetail = false;
	picker.busy = true;
	picker.show();

	const wanted = kinds ? new Set<string>(kinds) : undefined;

	/** Re-queries the index for a term. Empty shows a ranked sample. */
	const refresh = (query: string): void => {
		// `searchSymbols` is a substring match on the bare name, so it is the
		// index's own filter rather than a second one layered on top.
		const found = index
			.searchSymbols(query, MAX_RESULTS)
			.filter((symbol) => !wanted || wanted.has(symbol.kind));
		const sorted = [...found].sort(compare);
		picker.items = sorted.map((symbol) => toPick(index, symbol));
		picker.title =
			sorted.length >= MAX_RESULTS
				? `Showing the first ${MAX_RESULTS} matches — keep typing to narrow`
				: `${sorted.length} symbol(s)`;
	};

	refresh("");
	picker.busy = false;

	picker.onDidChangeValue(refresh);

	picker.onDidAccept(async () => {
		const chosen = picker.selectedItems[0];
		picker.hide();
		if (!chosen) {
			return;
		}
		const file = index.file(chosen.symbol.fileId);
		if (!file) {
			return;
		}
		// One document, for the one symbol the user picked. Never in a loop.
		const document = await vscode.workspace.openTextDocument(
			vscode.Uri.file(file.path),
		);
		const position = new vscode.Position(
			chosen.symbol.line,
			chosen.symbol.startCol,
		);
		const editor = await vscode.window.showTextDocument(document, {
			selection: new vscode.Range(position, position),
			preview: false,
		});
		editor.revealRange(
			new vscode.Range(position, position),
			vscode.TextEditorRevealType.InCenter,
		);
	});

	picker.onDidHide(() => picker.dispose());
}
