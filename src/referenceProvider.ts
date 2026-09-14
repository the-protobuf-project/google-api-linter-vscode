import * as vscode from "vscode";
import { packageOf, resolveTypeFqn } from "./definitionProvider";
import type { ProtoIndex } from "./index/types";
import {
	collectTypeReferences,
	flattenSymbols,
	parseProtoDocument,
} from "./utils/protoParser";

/** A possibly package-qualified type name, e.g. `Foo` or `google.protobuf.Any`. */
const RE_QUALIFIED_NAME =
	/\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;

/**
 * Provides find references (Where is this type used?) for message, enum, service names.
 *
 * References are matched by **fully-qualified** name through the index. The
 * previous implementation opened every workspace file plus everything under the
 * import roots — the whole googleapis and protobuf/src trees — on each request,
 * and then matched on the simple name, so asking for uses of `Address` returned
 * every `Address` in every package and version in the repo.
 *
 * Without an index, or in the `onDemand` tier, results are limited to the
 * current file. There is no workspace-scan fallback: that scan is the bug.
 */
export class ProtoReferenceProvider implements vscode.ReferenceProvider {
	/**
	 * @param index - Symbol index. Optional so the extension can wire providers
	 *   before the index exists; absent means current-file-only results.
	 */
	constructor(private readonly index?: ProtoIndex) {}

	async provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[] | null> {
		const wordRange = document.getWordRangeAtPosition(
			position,
			RE_QUALIFIED_NAME,
		);
		const written = wordRange ? document.getText(wordRange) : "";
		if (!written) {
			return null;
		}

		const index = this.workspaceIndex();
		const fqn = index
			? resolveTypeFqn(index, document, position, written)
			: undefined;
		if (!index || !fqn) {
			return this.currentFileReferences(document, position, context, written);
		}

		const locations: vscode.Location[] = [];
		const seen = new Set<string>();
		const push = (uri: vscode.Uri, range: vscode.Range) => {
			const key = `${uri.fsPath}:${range.start.line}:${range.start.character}`;
			if (!seen.has(key)) {
				seen.add(key);
				locations.push(new vscode.Location(uri, range));
			}
		};

		if (context.includeDeclaration) {
			const declaration = index.symbol(fqn);
			const file = declaration ? index.file(declaration.fileId) : undefined;
			if (declaration && file) {
				push(
					vscode.Uri.file(file.path),
					new vscode.Range(
						declaration.line,
						declaration.startCol,
						declaration.line,
						declaration.endCol,
					),
				);
			}
		}

		for (const ref of index.referencesTo(fqn)) {
			if (token.isCancellationRequested) {
				break;
			}
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
			if (file.path === document.uri.fsPath && range.contains(position)) {
				continue;
			}
			push(vscode.Uri.file(file.path), range);
		}

		return locations.length ? locations : null;
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
	 * Degraded mode: uses within the current file only, matched package-aware.
	 *
	 * A reference belongs to the target only when it names *this* type: either
	 * unqualified and identical, or qualified with this file's own package.
	 */
	private currentFileReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		written: string,
	): vscode.Location[] | null {
		const flat = flattenSymbols(parseProtoDocument(document));
		const symbolAtPosition = flat.find((s) =>
			s.selectionRange.contains(position),
		);
		const targetName =
			symbolAtPosition?.name ?? written.split(".").pop() ?? written;
		const filePackage = packageOf(document.getText());

		const matchesTarget = (typeName: string): boolean => {
			const bare = typeName.replace(/^\./, "");
			if (bare === targetName) {
				return true;
			}
			return filePackage !== "" && bare === `${filePackage}.${targetName}`;
		};

		const locations: vscode.Location[] = [];
		if (context.includeDeclaration) {
			for (const s of flat) {
				if (s.kind !== "rpc" && s.name === targetName) {
					locations.push(new vscode.Location(document.uri, s.selectionRange));
				}
			}
		}
		for (const ref of collectTypeReferences(document)) {
			if (!matchesTarget(ref.typeName) || ref.range.contains(position)) {
				continue;
			}
			locations.push(new vscode.Location(document.uri, ref.range));
		}

		return locations.length ? locations : null;
	}
}
