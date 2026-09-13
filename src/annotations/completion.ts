/**
 * Completion for custom options.
 *
 * Three things make this different from the extension's previous, hardcoded
 * option completion:
 *
 * **It is target-aware.** Inside an `rpc` body only `MethodOptions` extensions
 * are offered; inside a field's `[...]` brackets only `FieldOptions`; at file
 * level only `FileOptions`. Offering a method option on a message is offering
 * something that cannot compile, and `registry.byTarget` already knows the
 * difference because the extendee said so.
 *
 * **The snippet is generated, never written.** The option body's shape comes
 * from the message the `extend` block names, so the inserted text matches the
 * annotation as it exists today — including enum choices taken from the enum's
 * own values. Nothing here knows the name of a single annotation.
 *
 * **It fixes the import.** An option whose `annotations.proto` is not in the
 * file's import closure will not compile no matter how correct the spelling, so
 * accepting the completion also inserts the import, placed after the existing
 * ones.
 */

import * as vscode from "vscode";
import type {
	AnnotationDescriptor,
	AnnotationField,
	AnnotationTarget,
} from "../index/types";
import type { ProtoDocumentModel } from "./document";
import { fieldType, renderAnnotationCard, summaryLine } from "./markdown";
import { type AnnotationRegistryImpl, isScalar } from "./registry";
import {
	type AnnotationSource,
	analyzeCached,
	definitionSite,
	type ImportClosure,
	importClosure,
	resolveDescriptor,
} from "./resolve";

/** Characters that open an annotation completion without a word prefix. */
export const ANNOTATION_TRIGGER_CHARACTERS = ["(", "."];

/**
 * Body fields expanded inline. Past this the snippet inserts an empty body and
 * lets field completion fill it, rather than making the user delete fifteen
 * placeholder lines.
 */
const MAX_EXPANDED_FIELDS = 4;

/** Enum values offered as a snippet choice before falling back to a placeholder. */
const MAX_ENUM_CHOICES = 12;

/** Numeric scalar types, which take a `0` placeholder. */
const NUMERIC = new Set([
	"double",
	"float",
	"int32",
	"int64",
	"uint32",
	"uint64",
	"sint32",
	"sint64",
	"fixed32",
	"fixed64",
	"sfixed32",
	"sfixed64",
]);

/** Completion item that remembers its annotation, so `resolve` can document it. */
class AnnotationCompletionItem extends vscode.CompletionItem {
	constructor(
		label: string,
		kind: vscode.CompletionItemKind,
		readonly descriptor: AnnotationDescriptor,
	) {
		super(label, kind);
	}
}

/** Allocates snippet tabstop numbers in insertion order. */
class Tabstops {
	private next = 1;

	/**
	 * Takes the next tabstop number.
	 * @returns A number not yet used in this snippet
	 */
	take(): number {
		return this.next++;
	}
}

/**
 * Renders a placeholder for a value of a given proto type.
 *
 * Enum-typed values become a snippet choice built from the enum's own values,
 * which is the difference between `${1|REQUIRED,OPTIONAL,OUTPUT_ONLY|}` and a
 * bare `${1:value}` the user has to go look up.
 *
 * @param type - Type name as written in the declaration
 * @param namespace - Package of the declaring file, for name resolution
 * @param registry - The annotation registry
 * @param stops - Tabstop allocator
 * @returns Snippet text for one value
 */
function valuePlaceholder(
	type: string,
	namespace: string,
	registry: AnnotationRegistryImpl,
	stops: Tabstops,
): string {
	const stop = stops.take();
	if (type === "bool") {
		return `\${${stop}|true,false|}`;
	}
	if (type === "string" || type === "bytes") {
		return `"\${${stop}:value}"`;
	}
	if (NUMERIC.has(type)) {
		return `\${${stop}:0}`;
	}
	if (!isScalar(type)) {
		const enumFqn = registry.resolveEnumFqn(type, namespace);
		const values = enumFqn ? registry.enumValues(enumFqn) : undefined;
		if (values && values.length > 0) {
			return values.length <= MAX_ENUM_CHOICES
				? `\${${stop}|${values.join(",")}|}`
				: `\${${stop}:${values[0]}}`;
		}
	}
	return `\${${stop}:value}`;
}

/**
 * Renders the value of one option-body field, including nested messages and
 * repeated fields.
 * @param field - The field to render
 * @param namespace - Package of the declaring file
 * @param registry - The annotation registry
 * @param stops - Tabstop allocator
 * @returns Snippet text for `name: <value>`
 */
function fieldSnippet(
	field: AnnotationField,
	namespace: string,
	registry: AnnotationRegistryImpl,
	stops: Tabstops,
): string {
	const inner = field.messageFqn
		? `{\n\t\t$${stops.take()}\n\t}`
		: valuePlaceholder(field.type, namespace, registry, stops);
	const value = field.repeated ? `[${inner}]` : inner;
	return `${field.name}: ${value}`;
}

/**
 * Renders the whole right-hand side of an option assignment.
 * @param descriptor - The annotation being inserted
 * @param registry - The annotation registry
 * @param stops - Tabstop allocator
 * @returns Snippet text, either a text-format body or a single value
 */
function optionValueSnippet(
	descriptor: AnnotationDescriptor,
	registry: AnnotationRegistryImpl,
	stops: Tabstops,
): string {
	const body = registry.body(descriptor);
	if (!body || body.fields.length === 0) {
		return valuePlaceholder(
			descriptor.type,
			descriptor.namespace,
			registry,
			stops,
		);
	}
	if (body.fields.length > MAX_EXPANDED_FIELDS) {
		return `{\n\t$${stops.take()}\n}`;
	}
	const namespace = body.fqn.slice(0, body.fqn.lastIndexOf("."));
	const lines = body.fields.map(
		(field) => `\t${fieldSnippet(field, namespace, registry, stops)}`,
	);
	return `{\n${lines.join("\n")}\n}`;
}

/** What the text around the cursor says about how to insert an option. */
interface InsertShape {
	/** Range the completion replaces. */
	readonly range: vscode.Range;
	/** True when the replaced range already starts at a `(`. */
	readonly hasParen: boolean;
	/** True when an `=` or `.` already follows: insert the name only. */
	readonly assigned: boolean;
	/** True when the `option` keyword still has to be written. */
	readonly needsKeyword: boolean;
	/** True when the statement needs a closing `;`. */
	readonly needsSemicolon: boolean;
}

/**
 * Reads the text around the cursor to decide what a completion may safely
 * overwrite.
 *
 * Retyping the name of an option that already has a value must not duplicate
 * `option` or its `= {...}`, so the shape is derived from the buffer rather
 * than assumed.
 *
 * @param document - The buffer
 * @param position - Cursor position
 * @param statement - True in `option ...;` position, false inside `[...]`
 * @returns The insertion shape
 */
function insertShapeAt(
	document: vscode.TextDocument,
	position: vscode.Position,
	statement: boolean,
): InsertShape {
	const line = document.lineAt(position.line).text;
	const after = line.slice(position.character);

	let wordStart = position.character;
	while (wordStart > 0 && /[\w.]/.test(line[wordStart - 1])) {
		wordStart--;
	}
	let open = wordStart;
	while (open > 0 && /\s/.test(line[open - 1])) {
		open--;
	}
	const hasParen = open > 0 && line[open - 1] === "(";
	const start = hasParen ? open - 1 : wordStart;

	const close = hasParen ? /^\s*\)/.exec(after) : null;
	const end = close ? position.character + close[0].length : position.character;
	const tail = close ? after.slice(close[0].length) : after;

	const head = line.slice(0, start).trimEnd();
	return {
		range: new vscode.Range(position.line, start, position.line, end),
		hasParen,
		assigned: /^\s*[=.]/.test(tail),
		needsKeyword: statement && !/\boption$/.test(head),
		needsSemicolon: statement && !tail.includes(";"),
	};
}

/**
 * Finds the line an inserted `import` belongs on.
 * @param document - The buffer
 * @param model - Structural model of the buffer
 * @returns 0-based line to insert before
 */
function importInsertLine(
	document: vscode.TextDocument,
	model: ProtoDocumentModel,
): number {
	if (model.imports.length > 0) {
		let last = 0;
		for (const entry of model.imports) {
			last = Math.max(last, entry.line);
		}
		return last + 1;
	}
	const limit = Math.min(document.lineCount, 64);
	let anchor = 0;
	for (let line = 0; line < limit; line++) {
		const text = document.lineAt(line).text;
		if (/^\s*package\s/.test(text)) {
			return line + 1;
		}
		if (/^\s*(syntax|edition)\s*=/.test(text)) {
			anchor = line + 1;
		}
	}
	return anchor;
}

/**
 * Builds the edit that adds a missing `import`, when one is missing.
 *
 * Skipped when the closure is only partially known: proving an import is
 * present is safe on partial data, proving one absent is not.
 *
 * @param document - The buffer
 * @param model - Structural model of the buffer
 * @param descriptor - The annotation being inserted
 * @param closure - The file's import closure
 * @returns The edit, or undefined when the import is already reachable
 */
function importEdit(
	document: vscode.TextDocument,
	model: ProtoDocumentModel,
	descriptor: AnnotationDescriptor,
	closure: ImportClosure,
): vscode.TextEdit | undefined {
	const path = descriptor.importPath;
	if (!path || closure.paths.has(path)) {
		return undefined;
	}
	if (model.declarations.some((entry) => entry.name === descriptor.name)) {
		return undefined;
	}
	const line = importInsertLine(document, model);
	const blank = model.imports.length === 0 ? "\n" : "";
	return vscode.TextEdit.insert(
		new vscode.Position(line, 0),
		`import "${path}";\n${blank}`,
	);
}

/** Target-aware completion for annotations and their body fields. */
export class AnnotationCompletionProvider
	implements vscode.CompletionItemProvider
{
	constructor(private readonly source: AnnotationSource) {}

	/**
	 * Offers the annotations or body fields that are legal at the cursor.
	 * @param document - The buffer
	 * @param position - Cursor position
	 * @param token - Cancellation token supplied by VS Code
	 * @returns Completion items, or undefined outside an annotation position
	 */
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): vscode.CompletionItem[] | undefined {
		const registry = this.source.registry();
		if (!registry || token.isCancellationRequested) {
			return undefined;
		}
		const model = analyzeCached(
			document.uri.toString(),
			document.version,
			document.getText(),
		);
		const context = model.contextAt(document.offsetAt(position));
		if (context.kind === "none" || !context.target) {
			return undefined;
		}
		if (context.kind === "optionBody") {
			return this.fieldItems(
				document,
				position,
				model,
				registry,
				context.optionFqn,
				context.path ?? [],
			);
		}
		return this.annotationItems(
			document,
			position,
			model,
			registry,
			context.target,
			context.kind === "statement",
		);
	}

	/**
	 * Fills in the hover card for the selected item only, so a request that
	 * offers sixty annotations renders one card instead of sixty.
	 * @param item - The item being previewed
	 * @returns The same item, with documentation
	 */
	resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
		const registry = this.source.registry();
		if (!registry || !(item instanceof AnnotationCompletionItem)) {
			return item;
		}
		const markdown = new vscode.MarkdownString(
			renderAnnotationCard(
				item.descriptor,
				registry,
				definitionSite(registry, item.descriptor),
			),
		);
		markdown.isTrusted = true;
		item.documentation = markdown;
		return item;
	}

	/**
	 * Annotations legal on the element being decorated.
	 * @param document - The buffer
	 * @param position - Cursor position
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @param target - Element the option would decorate
	 * @param statement - True in `option ...;` position, false inside `[...]`
	 * @returns One item per legal annotation
	 */
	private annotationItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
		target: AnnotationTarget,
		statement: boolean,
	): vscode.CompletionItem[] {
		const shape = insertShapeAt(document, position, statement);
		const closure = importClosure(
			registry,
			model.imports.map((entry) => entry.path),
		);
		const items: vscode.CompletionItem[] = [];

		for (const descriptor of registry.byTarget(target)) {
			const item = new AnnotationCompletionItem(
				`(${descriptor.fqn})`,
				vscode.CompletionItemKind.Property,
				descriptor,
			);
			item.detail = summaryLine(descriptor);
			item.range = shape.range;
			item.filterText = shape.hasParen ? `(${descriptor.fqn}` : descriptor.fqn;
			// Annotations from the file's own package first: a workspace author is
			// far likelier to want theirs than a dependency's.
			item.sortText = `${descriptor.namespace === model.packageName ? "0" : "1"}${descriptor.fqn}`;

			const stops = new Tabstops();
			const head = shape.needsKeyword ? "option " : "";
			const value = shape.assigned
				? ""
				: ` = ${optionValueSnippet(descriptor, registry, stops)}`;
			const tail = shape.assigned || !shape.needsSemicolon ? "" : ";";
			item.insertText = new vscode.SnippetString(
				`${head}(${descriptor.fqn})${value}${tail}`,
			);

			const edit = importEdit(document, model, descriptor, closure);
			if (edit) {
				item.additionalTextEdits = [edit];
				item.detail = `${item.detail} · adds import`;
			}
			items.push(item);
		}
		return items;
	}

	/**
	 * Field names legal at this point of an option body.
	 * @param document - The buffer
	 * @param position - Cursor position
	 * @param model - Structural model of the buffer
	 * @param registry - The annotation registry
	 * @param optionFqn - Annotation whose body is being written
	 * @param path - Field path already entered
	 * @returns One item per field of the body message at that path
	 */
	private fieldItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		model: ProtoDocumentModel,
		registry: AnnotationRegistryImpl,
		optionFqn: string | undefined,
		path: readonly string[],
	): vscode.CompletionItem[] | undefined {
		if (!optionFqn) {
			return undefined;
		}
		const descriptor = resolveDescriptor(
			registry,
			optionFqn,
			model.packageName,
		);
		if (!descriptor) {
			return undefined;
		}
		const body = registry.bodyAt(descriptor, path);
		if (!body) {
			return undefined;
		}
		const namespace = body.fqn.slice(0, body.fqn.lastIndexOf("."));

		const line = document.lineAt(position.line).text;
		let start = position.character;
		while (start > 0 && /\w/.test(line[start - 1])) {
			start--;
		}
		const range = new vscode.Range(
			position.line,
			start,
			position.line,
			position.character,
		);
		const hasColon = /^\s*:/.test(line.slice(position.character));

		const items: vscode.CompletionItem[] = [];
		for (const field of body.fields) {
			const item = new vscode.CompletionItem(
				field.name,
				vscode.CompletionItemKind.Field,
			);
			item.detail = `${fieldType(field)} · field ${field.number}`;
			item.range = range;
			item.sortText = String(field.number).padStart(6, "0");
			if (field.doc) {
				item.documentation = new vscode.MarkdownString(field.doc);
			}
			item.insertText = hasColon
				? field.name
				: new vscode.SnippetString(
						fieldSnippet(field, namespace, registry, new Tabstops()),
					);
			items.push(item);
		}
		return items;
	}
}
