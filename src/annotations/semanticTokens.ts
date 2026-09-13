/**
 * Semantic highlighting for custom options.
 *
 * A TextMate grammar is a static file. It cannot know what the workspace
 * declares, which is why `syntaxes/proto3.tmLanguage.json` hardcodes a
 * `google\.(api|protobuf)` regex and leaves every other namespace — `mcp.v1`,
 * `cache.v1`, `entity.v1`, `orm.v1` and the rest — unhighlighted. Semantic
 * tokens are computed at request time against the live registry, so they cover
 * whatever the index found, with no grammar change and no list to maintain.
 *
 * Highlighting also carries information the grammar cannot: an option that does
 * not resolve — misspelled, or declared in a file this one never imports — gets
 * a different token type from one that does, so the mistake is visible before
 * the first `buf build`.
 *
 * Token types are contributed by the extension rather than being standard, so
 * `package.json` must declare them under `contributes.semanticTokenTypes` along
 * with `contributes.semanticTokenScopes` fallbacks; see `support.ts`.
 */

import * as vscode from "vscode";
import type { ProtoDocumentModel } from "./document";
import type { AnnotationRegistryImpl } from "./registry";
import {
	type AnnotationSource,
	analyzeCached,
	importClosure,
	resolveDescriptor,
} from "./resolve";

/**
 * Token types this provider emits.
 *
 * `protoAnnotation` and `protoAnnotationField` mark names that resolved.
 * The `Unknown` pair marks names that did not, and is deliberately mapped to
 * `invalid.illegal` so every theme renders it as a mistake.
 */
export const ANNOTATION_TOKEN_TYPES = [
	"protoAnnotation",
	"protoAnnotationNamespace",
	"protoAnnotationField",
	"protoAnnotationUnknown",
	"protoAnnotationFieldUnknown",
] as const;

/** Standard modifiers this provider uses. Neither needs contributing. */
export const ANNOTATION_TOKEN_MODIFIERS = [
	"declaration",
	"deprecated",
] as const;

/** Legend the provider must be registered with. */
export const ANNOTATION_SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
	[...ANNOTATION_TOKEN_TYPES],
	[...ANNOTATION_TOKEN_MODIFIERS],
);

type TokenType = (typeof ANNOTATION_TOKEN_TYPES)[number];

/** A token before it is sorted into document order. */
interface PendingToken {
	readonly start: number;
	readonly end: number;
	readonly type: TokenType;
	readonly modifiers: string[];
}

/**
 * Reads "deprecated" out of the annotation's own doc comment rather than from a
 * list, keeping the self-describing rule intact.
 * @param doc - Leading comment text, already stripped of markers
 * @returns True when the comment announces a deprecation
 */
function isDeprecated(doc: string | undefined): boolean {
	if (!doc) {
		return false;
	}
	const head = doc.slice(0, 240).toLowerCase();
	return head.includes("deprecated");
}

/**
 * Semantic tokens for annotation names and option-body field names.
 */
export class AnnotationSemanticTokensProvider
	implements vscode.DocumentSemanticTokensProvider, vscode.Disposable
{
	private readonly changed = new vscode.EventEmitter<void>();

	/** Fires when the index rebuilds, so VS Code re-requests tokens. */
	readonly onDidChangeSemanticTokens = this.changed.event;

	constructor(private readonly source: AnnotationSource) {}

	/**
	 * Invalidates every buffer's tokens.
	 *
	 * Called after an index build: an annotation that was unknown a second ago
	 * may now resolve, and nothing in the buffer changed to trigger a refresh.
	 */
	refresh(): void {
		this.changed.fire();
	}

	/** Releases the change emitter. */
	dispose(): void {
		this.changed.dispose();
	}

	/**
	 * Produces tokens for one buffer.
	 * @param document - The buffer to highlight
	 * @param token - Cancellation token supplied by VS Code
	 * @returns The encoded tokens, or undefined when no registry exists yet
	 */
	provideDocumentSemanticTokens(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): vscode.SemanticTokens | undefined {
		const registry = this.source.registry();
		if (!registry || token.isCancellationRequested) {
			return undefined;
		}
		const model = analyzeCached(
			document.uri.toString(),
			document.version,
			document.getText(),
		);
		const pending = this.collect(model, registry);
		if (token.isCancellationRequested) {
			return undefined;
		}

		// The encoding is delta-based, so tokens must be emitted in document
		// order regardless of the order the scanner found them in.
		pending.sort((a, b) => a.start - b.start || a.end - b.end);

		const builder = new vscode.SemanticTokensBuilder(
			ANNOTATION_SEMANTIC_LEGEND,
		);
		for (const item of pending) {
			if (item.end <= item.start) {
				continue;
			}
			const start = document.positionAt(item.start);
			const end = document.positionAt(item.end);
			if (start.line !== end.line) {
				continue;
			}
			builder.push(new vscode.Range(start, end), item.type, item.modifiers);
		}
		return builder.build();
	}

	/**
	 * Classifies every annotation name in the buffer.
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @returns Unsorted tokens
	 */
	private collect(
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
	): PendingToken[] {
		const out: PendingToken[] = [];
		const closure = importClosure(
			registry,
			model.imports.map((entry) => entry.path),
		);

		for (const reference of model.options) {
			const descriptor = resolveDescriptor(
				registry,
				reference.fqn,
				model.packageName,
			);
			// A declaration this file makes itself is always in scope; anything else
			// must be reachable through the import closure or protoc will reject it.
			const visible =
				descriptor !== undefined &&
				(!closure.complete ||
					descriptor.importPath === "" ||
					closure.paths.has(descriptor.importPath) ||
					this.declaredHere(model, descriptor.name));
			if (!descriptor || !visible) {
				out.push({
					start: reference.nameStart,
					end: reference.nameEnd,
					type: "protoAnnotationUnknown",
					modifiers: [],
				});
				continue;
			}
			const modifiers = isDeprecated(descriptor.doc) ? ["deprecated"] : [];
			const leafStart = reference.nameEnd - descriptor.name.length;
			if (leafStart > reference.nameStart + 1) {
				out.push({
					start: reference.nameStart,
					end: leafStart - 1,
					type: "protoAnnotationNamespace",
					modifiers,
				});
			}
			out.push({
				start: Math.max(leafStart, reference.nameStart),
				end: reference.nameEnd,
				type: "protoAnnotation",
				modifiers,
			});
		}

		for (const field of model.bodyFields) {
			const descriptor = resolveDescriptor(
				registry,
				field.optionFqn,
				model.packageName,
			);
			const resolved = descriptor
				? registry.fieldAt(descriptor, field.path)
				: undefined;
			out.push({
				start: field.start,
				end: field.end,
				type: resolved ? "protoAnnotationField" : "protoAnnotationFieldUnknown",
				modifiers: resolved && isDeprecated(resolved.doc) ? ["deprecated"] : [],
			});
		}

		// The `extend google.protobuf.*Options` block in this very file: the
		// declaration site of an annotation reads as an annotation too.
		for (const declaration of model.declarations) {
			if (!declaration.target) {
				continue;
			}
			out.push({
				start: declaration.start,
				end: declaration.end,
				type: "protoAnnotation",
				modifiers: ["declaration"],
			});
		}

		return out;
	}

	/**
	 * Whether the buffer declares an extension of this name itself.
	 * @param model - Structural model of the buffer
	 * @param name - Bare annotation name
	 * @returns True when the file's own `extend` block declares it
	 */
	private declaredHere(model: ProtoDocumentModel, name: string): boolean {
		return model.declarations.some((declaration) => declaration.name === name);
	}
}
