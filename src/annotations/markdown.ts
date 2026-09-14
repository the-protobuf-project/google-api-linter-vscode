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
import type { RawEnumValue } from "./extractor";
import { TARGET_LABELS } from "./extractor";
import type { AnnotationRegistryImpl } from "./registry";
import type { ValueSite } from "./resolve";

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

/** Enum values rendered inline before the list is elided. */
const MAX_INLINE_ENUM_VALUES = 10;

/**
 * The namespace a field's type name resolves against: the package of the
 * message that declares it, not the package of the annotation.
 *
 * These differ whenever an option body lives in a different file from the
 * `extend` block — `store.v1.column` naming a `store.v1.ReferentialAction` from
 * a body message in another package resolves only against the body's own
 * namespace.
 *
 * @param messageFqn - Fully-qualified name of the declaring message
 * @returns The package part, or an empty string when there is none
 */
export function namespaceOf(messageFqn: string): string {
	const cut = messageFqn.lastIndexOf(".");
	return cut < 0 ? "" : messageFqn.slice(0, cut);
}

/**
 * Renders a type's closed value set, when it has one.
 *
 * This is the hint that turns `IdStrategy` from a name the reader has to go
 * look up into something they can pick from where they are standing.
 *
 * @param type - Type name as written
 * @param namespace - Package the name resolves against
 * @param registry - The annotation registry
 * @returns e.g. `` `ULID` · `UUID` ``, or undefined when the type is not an enum
 */
export function enumValueHint(
	type: string,
	namespace: string,
	registry: AnnotationRegistryImpl,
): string | undefined {
	const fqn = registry.resolveEnumFqn(type, namespace);
	const values = fqn ? registry.enumValues(fqn) : undefined;
	if (!values || values.length === 0) {
		return undefined;
	}
	const shown = values.slice(0, MAX_INLINE_ENUM_VALUES);
	const rendered = shown.map((value) => `\`${value}\``).join(" · ");
	return values.length > shown.length
		? `${rendered} · _+${values.length - shown.length} more_`
		: rendered;
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
		const namespace = namespaceOf(body.fqn);
		lines.push("**Fields**");
		lines.push("");
		for (const field of body.fields) {
			lines.push(
				`- \`${field.name}\` — _${fieldType(field)}_${field.doc ? ` · ${field.doc}` : ""}`,
			);
			// An enum-typed field is the one case where the type name alone is
			// not enough to write the value.
			const hint = field.messageFqn
				? undefined
				: enumValueHint(field.type, namespace, registry);
			if (hint) {
				lines.push(`  - ${hint}`);
			}
		}
		lines.push("");
	} else {
		// No body message: the option is assigned a value directly, so if that
		// value is an enum its members belong on the card.
		const hint = enumValueHint(descriptor.type, descriptor.namespace, registry);
		if (hint) {
			lines.push(`**Values** ${hint}`);
			lines.push("");
		}
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

	// Resolved against the body that declares the field. Using the annotation's
	// namespace missed every enum whose option body lives in another package.
	const owner = registry.bodyAt(descriptor, path.slice(0, -1));
	const hint = field.messageFqn
		? undefined
		: enumValueHint(
				field.type,
				owner ? namespaceOf(owner.fqn) : descriptor.namespace,
				registry,
			);
	if (hint) {
		lines.push(`**Values** ${hint}`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Hover card for an enum value written as an option's right-hand side.
 *
 * The card the reader actually wants when looking at `element:
 * ELEMENT_ACTUATOR`: what that member means, what else the enum allows, and
 * which of those they are currently on. The alternatives are listed in
 * declaration order with the current one marked, because the question behind
 * the hover is nearly always "is this the right one".
 *
 * @param site - The resolved value under the cursor
 * @param registry - Registry used to read the enum's members
 * @param definition - Where the enum was declared, for the footer
 * @returns Markdown source
 */
export function renderValueCard(
	site: ValueSite,
	registry: AnnotationRegistryImpl,
	definition?: DefinitionSite,
): string {
	const lines: string[] = [];
	lines.push(`### \`${site.value}\``);

	const where =
		site.path.length > 0
			? `\`${site.path.join(".")}\` in \`(${site.optionFqn})\``
			: `\`(${site.optionFqn})\``;
	if (site.member) {
		lines.push(
			`\`${site.enumFqn}\` · value ${site.member.number} · assigned to ${where}`,
		);
	} else {
		// Not a member of the enum: a compile error, and the reason the reader
		// is hovering. Say so before listing what is legal.
		lines.push(`**Not a value of** \`${site.enumFqn}\` · assigned to ${where}`);
	}
	lines.push("");
	if (site.member?.doc) {
		lines.push(site.member.doc);
		lines.push("");
	}

	const members = registry.enumMembers(site.enumFqn);
	if (members && members.length > 0) {
		lines.push(`**\`${enumName(site.enumFqn)}\` values**`);
		lines.push("");
		for (const member of cardValues(members, site.value)) {
			const current = member.name === site.value;
			const name = current ? `**\`${member.name}\`**` : `\`${member.name}\``;
			lines.push(
				`- ${name} = ${member.number}${member.doc ? ` — ${member.doc}` : ""}`,
			);
		}
		if (members.length > MAX_CARD_ENUM_VALUES) {
			lines.push("");
			lines.push(
				`_${members.length} values in all; see the declaration for the rest._`,
			);
		}
		lines.push("");
	}

	const footer = renderEnumFooter(definition);
	if (footer) {
		lines.push(footer);
	}
	return lines.join("\n");
}

/**
 * Members listed in full on a value card. `Unit` in the VSS vocabulary has 76
 * and a hover that long is not read, it is scrolled past.
 */
const MAX_CARD_ENUM_VALUES = 12;

/**
 * The slice of an enum a card lists: all of it when short, otherwise a window
 * around the value under the cursor.
 *
 * A window rather than the first N, because the first N of a 76-value enum
 * almost never contains the value being hovered — which is the one member the
 * reader is guaranteed to want.
 *
 * @param members - Every member, in declaration order
 * @param value - The value under the cursor
 * @returns The members to render, in declaration order
 */
function cardValues(
	members: readonly RawEnumValue[],
	value: string,
): readonly RawEnumValue[] {
	if (members.length <= MAX_CARD_ENUM_VALUES) {
		return members;
	}
	const at = members.findIndex((member) => member.name === value);
	// Two before the cursor's value, so it reads as part of a list rather than
	// as the top of one. An unknown value falls back to the head of the enum.
	const start =
		at < 0
			? 0
			: Math.min(Math.max(at - 2, 0), members.length - MAX_CARD_ENUM_VALUES);
	return members.slice(start, start + MAX_CARD_ENUM_VALUES);
}

/**
 * Bare name of an enum, for a heading that does not repeat its package.
 * @param enumFqn - Fully-qualified enum name
 * @returns The last segment
 */
function enumName(enumFqn: string): string {
	const cut = enumFqn.lastIndexOf(".");
	return cut < 0 ? enumFqn : enumFqn.slice(cut + 1);
}

/**
 * "Defined in" footer for an enum declaration.
 * @param site - Declaration site, when known
 * @returns Markdown line, or empty when nothing is known
 */
function renderEnumFooter(site: DefinitionSite | undefined): string {
	if (!site?.importPath) {
		return "";
	}
	const line = site.line + 1;
	if (site.path) {
		const uri = `file://${encodeURI(site.path.split("\\").join("/"))}#L${line}`;
		return `_Defined in_ [\`${site.importPath}:${line}\`](${uri})`;
	}
	return `_Defined in_ \`${site.importPath}:${line}\``;
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
