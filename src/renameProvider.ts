import * as path from "node:path";
import * as vscode from "vscode";
import { packageOf, resolveTypeFqn } from "./definitionProvider";
import type { ProtoIndex } from "./index/types";
import {
	collectTypeReferences,
	flattenSymbols,
	type ProtoSymbol,
	parseProtoDocument,
} from "./utils/protoParser";

/**
 * Provides rename for message, service, enum, and rpc names.
 *
 * Cross-file rename is driven exclusively by the **fully-qualified** name the
 * index resolved for the symbol under the cursor, via `referencesTo(fqn)`. The
 * original implementation matched workspace-wide on the *simple* name — the last
 * dot-segment — which is unsafe in any repo that reuses type names across
 * packages: on protobuf-fhir 76.2% of top-level type names are defined in more
 * than one file (`SubjectChoice` in 87 of them), so renaming one `Address`
 * rewrote every `Address` across every FHIR version at once — 155 edits in 154
 * files. Keying on the fqn, `google.fhir.r4.core.Address` and
 * `google.fhir.r5.core.Address` are different types and only one of them moves.
 *
 * When there is no index, or its tier is `onDemand`, or the index cannot be
 * trusted for the file being edited, rename stays scoped to the current file —
 * the emergency-patched behaviour, kept as the floor.
 */
export class ProtoRenameProvider implements vscode.RenameProvider {
	/**
	 * @param index - Symbol index. Optional so the extension can wire providers
	 *   before the index exists; absent means current-file-only rename.
	 */
	constructor(private readonly index?: ProtoIndex) {}

	async provideRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		_token: vscode.CancellationToken,
	): Promise<vscode.WorkspaceEdit | null> {
		const symbol = this.getRenamableSymbolAt(document, position);
		if (!symbol) {
			return null;
		}
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
			return null;
		}

		const index = this.workspaceIndex();
		const fqn = index
			? this.resolveDeclarationFqn(index, document, position, symbol)
			: undefined;
		if (!index || !fqn) {
			return this.currentFileEdits(document, symbol, newName);
		}
		return this.workspaceEdits(index, document, symbol, fqn, newName);
	}

	async prepareRename(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<{ range: vscode.Range; placeholder: string }> {
		const symbol = this.getRenamableSymbolAt(document, position);
		if (!symbol) {
			// Thrown message surfaces in the rename input box.
			throw new Error("This element cannot be renamed.");
		}
		return { range: symbol.selectionRange, placeholder: symbol.name };
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

	/**
	 * The fully-qualified name of the declaration under the cursor, or
	 * `undefined` when the index cannot vouch for it.
	 *
	 * Three conditions must all hold, because a wrong fqn here is exactly the
	 * 154-file failure: the name must resolve, the resolved declaration must live
	 * in *this* file, and it must still carry the same simple name the live
	 * buffer shows. The last check is what catches an index gone stale against an
	 * unsaved edit; any failure drops rename back to current-file-only.
	 */
	private resolveDeclarationFqn(
		index: ProtoIndex,
		document: vscode.TextDocument,
		position: vscode.Position,
		symbol: ProtoSymbol,
	): string | undefined {
		const file = index.fileByPath(document.uri.fsPath);
		if (!file) {
			return undefined;
		}
		const fqn = resolveTypeFqn(index, document, position, symbol.name);
		if (!fqn) {
			return undefined;
		}
		const declaration = index.symbol(fqn);
		if (
			!declaration ||
			declaration.fileId !== file.id ||
			declaration.name !== symbol.name
		) {
			return undefined;
		}
		return fqn;
	}

	/**
	 * Cross-file rename over the references the index resolved to this exact fqn.
	 *
	 * Every edit outside the current file is verified against the live buffer
	 * when one is open, so a stale index can never rewrite an unsaved document.
	 * Files that are not open are taken from the index, whose recorded `typeName`
	 * supplies the replacement text without reading them at all.
	 */
	private workspaceEdits(
		index: ProtoIndex,
		document: vscode.TextDocument,
		symbol: ProtoSymbol,
		fqn: string,
		newName: string,
	): vscode.WorkspaceEdit {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, symbol.selectionRange, newName);

		const currentPath = document.uri.fsPath;
		const currentFileEdits: { range: vscode.Range; newText: string }[] = [];
		let currentFileStale = false;
		const seen = new Set<string>();

		for (const ref of index.referencesTo(fqn)) {
			// The index promises exact resolution; refuse anything else outright.
			if (ref.resolvedFqn !== undefined && ref.resolvedFqn !== fqn) {
				continue;
			}
			const file = index.file(ref.fileId);
			if (!file) {
				continue;
			}
			const range = new vscode.Range(
				ref.line,
				ref.startCol,
				ref.line,
				ref.endCol,
			);
			const key = `${file.path}:${ref.line}:${ref.startCol}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			if (file.path === currentPath) {
				if (!this.textMatches(document.getText(range), ref.typeName)) {
					currentFileStale = true;
					continue;
				}
				if (!range.isEqual(symbol.selectionRange)) {
					currentFileEdits.push({
						range,
						newText: replaceLastSegment(document.getText(range), newName),
					});
				}
				continue;
			}

			const live = liveDocumentFor(file.path);
			const sourceText = live ? live.getText(range) : ref.typeName;
			if (live && !this.textMatches(sourceText, ref.typeName)) {
				throw new Error(
					`Cannot rename "${symbol.name}": ${path.basename(file.path)} has ` +
						"unsaved changes the symbol index has not seen. Save all open " +
						".proto files and try again.",
				);
			}
			edit.replace(
				vscode.Uri.file(file.path),
				range,
				replaceLastSegment(sourceText, newName),
			);
		}

		if (currentFileStale) {
			// Unsaved edits moved this file's references: re-derive them live.
			this.addCurrentFileEdits(edit, document, symbol, newName);
		} else {
			for (const pending of currentFileEdits) {
				edit.replace(document.uri, pending.range, pending.newText);
			}
		}

		return edit;
	}

	/** Whether two written type names denote the same reference text. */
	private textMatches(a: string, b: string): boolean {
		return a.replace(/^\./, "") === b.replace(/^\./, "");
	}

	/** Rename limited to the current file. */
	private currentFileEdits(
		document: vscode.TextDocument,
		symbol: ProtoSymbol,
		newName: string,
	): vscode.WorkspaceEdit {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, symbol.selectionRange, newName);
		this.addCurrentFileEdits(edit, document, symbol, newName);
		return edit;
	}

	/**
	 * Adds this file's own references, matched package-aware against the live
	 * text: a reference belongs to this rename only when it names *this* type,
	 * either unqualified and identical or qualified with this file's own package.
	 * A qualified name from any other package is a different type that merely
	 * shares a simple name.
	 */
	private addCurrentFileEdits(
		edit: vscode.WorkspaceEdit,
		document: vscode.TextDocument,
		symbol: ProtoSymbol,
		newName: string,
	): void {
		const oldName = symbol.name;
		const filePackage = packageOf(document.getText());
		const matchesTarget = (typeName: string): boolean => {
			const bare = typeName.replace(/^\./, "");
			if (bare === oldName) {
				return true;
			}
			return filePackage !== "" && bare === `${filePackage}.${oldName}`;
		};

		for (const ref of collectTypeReferences(document)) {
			if (!matchesTarget(ref.typeName)) {
				continue;
			}
			if (ref.range.isEqual(symbol.selectionRange)) {
				continue;
			}
			// Preserve any package qualification already written at the call site.
			edit.replace(
				document.uri,
				ref.range,
				replaceLastSegment(document.getText(ref.range), newName),
			);
		}
	}

	private getRenamableSymbolAt(
		document: vscode.TextDocument,
		position: vscode.Position,
	): ProtoSymbol | undefined {
		const flat = flattenSymbols(parseProtoDocument(document));
		const symbol = flat.find((s) => s.selectionRange.contains(position));
		if (
			!symbol ||
			(symbol.kind !== "message" &&
				symbol.kind !== "service" &&
				symbol.kind !== "enum" &&
				symbol.kind !== "rpc")
		) {
			return undefined;
		}
		return symbol;
	}
}

/**
 * Replaces the last dot-segment, keeping any qualification already written —
 * `other.pkg.Address` becomes `other.pkg.NewName`, `Address` becomes `NewName`.
 */
function replaceLastSegment(written: string, newName: string): string {
	return written.includes(".")
		? written.slice(0, written.lastIndexOf(".") + 1) + newName
		: newName;
}

/**
 * An already-open document for a path, if VS Code has one.
 *
 * Reads `workspace.textDocuments`, which lists documents that are open anyway.
 * It never opens one: `openTextDocument` retains the document for the rest of
 * the session, and doing that per file is what this rewrite removes.
 */
function liveDocumentFor(fsPath: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(
		(d) => d.uri.scheme === "file" && d.uri.fsPath === fsPath,
	);
}
