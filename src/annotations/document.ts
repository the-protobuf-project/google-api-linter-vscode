/**
 * Structural analysis of a single `.proto` buffer, used by every annotation
 * feature.
 *
 * Hover, completion, diagnostics and semantic tokens all need the same three
 * answers about a position in a file:
 *
 * - which `(some.option)` references exist, and where;
 * - what proto element each one decorates, because that is what makes an
 *   annotation legal or illegal (`MethodOptions` on a message will not compile);
 * - which field of an option body a given offset sits in, including nesting, so
 *   `ttl: { seconds: 300 }` can answer for `seconds`.
 *
 * A single character scan produces all of it. The scan tracks the enclosing
 * block stack, skips comments and string literals, and distinguishes an option
 * reference `(pkg.name)` — always followed by `=` or `.` — from an rpc signature
 * `rpc Get(Req) returns (Res)`, which is not.
 *
 * Offsets are byte-free character offsets into the text, so callers convert with
 * `TextDocument.positionAt`. This module must never import `vscode`: it is
 * exercised directly on strings.
 */

import type { AnnotationTarget } from "../index/types";

/** Kind of block a position sits inside. */
export type ProtoBlockKind =
	| "file"
	| "message"
	| "enum"
	| "service"
	| "rpc"
	| "oneof"
	| "extend"
	| "fieldOptions"
	| "optionBody"
	| "unknown";

/** One `{...}` or `[...]` region of the file. */
export interface ProtoBlock {
	readonly kind: ProtoBlockKind;
	readonly name?: string;
	/** Offset just after the opening delimiter. */
	readonly start: number;
	/** Offset of the closing delimiter, or text length when unterminated. */
	end: number;
	readonly parent?: ProtoBlock;
	/** `optionBody` only: the annotation being written. */
	readonly optionFqn?: string;
	/** `optionBody` only: field path from the body root. */
	readonly path?: readonly string[];
	/** `extend` only: the extendee as written. */
	readonly extendee?: string;
}

/** A `(pkg.name)` option reference in the source. */
export interface OptionReference {
	/** Dotted name inside the parens, e.g. `mcp.v1.tool`. */
	readonly fqn: string;
	/** Offset of the `(`. */
	readonly start: number;
	/** Offset just after the `)`. */
	readonly end: number;
	/** Offset range of the name text alone — what a hover should highlight. */
	readonly nameStart: number;
	readonly nameEnd: number;
	/** Element this option decorates, or undefined when the context is unclear. */
	readonly target?: AnnotationTarget;
	/** `.foo.bar` accessors written after the closing paren. */
	readonly accessors: readonly string[];
}

/** A field name written inside an option body or as a `.` accessor. */
export interface BodyFieldReference {
	readonly optionFqn: string;
	/** Field path from the body root, this field last. */
	readonly path: readonly string[];
	readonly start: number;
	readonly end: number;
}

/** An `import "..."` statement. */
export interface ProtoImport {
	readonly path: string;
	/** 0-based line. */
	readonly line: number;
	/** Offset range of the quoted path, quotes included. */
	readonly start: number;
	readonly end: number;
}

/** An extension field declared inside an `extend google.protobuf.*Options` block. */
export interface ExtensionDeclaration {
	readonly name: string;
	readonly extendee: string;
	readonly target?: AnnotationTarget;
	readonly number: number;
	/** Offset range of the field name. */
	readonly start: number;
	readonly end: number;
}

/** Where the cursor is, in the terms completion cares about. */
export interface AnnotationCursorContext {
	/** `option` statement position, `[...]` brackets, an option body, or none. */
	readonly kind: "statement" | "fieldOptions" | "optionBody" | "none";
	/** Legal annotation target at this position. */
	readonly target?: AnnotationTarget;
	/** `optionBody` only: which annotation is being written. */
	readonly optionFqn?: string;
	/** `optionBody` only: the field path already entered. */
	readonly path?: readonly string[];
}

/** Everything the annotation features read out of one buffer. */
export interface ProtoDocumentModel {
	readonly packageName: string;
	readonly imports: readonly ProtoImport[];
	readonly options: readonly OptionReference[];
	readonly bodyFields: readonly BodyFieldReference[];
	readonly declarations: readonly ExtensionDeclaration[];
	readonly blocks: readonly ProtoBlock[];
	/**
	 * Innermost context at an offset.
	 * @param offset - Character offset into the analysed text
	 * @returns What kind of annotation input is legal there
	 */
	contextAt(offset: number): AnnotationCursorContext;
}

const RE_IMPORT_LINE =
	/^[ \t]*import[ \t]+(?:public[ \t]+|weak[ \t]+)?"([^"]*)"/;
const RE_PACKAGE_LINE = /^[ \t]*package[ \t]+([A-Za-z0-9_.]+)[ \t]*;/;
const RE_EXTENSION_FIELD =
	/^([ \t]*(?:(?:optional|required|repeated)[ \t]+)?[A-Za-z_][\w.]*[ \t]+)([A-Za-z_]\w*)[ \t]*=[ \t]*(\d+)/;

const EXTENDEE_TARGETS: Readonly<Record<string, AnnotationTarget>> = {
	FileOptions: "File",
	MessageOptions: "Message",
	FieldOptions: "Field",
	OneofOptions: "Oneof",
	EnumOptions: "Enum",
	EnumValueOptions: "EnumValue",
	ServiceOptions: "Service",
	MethodOptions: "Method",
};

function isIdentStart(c: string): boolean {
	return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
	return isIdentStart(c) || (c >= "0" && c <= "9");
}

/**
 * Skips whitespace and comments starting at an offset.
 * @param text - Source text
 * @param i - Offset to start from
 * @returns Offset of the next significant character
 */
function skipTrivia(text: string, i: number): number {
	let pos = i;
	while (pos < text.length) {
		const c = text[pos];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			pos++;
			continue;
		}
		if (c === "/" && text[pos + 1] === "/") {
			while (pos < text.length && text[pos] !== "\n") {
				pos++;
			}
			continue;
		}
		if (c === "/" && text[pos + 1] === "*") {
			const close = text.indexOf("*/", pos + 2);
			pos = close < 0 ? text.length : close + 2;
			continue;
		}
		return pos;
	}
	return pos;
}

/**
 * Reads a dotted identifier.
 * @param text - Source text
 * @param i - Offset of the first character
 * @returns The identifier and the offset just past it, or undefined
 */
function readDottedIdent(
	text: string,
	i: number,
): { value: string; end: number } | undefined {
	if (i >= text.length || (!isIdentStart(text[i]) && text[i] !== ".")) {
		return undefined;
	}
	let pos = i;
	if (text[pos] === ".") {
		pos++;
	}
	const start = pos;
	while (pos < text.length && (isIdentPart(text[pos]) || text[pos] === ".")) {
		pos++;
	}
	if (pos === start) {
		return undefined;
	}
	return { value: text.slice(start, pos), end: pos };
}

/**
 * Reads a single identifier, stopping at a dot.
 * @param text - Source text
 * @param i - Offset of the first character
 * @returns The identifier and the offset just past it, or undefined
 */
function readIdent(
	text: string,
	i: number,
): { value: string; end: number } | undefined {
	if (i >= text.length || !isIdentStart(text[i])) {
		return undefined;
	}
	let pos = i;
	while (pos < text.length && isIdentPart(text[pos])) {
		pos++;
	}
	return { value: text.slice(i, pos), end: pos };
}

/**
 * Resolves the proto element an option reference decorates.
 * @param block - Innermost block containing the reference
 * @returns The legal target, or undefined when the context is not an option site
 */
function targetOf(block: ProtoBlock): AnnotationTarget | undefined {
	let current: ProtoBlock | undefined = block;
	while (current && current.kind === "optionBody") {
		current = current.parent;
	}
	if (!current) {
		return undefined;
	}
	if (current.kind === "fieldOptions") {
		const owner = current.parent;
		return owner?.kind === "enum" ? "EnumValue" : "Field";
	}
	switch (current.kind) {
		case "file":
			return "File";
		case "message":
			return "Message";
		case "enum":
			return "Enum";
		case "service":
			return "Service";
		case "rpc":
			return "Method";
		case "oneof":
			return "Oneof";
		default:
			return undefined;
	}
}

/**
 * Classifies a `{` from the words that preceded it.
 * @param words - Identifiers seen since the last `;`, `{` or `}`
 * @returns Block kind and declared name
 */
function classifyBlock(words: readonly string[]): {
	kind: ProtoBlockKind;
	name?: string;
	extendee?: string;
} {
	const head = words[0];
	switch (head) {
		case "message":
			return { kind: "message", name: words[1] };
		case "enum":
			return { kind: "enum", name: words[1] };
		case "service":
			return { kind: "service", name: words[1] };
		case "oneof":
			return { kind: "oneof", name: words[1] };
		case "rpc":
			return { kind: "rpc", name: words[1] };
		case "extend":
			return { kind: "extend", name: words[1], extendee: words[1] };
		default:
			return { kind: "unknown" };
	}
}

/**
 * Analyses a `.proto` buffer.
 *
 * Tolerant of half-written source: an unterminated block simply runs to the end
 * of the text, which is what an editor buffer looks like while the user types.
 *
 * @param text - Full buffer contents
 * @returns The structural model the annotation features read
 */
export function analyzeProtoDocument(text: string): ProtoDocumentModel {
	const length = text.length;
	const blocks: ProtoBlock[] = [];
	const options: OptionReference[] = [];
	const bodyFields: BodyFieldReference[] = [];
	const declarations: ExtensionDeclaration[] = [];

	const root: ProtoBlock = { kind: "file", start: 0, end: length };
	blocks.push(root);
	let current: ProtoBlock = root;
	let words: string[] = [];
	/** Field path a pending `{` or `[` should adopt, set by `name:` in a body. */
	let pendingPath: readonly string[] | undefined;

	const push = (block: ProtoBlock): void => {
		blocks.push(block);
		current = block;
		words = [];
		pendingPath = undefined;
	};

	const pop = (at: number): void => {
		current.end = at;
		current = current.parent ?? root;
		words = [];
		pendingPath = undefined;
	};

	/** Enclosing block that owns option syntax, skipping option bodies. */
	const declarationBlock = (block: ProtoBlock): ProtoBlock => {
		let node: ProtoBlock | undefined = block;
		while (
			node &&
			(node.kind === "optionBody" || node.kind === "fieldOptions")
		) {
			node = node.parent;
		}
		return node ?? root;
	};

	let i = 0;
	while (i < length) {
		const c = text[i];

		if (c === "/" && text[i + 1] === "/") {
			while (i < length && text[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			i = close < 0 ? length : close + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			i++;
			while (i < length && text[i] !== c) {
				i += text[i] === "\\" ? 2 : 1;
			}
			i++;
			pendingPath = undefined;
			continue;
		}
		if (c === ";" || c === ",") {
			words = [];
			pendingPath = undefined;
			i++;
			continue;
		}
		if (c === "}" || c === "]") {
			if (current !== root) {
				pop(i);
			}
			i++;
			continue;
		}

		if (c === "{") {
			if (current.kind === "optionBody" || current.kind === "fieldOptions") {
				// A bare `{` inside a body: either a nested message value whose
				// field name we just read, or an element of a repeated list.
				push({
					kind: "optionBody",
					start: i + 1,
					end: length,
					parent: current,
					optionFqn: current.optionFqn,
					path: pendingPath ?? current.path ?? [],
				});
			} else {
				const classified = classifyBlock(words);
				push({
					kind: classified.kind,
					name: classified.name,
					extendee: classified.extendee,
					start: i + 1,
					end: length,
					parent: current,
				});
			}
			i++;
			continue;
		}

		if (c === "[") {
			if (current.kind === "optionBody") {
				push({
					kind: "optionBody",
					start: i + 1,
					end: length,
					parent: current,
					optionFqn: current.optionFqn,
					path: pendingPath ?? current.path ?? [],
				});
			} else if (
				current.kind === "message" ||
				current.kind === "enum" ||
				current.kind === "oneof" ||
				current.kind === "extend"
			) {
				push({
					kind: "fieldOptions",
					start: i + 1,
					end: length,
					parent: current,
				});
			} else {
				push({ kind: "unknown", start: i + 1, end: length, parent: current });
			}
			i++;
			continue;
		}

		if (c === "(") {
			const reference = matchOptionReference(text, i);
			if (reference) {
				const enclosing = current;
				const accessors: string[] = [];
				let cursor = reference.afterParen;

				// `.foo.bar` accessors after the closing paren index into the body,
				// one recorded segment at a time so a hover lands on the right one.
				for (;;) {
					const next = skipTrivia(text, cursor);
					if (text[next] !== ".") {
						cursor = next;
						break;
					}
					const ident = readIdent(text, next + 1);
					if (!ident) {
						cursor = next + 1;
						break;
					}
					accessors.push(ident.value);
					bodyFields.push({
						optionFqn: reference.fqn,
						path: [...accessors],
						start: next + 1,
						end: ident.end,
					});
					cursor = ident.end;
				}

				options.push({
					fqn: reference.fqn,
					start: i,
					end: reference.afterParen,
					nameStart: reference.nameStart,
					nameEnd: reference.nameEnd,
					target: targetOf(enclosing),
					accessors,
				});

				// `= {` opens a text-format body scoped to this option.
				const afterEquals = skipTrivia(text, cursor);
				if (text[afterEquals] === "=") {
					const valueStart = skipTrivia(text, afterEquals + 1);
					if (text[valueStart] === "{") {
						push({
							kind: "optionBody",
							start: valueStart + 1,
							end: length,
							parent: enclosing,
							optionFqn: reference.fqn,
							path: accessors,
						});
						i = valueStart + 1;
						continue;
					}
					i = afterEquals + 1;
					continue;
				}
				i = cursor;
				continue;
			}
			i++;
			continue;
		}

		if (isIdentStart(c)) {
			// Inside a text-format body a field name is a bare identifier; in
			// declaration context a name may be dotted (`google.protobuf.Any`).
			const ident =
				current.kind === "optionBody"
					? readIdent(text, i)
					: readDottedIdent(text, i);
			if (!ident) {
				i++;
				continue;
			}
			if (current.kind === "optionBody") {
				const after = skipTrivia(text, ident.end);
				const isField = text[after] === ":" || text[after] === "{";
				if (isField) {
					const path = [...(current.path ?? []), ident.value];
					bodyFields.push({
						optionFqn: current.optionFqn ?? "",
						path,
						start: i,
						end: ident.end,
					});
					pendingPath = path;
					i = text[after] === ":" ? after + 1 : after;
					continue;
				}
				pendingPath = undefined;
			} else {
				words.push(ident.value);
			}
			i = ident.end;
			continue;
		}

		i++;
	}

	// Unterminated blocks run to the end of the buffer.
	for (const block of blocks) {
		if (block.end > length) {
			block.end = length;
		}
	}

	const { packageName, imports } = scanLines(text);
	collectDeclarations(text, blocks, declarations);

	// Innermost-first: later blocks are opened later, so scanning backwards and
	// taking the first container gives the deepest one.
	const ordered = [...blocks].sort((a, b) => a.start - b.start);

	return {
		packageName,
		imports,
		options,
		bodyFields,
		declarations,
		blocks: ordered,
		contextAt(offset: number): AnnotationCursorContext {
			let innermost: ProtoBlock = root;
			for (const block of ordered) {
				if (block.start > offset) {
					break;
				}
				if (offset <= block.end) {
					innermost = block;
				}
			}
			if (innermost.kind === "optionBody") {
				return {
					kind: "optionBody",
					target: targetOf(innermost),
					optionFqn: innermost.optionFqn,
					path: innermost.path ?? [],
				};
			}
			if (innermost.kind === "fieldOptions") {
				return { kind: "fieldOptions", target: targetOf(innermost) };
			}
			const declaration = declarationBlock(innermost);
			const target = targetOf(declaration);
			return target ? { kind: "statement", target } : { kind: "none" };
		},
	};
}

/**
 * Matches `( dotted.name )` when it is an option reference rather than an rpc
 * signature. The discriminator is what follows the closing paren: an option is
 * always assigned (`=`) or indexed into (`.`); `rpc Get(Req) returns (Res)` is
 * neither.
 * @param text - Source text
 * @param open - Offset of the `(`
 * @returns The parsed reference, or undefined
 */
function matchOptionReference(
	text: string,
	open: number,
):
	| {
			fqn: string;
			nameStart: number;
			nameEnd: number;
			afterParen: number;
	  }
	| undefined {
	const nameStart = skipTrivia(text, open + 1);
	const ident = readDottedIdent(text, nameStart);
	if (!ident) {
		return undefined;
	}
	const close = skipTrivia(text, ident.end);
	if (text[close] !== ")") {
		return undefined;
	}
	const after = skipTrivia(text, close + 1);
	if (text[after] !== "=" && text[after] !== ".") {
		return undefined;
	}
	return {
		fqn: ident.value,
		nameStart,
		nameEnd: ident.end,
		afterParen: close + 1,
	};
}

/**
 * Pulls the package name and import statements out with a line pass — cheaper
 * and less error-prone than threading them through the character scanner.
 * @param text - Source text
 * @returns Package name and every import, with offsets
 */
function scanLines(text: string): {
	packageName: string;
	imports: ProtoImport[];
} {
	const imports: ProtoImport[] = [];
	let packageName = "";
	let offset = 0;
	const lines = text.split("\n");
	for (let line = 0; line < lines.length; line++) {
		const content = lines[line];
		const importMatch = RE_IMPORT_LINE.exec(content);
		if (importMatch) {
			const quote = content.indexOf('"');
			imports.push({
				path: importMatch[1],
				line,
				start: offset + quote,
				end: offset + quote + importMatch[1].length + 2,
			});
		} else if (packageName === "") {
			const packageMatch = RE_PACKAGE_LINE.exec(content);
			if (packageMatch) {
				packageName = packageMatch[1];
			}
		}
		offset += content.length + 1;
	}
	return { packageName, imports };
}

/**
 * Finds the extension fields declared inside this file's own `extend
 * google.protobuf.*Options` blocks, so hovers and highlighting work on a
 * definition as well as on a use.
 * @param text - Source text
 * @param blocks - Blocks produced by the scanner
 * @param out - Array to append declarations to
 */
function collectDeclarations(
	text: string,
	blocks: readonly ProtoBlock[],
	out: ExtensionDeclaration[],
): void {
	for (const block of blocks) {
		if (block.kind !== "extend" || !block.extendee) {
			continue;
		}
		const extendee = block.extendee.replace(/^\.?google\.protobuf\./, "");
		const target = EXTENDEE_TARGETS[extendee];
		const body = text.slice(block.start, block.end);
		let cursor = 0;
		for (const line of body.split("\n")) {
			const match = RE_EXTENSION_FIELD.exec(line);
			if (match) {
				const nameOffset = match[1].length;
				out.push({
					name: match[2],
					extendee: block.extendee,
					target,
					number: Number(match[3]),
					start: block.start + cursor + nameOffset,
					end: block.start + cursor + nameOffset + match[2].length,
				});
			}
			cursor += line.length + 1;
		}
	}
}
