/**
 * Hover documentation for custom options.
 *
 * Two different cards, chosen by what the cursor is actually on:
 *
 * - the option name in `option (cache.v1.cache) = {...}` gets the annotation
 *   card — target, body type, field number, prose, every body field, the usage
 *   example and the defining file;
 * - a field *inside* the body — the `ttl` in `{ ttl: { seconds: 300 } }` — gets
 *   that field's own card, resolved through the body message, nesting included.
 *
 * Every line comes from the `extend` block and the option body message. There
 * is no table of known annotations here and there must never be one: that is
 * how the extension ended up documenting `mcp.protobuf.*` two generations after
 * the namespace became `mcp.v1`.
 */

import * as vscode from "vscode";
import {
	renderAnnotationCard,
	renderDeclarationCard,
	renderFieldCard,
} from "./markdown";
import {
	type AnnotationSource,
	analyzeCached,
	definitionSite,
	resolveDescriptor,
} from "./resolve";

/**
 * Builds a hover from Markdown produced by the card renderers.
 * @param markdown - Markdown source
 * @param range - Range the hover highlights
 * @returns The hover
 */
function toHover(markdown: string, range: vscode.Range): vscode.Hover {
	const value = new vscode.MarkdownString(markdown);
	// Deliberately untrusted. The card embeds doc comments and examples read
	// out of workspace `.proto` files, which are attacker-controlled the moment
	// someone opens a repository they did not write. Trusted markdown activates
	// `command:` links, so a comment containing one would become a live
	// command the reader could click. Nothing here needs it: the footer links
	// with `file://`, which renders untrusted.
	value.supportHtml = false;
	return new vscode.Hover(value, range);
}

/** Hover provider for annotation names and option-body fields. */
export class AnnotationHoverProvider implements vscode.HoverProvider {
	constructor(private readonly source: AnnotationSource) {}

	/**
	 * Documents whatever annotation construct is under the cursor.
	 * @param document - The buffer
	 * @param position - Cursor position
	 * @param token - Cancellation token supplied by VS Code
	 * @returns A hover, or undefined when the cursor is not on an annotation
	 */
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): vscode.Hover | undefined {
		const registry = this.source.registry();
		if (!registry || token.isCancellationRequested) {
			return undefined;
		}
		const model = analyzeCached(
			document.uri.toString(),
			document.version,
			document.getText(),
		);
		const offset = document.offsetAt(position);
		const range = (start: number, end: number): vscode.Range =>
			new vscode.Range(document.positionAt(start), document.positionAt(end));

		// Body fields are nested inside option references, so they are tested
		// first: on `ttl` both regions would match, and the field is the answer.
		for (const field of model.bodyFields) {
			if (offset < field.start || offset > field.end) {
				continue;
			}
			const descriptor = resolveDescriptor(
				registry,
				field.optionFqn,
				model.packageName,
			);
			if (!descriptor) {
				return undefined;
			}
			const resolved = registry.fieldAt(descriptor, field.path);
			if (!resolved) {
				return undefined;
			}
			return toHover(
				renderFieldCard(descriptor, field.path, resolved, registry),
				range(field.start, field.end),
			);
		}

		for (const reference of model.options) {
			if (offset < reference.nameStart || offset > reference.nameEnd) {
				continue;
			}
			const descriptor = resolveDescriptor(
				registry,
				reference.fqn,
				model.packageName,
			);
			if (!descriptor) {
				return undefined;
			}
			return toHover(
				renderAnnotationCard(
					descriptor,
					registry,
					definitionSite(registry, descriptor),
				),
				range(reference.nameStart, reference.nameEnd),
			);
		}

		// The declaration site itself: `optional CacheOptions cache = 51001;`
		// inside `extend google.protobuf.MessageOptions`.
		for (const declaration of model.declarations) {
			if (offset < declaration.start || offset > declaration.end) {
				continue;
			}
			const descriptor = resolveDescriptor(
				registry,
				declaration.name,
				model.packageName,
			);
			if (!descriptor) {
				return undefined;
			}
			return toHover(
				renderDeclarationCard(descriptor, registry),
				range(declaration.start, declaration.end),
			);
		}

		return undefined;
	}
}
