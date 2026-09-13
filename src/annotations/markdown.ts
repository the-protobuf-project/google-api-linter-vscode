/**
 * Renders annotation documentation as Markdown.
 *
 * Every line of a card is derived: the target from the extendee, the body from
 * the option's message type, the prose and the example from the leading `//`
 * comment. Nothing is written by hand for any particular annotation, which is
 * why `mcp.v1`, `cache.v1`, `orm.v1` and whatever ships next all render without
 * a code change.
 *
 * Returns plain strings; the providers wrap them in `vscode.MarkdownString`.
 * This module must never import `vscode`.
 */

import type {
	AnnotationDescriptor,
	AnnotationField,
	AnnotationTarget,
} from "../index/types";
import { TARGET_LABELS } from "./extractor";
import type { AnnotationRegistryImpl } from "./registry";

/** Where an annotation was declared, for the "defined in" footer. */
export interface DefinitionSite {
	readonly importPath: string;
	/** Absolute path on disk, when known; makes the footer a link. */
	readonly path?: string;
	/** 0-based line. */
	readonly line: number;
}

/**
 * Formats a field's type, prefixed with `repeated` when it is one.
 * @param field - Option body field
 * @returns Display type
 */
export function fieldType(field: AnnotationField): string {
	return field.repeated ? `repeated ${field.type}` : field.type;
}

/**
 * Human label for a target, e.g. `Method` renders as "rpc".
 * @param target - The extendee-derived target
 * @returns Lowercase label used in hover and completion detail lines
 */
export function targetLabel(target: AnnotationTarget): string {
	return TARGET_LABELS[target];
}

/**
 * One-line summary used as completion `detail`.
 * @param descriptor - The annotation
 * @returns e.g. `rpc option · MCPToolOptions · field 51001`
 */
export function summaryLine(descriptor: AnnotationDescriptor): string {
	const type = descriptor.repeated
		? `repeated ${descriptor.type}`
		: descriptor.type;
	return `${targetLabel(descriptor.target)} option · ${type} · field ${descriptor.number}`;
}

/**
 * Full hover card for an annotation.
 *
 * Name, legal target, body type, field number, documentation, every body field
 * with its own doc, the usage example as a fenced proto block, and the defining
 * file and line.
 *
 * @param descriptor - The annotation to render
 * @param registry - Registry used to resolve the body lazily
 * @param site - Where the annotation was declared
 * @returns Markdown source
 */
export function renderAnnotationCard(
	descriptor: AnnotationDescriptor,
	registry: AnnotationRegistryImpl,
	site?: DefinitionSite,
): string {
	const lines: string[] = [];
	lines.push(`### \`(${descriptor.fqn})\``);
	lines.push(
		`**${targetLabel(descriptor.target)}** option · \`${descriptor.type}\` · field ${descriptor.number}`,
	);
	lines.push("");
	if (descriptor.doc) {
		lines.push(descriptor.doc);
		lines.push("");
	}

	const body = registry.body(descriptor);
	if (body && body.fields.length > 0) {
		lines.push("**Fields**");
		lines.push("");
		for (const field of body.fields) {
			lines.push(
				`- \`${field.name}\` — _${fieldType(field)}_${field.doc ? ` · ${field.doc}` : ""}`,
			);
		}
		lines.push("");
	}

	if (descriptor.example) {
		lines.push("```proto");
		lines.push(descriptor.example);
		lines.push("```");
		lines.push("");
	}

	const footer = renderDefinitionFooter(site, descriptor);
	if (footer) {
		lines.push(footer);
	}
	return lines.join("\n");
}

/**
 * Hover card for one field inside an option body.
 *
 * `(cache.v1.cache) = { ttl: { seconds: 300 } }` hovered on `ttl` renders the
 * doc comment written on `ttl` in the option body message, not on the option.
 *
 * @param descriptor - The annotation whose body contains the field
 * @param path - Field path from the body root
 * @param field - The resolved field
 * @param registry - Registry used to expand a nested message type
 * @returns Markdown source
 */
export function renderFieldCard(
	descriptor: AnnotationDescriptor,
	path: readonly string[],
	field: AnnotationField,
	registry: AnnotationRegistryImpl,
): string {
	const lines: string[] = [];
	lines.push(`### \`${path.join(".")}\``);
	lines.push(
		`\`${fieldType(field)}\` · field ${field.number} · in \`(${descriptor.fqn})\``,
	);
	lines.push("");
	if (field.doc) {
		lines.push(field.doc);
		lines.push("");
	}

	const nested = field.messageFqn
		? registry.bodyOf(field.messageFqn)
		: undefined;
	if (nested && nested.fields.length > 0) {
		lines.push(`**\`${nested.fqn}\` fields**`);
		lines.push("");
		for (const child of nested.fields) {
			lines.push(
				`- \`${child.name}\` — _${fieldType(child)}_${child.doc ? ` · ${child.doc}` : ""}`,
			);
		}
		lines.push("");
	}

	const values = field.messageFqn
		? undefined
		: registry.enumValues(
				registry.resolveEnumFqn(field.type, descriptor.namespace) ?? "",
			);
	if (values && values.length > 0) {
		lines.push(`**Values** ${values.map((v) => `\`${v}\``).join(", ")}`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Card shown on an extension field inside an `extend google.protobuf.*Options`
 * block — the annotation's own declaration site.
 * @param descriptor - The annotation declared there
 * @param registry - Registry used to resolve the body
 * @returns Markdown source
 */
export function renderDeclarationCard(
	descriptor: AnnotationDescriptor,
	registry: AnnotationRegistryImpl,
): string {
	const card = renderAnnotationCard(descriptor, registry);
	return `${card}\n_Used as_ \`option (${descriptor.fqn}) = …;\` on a ${targetLabel(descriptor.target)}.`;
}

/**
 * "Defined in" footer, as a clickable link when the absolute path is known.
 * @param site - Declaration site
 * @param descriptor - Fallback source of the import path and line
 * @returns Markdown line, or empty when nothing is known
 */
function renderDefinitionFooter(
	site: DefinitionSite | undefined,
	descriptor: AnnotationDescriptor,
): string {
	const importPath = site?.importPath ?? descriptor.importPath;
	const line = (site?.line ?? descriptor.line) + 1;
	if (!importPath) {
		return "";
	}
	if (site?.path) {
		const uri = `file://${encodeURI(site.path.split("\\").join("/"))}#L${line}`;
		return `_Defined in_ [\`${importPath}:${line}\`](${uri})`;
	}
	return `_Defined in_ \`${importPath}:${line}\``;
}
