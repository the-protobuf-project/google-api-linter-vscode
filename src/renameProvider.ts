import * as vscode from "vscode";
import {
	collectTypeReferences,
	flattenSymbols,
	parseProtoDocument,
} from "./utils/protoParser";

const RE_PACKAGE = /^package\s+([A-Za-z0-9_.]+)\s*;/m;

/**
 * Provides rename for message, service, enum, and rpc names.
 *
 * Scope is deliberately limited to the current file. The previous implementation
 * matched symbols workspace-wide on their *simple* name (the last dot-segment),
 * which is unsafe in any repo that reuses type names across packages: on
 * protobuf-fhir 76% of top-level type names are defined in more than one file
 * (`SubjectChoice` in 87 of them), so renaming one `Address` rewrote every
 * `Address` across every FHIR version at once.
 *
 * Cross-file rename returns once the symbol index resolves fully-qualified names
 * (file package + import resolution) instead of simple names.
 */
export class ProtoRenameProvider implements vscode.RenameProvider {
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

		const oldName = symbol.name;
		const filePackage = document.getText().match(RE_PACKAGE)?.[1] ?? "";

		/**
		 * A reference belongs to this rename only when it names *this* type:
		 * either unqualified and identical, or qualified with this file's own
		 * package. A qualified name from any other package is a different type
		 * that merely shares a simple name.
		 */
		const matchesTarget = (typeName: string): boolean => {
			const bare = typeName.replace(/^\./, "");
			if (bare === oldName) {
				return true;
			}
			return filePackage !== "" && bare === `${filePackage}.${oldName}`;
		};

		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, symbol.selectionRange, newName);

		for (const ref of collectTypeReferences(document)) {
			if (!matchesTarget(ref.typeName)) {
				continue;
			}
			if (ref.range.isEqual(symbol.selectionRange)) {
				continue;
			}
			// Preserve any package qualification already written at the call site.
			const text = document.getText(ref.range);
			const newText = text.includes(".")
				? text.slice(0, text.lastIndexOf(".") + 1) + newName
				: newName;
			edit.replace(document.uri, ref.range, newText);
		}

		return edit;
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

	private getRenamableSymbolAt(
		document: vscode.TextDocument,
		position: vscode.Position,
	) {
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
