/**
 * Extracts the annotation vocabulary from `.proto` source.
 *
 * Custom protobuf annotations are self-describing. Every one of them is an
 * `extend google.protobuf.*Options` block, and that single block carries
 * everything the editor needs:
 *
 * ```proto
 * // Attach MCP tool options (name/description override) to a single RPC method.
 * extend google.protobuf.MethodOptions {
 *   optional MCPToolOptions tool = 51001;
 * }
 * ```
 *
 * - fully-qualified name — file `package` + field name (`mcp.v1.tool`)
 * - legal target — the extendee (`MethodOptions` means rpc, and only rpc)
 * - body shape — the field's message type, resolved later and lazily
 * - documentation — the leading `//` comment
 * - usage example — the indented, godoc-style block inside that comment
 * - field number and source location — written right there
 *
 * Nothing in this module knows the name of a single annotation. That is the
 * point: hardcoding `mcp.protobuf.*` is exactly what left the extension two
 * generations stale.
 *
 * This module must never import `vscode` — the index walk (track D) and the
 * standalone scanner both run it outside the extension host.
 */

import type { AnnotationDescriptor, AnnotationTarget } from "../index/types";

/** `google.protobuf.<key>` extendee to the proto element it may decorate. */
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

/** Human label for each target, used by hovers and completion detail lines. */
export const TARGET_LABELS: Readonly<Record<AnnotationTarget, string>> = {
	File: "file",
	Message: "message",
	Field: "field",
	Oneof: "oneof",
	Enum: "enum",
	EnumValue: "enum value",
	Service: "service",
	Method: "rpc",
};

/** Every target an annotation may legally be attached to. */
export const ALL_TARGETS: readonly AnnotationTarget[] = Object.freeze([
	"File",
	"Message",
	"Field",
	"Oneof",
	"Enum",
	"EnumValue",
	"Service",
	"Method",
]);

const RE_PACKAGE = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/;
const RE_IMPORT = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/;
// The leading `.` is optional for the same reason as in RE_FIELD: proto spells a
// fully-qualified extendee `.google.protobuf.FieldOptions`. The normalisation
// below already strips `^\.?google\.protobuf\.`, so the dot was always expected
// here -- without it that branch was unreachable and the whole extend block,
// with every annotation in it, was skipped.
const RE_EXTEND = /^\s*extend\s+(\.?[A-Za-z_][\w.]*)\s*\{?/;
const RE_MESSAGE = /^\s*message\s+([A-Za-z_]\w*)\s*\{?/;
const RE_ENUM = /^\s*enum\s+([A-Za-z_]\w*)\s*\{?/;
const RE_ONEOF = /^\s*oneof\s+([A-Za-z_]\w*)\s*\{?/;
const RE_SERVICE = /^\s*service\s+([A-Za-z_]\w*)\s*\{?/;
// The trailing `;`-or-`[` alternation keeps fields whose option brackets are
// wrapped onto following lines, a shape `buf format` produces routinely.
//
// The type accepts an optional leading `.`: proto spells a fully-qualified
// reference `.google.protobuf.Duration`, rooted at the global namespace. Without
// it such a field matches nothing and the annotation is dropped outright rather
// than mis-parsed -- no hover, no completion, no highlighting, and no error to
// say why. `resolveTypeFqn` and `resolveEnumFqn` already strip the dot, so the
// rest of the pipeline expects to see one.
const RE_FIELD =
	/^\s*(?:(optional|required|repeated)\s+)?(map\s*<[^>]*>|\.?[A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*(?:;|\[)/;
const RE_ENUM_VALUE = /^\s*([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*(?:;|\[)/;

/** Keywords that look like a field declaration but are not one. */
const FIELD_NON_TYPES = new Set([
	"option",
	"reserved",
	"returns",
	"rpc",
	"import",
	"package",
	"syntax",
	"edition",
	"extend",
	"oneof",
	"enum",
	"message",
	"service",
	"extensions",
]);

/** One field of an option-body message, before type resolution. */
export interface RawField {
	readonly name: string;
	readonly type: string;
	readonly number: number;
	readonly repeated: boolean;
	readonly doc?: string;
	/** 0-based line of the declaration. */
	readonly line: number;
}

/** A message declaration that may serve as an option body. */
export interface ExtractedMessage {
	readonly fqn: string;
	readonly fields: readonly RawField[];
	readonly fileId: number;
	/** 0-based. */
	readonly line: number;
}

/**
 * One value of an enum.
 *
 * The doc comment is the point. A completion list can be built from names
 * alone, but "is `ELEMENT_ACTUATOR` the right one here?" is answered only by
 * what the specification wrote on that member, and dropping it meant the
 * reader had to go open the enum to find out.
 */
export interface RawEnumValue {
	readonly name: string;
	readonly number: number;
	readonly doc?: string;
	/** 0-based line of the declaration. */
	readonly line: number;
}

/** An enum declaration; its values become completion choices. */
export interface ExtractedEnum {
	readonly fqn: string;
	readonly values: readonly RawEnumValue[];
	readonly fileId: number;
	/** 0-based. */
	readonly line: number;
}

/** Everything one `.proto` file contributes to the annotation registry. */
export interface ExtractedFile {
	readonly fileId: number;
	/** Import path other files use to reach this one, e.g. `mcp/v1/annotations.proto`. */
	readonly importPath: string;
	/** Absolute path on disk, used for "defined in" links. */
	readonly path?: string;
	readonly packageName: string;
	readonly imports: readonly string[];
	readonly annotations: readonly AnnotationDescriptor[];
	readonly messages: readonly ExtractedMessage[];
	readonly enums: readonly ExtractedEnum[];
}

/** Identity of the file being extracted. Supplied by the caller, never guessed. */
export interface ExtractContext {
	readonly fileId: number;
	/** Path relative to the proto import root, with forward slashes. */
	readonly importPath: string;
	/** Absolute path on disk, when known. */
	readonly path?: string;
}

interface Frame {
	kind: "message" | "enum" | "service" | "oneof" | "extend";
	fqn: string;
	/** Brace depth the block returns to when it closes. */
	closeDepth: number;
	/** Extendee target, for `extend` frames only. */
	target?: AnnotationTarget;
	/** Doc of the `extend` block itself, used when a field has none. */
	blockDoc?: SplitComment;
	fields?: RawField[];
	values?: RawEnumValue[];
	line: number;
}

interface SplitComment {
	readonly prose: string;
	readonly code: string;
}

/**
 * Reads the leading `//` comment block immediately above a line.
 * @param lines - The file split on newlines
 * @param index - 0-based line the comment belongs to
 * @returns The comment lines, markers stripped, in source order
 */
function leadingComment(lines: readonly string[], index: number): string[] {
	const out: string[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed === "") {
			if (out.length > 0) {
				break;
			}
			continue;
		}
		if (!trimmed.startsWith("//")) {
			break;
		}
		// A single space after the marker, never `\s`: godoc -- and the corpus,
		// see `cache/v1/annotations.proto` -- marks example code by indenting it
		// one tab past the marker. Eating that tab flattened the example's
		// outermost lines to column zero, so `splitComment` read them as prose
		// and the example survived as a fragment missing its opening and
		// closing lines.
		out.unshift(trimmed.replace(/^\/\/+ ?/, ""));
	}
	return out;
}

/**
 * Splits a comment into prose and its godoc-style indented example block.
 * A leading tab or four spaces marks a line as example code — the convention
 * `cache.v1` and friends already write.
 * @param commentLines - Comment lines with markers stripped
 * @returns Prose joined into a paragraph, plus the dedented code block
 */
function splitComment(commentLines: readonly string[]): SplitComment {
	const prose: string[] = [];
	const code: string[] = [];
	for (const line of commentLines) {
		// The indent may be followed by further indentation -- a tab then two
		// spaces is one nested line of an example -- so look past it for content
		// rather than demanding a non-space immediately.
		if (/^(?:\t| {2,})\s*\S/.test(line)) {
			code.push(line.replace(/^(\t| {4}| {2})/, ""));
		} else if (code.length > 0 && line.trim() === "") {
			code.push("");
		} else {
			prose.push(line);
		}
	}
	while (code.length > 0 && code[code.length - 1].trim() === "") {
		code.pop();
	}
	return { prose: prose.join(" ").trim(), code: code.join("\n").trim() };
}

/**
 * Removes comments and string contents so brace counting cannot be fooled by
 * a `{` inside a literal.
 * @param line - One raw source line
 * @returns The line with strings blanked and comments dropped
 */
function stripLine(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const c = line[i];
		if (c === "/" && line[i + 1] === "/") {
			break;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			i++;
			while (i < line.length && line[i] !== quote) {
				i += line[i] === "\\" ? 2 : 1;
			}
			i++;
			out += '""';
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * Counts net brace depth change on a line.
 * @param code - A line already passed through {@link stripLine}
 * @returns Opening braces minus closing braces
 */
function braceDelta(code: string): number {
	let delta = 0;
	for (const c of code) {
		if (c === "{") {
			delta++;
		} else if (c === "}") {
			delta--;
		}
	}
	return delta;
}

/**
 * Joins a package and a local name into a fully-qualified name.
 * @param prefix - Package or enclosing type fqn, possibly empty
 * @param name - Local identifier
 * @returns The dotted fully-qualified name
 */
function join(prefix: string, name: string): string {
	return prefix ? `${prefix}.${name}` : name;
}

/**
 * Parses one `.proto` file into the pieces the annotation registry needs.
 *
 * Cheap and allocation-light: a single line pass, no file text retained. The
 * index walk calls this with text it already has, so annotations cost no extra
 * I/O.
 *
 * @param text - Full file contents
 * @param ctx - Identity of the file (id, import path, absolute path)
 * @returns Declared annotations, candidate option-body messages, and enums
 */
export function extractAnnotations(
	text: string,
	ctx: ExtractContext,
): ExtractedFile {
	const lines = text.split("\n");
	const annotations: AnnotationDescriptor[] = [];
	const messages: ExtractedMessage[] = [];
	const enums: ExtractedEnum[] = [];
	const imports: string[] = [];
	const stack: Frame[] = [];
	let packageName = "";
	let depth = 0;

	/** Nearest frame that owns field declarations. */
	const ownerFrame = (): Frame | undefined => {
		for (let i = stack.length - 1; i >= 0; i--) {
			const frame = stack[i];
			if (frame.kind === "message" || frame.kind === "extend") {
				return frame;
			}
			if (frame.kind === "oneof") {
				continue;
			}
			return frame.kind === "enum" ? frame : undefined;
		}
		return undefined;
	};

	/** Enclosing type prefix for a new nested declaration. */
	const scopePrefix = (): string => {
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i].kind === "message" || stack[i].kind === "enum") {
				return stack[i].fqn;
			}
		}
		return packageName;
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const code = stripLine(raw);
		const depthBefore = depth;

		if (code.trim() !== "") {
			if (packageName === "") {
				const pkg = RE_PACKAGE.exec(code);
				if (pkg) {
					packageName = pkg[1];
				}
			}
			// Matched against the raw line, not `code`: stripLine blanks every
			// string body to `""` so that a brace inside a literal cannot shift
			// the depth, which also erases the one thing an import statement
			// carries. Gating on the stripped line still starting with `import`
			// keeps a commented-out or trailing-comment import from matching,
			// since stripLine has already removed those.
			if (/^\s*import\b/.test(code)) {
				const imp = RE_IMPORT.exec(raw);
				if (imp) {
					imports.push(imp[1]);
				}
			}

			const extend = RE_EXTEND.exec(code);
			const message = extend ? null : RE_MESSAGE.exec(code);
			const enumDecl = extend || message ? null : RE_ENUM.exec(code);
			const oneof = extend || message || enumDecl ? null : RE_ONEOF.exec(code);
			const service =
				extend || message || enumDecl || oneof ? null : RE_SERVICE.exec(code);

			if (extend) {
				const extendee = extend[1].replace(/^\.?google\.protobuf\./, "");
				stack.push({
					kind: "extend",
					fqn: join(packageName, extendee),
					closeDepth: depthBefore,
					target: EXTENDEE_TARGETS[extendee],
					blockDoc: splitComment(leadingComment(lines, i)),
					fields: [],
					line: i,
				});
			} else if (message) {
				stack.push({
					kind: "message",
					fqn: join(scopePrefix(), message[1]),
					closeDepth: depthBefore,
					fields: [],
					line: i,
				});
			} else if (enumDecl) {
				stack.push({
					kind: "enum",
					fqn: join(scopePrefix(), enumDecl[1]),
					closeDepth: depthBefore,
					values: [],
					line: i,
				});
			} else if (oneof) {
				stack.push({
					kind: "oneof",
					fqn: join(scopePrefix(), oneof[1]),
					closeDepth: depthBefore,
					line: i,
				});
			} else if (service) {
				stack.push({
					kind: "service",
					fqn: join(scopePrefix(), service[1]),
					closeDepth: depthBefore,
					line: i,
				});
			} else {
				const owner = ownerFrame();
				if (owner?.kind === "enum") {
					const value = RE_ENUM_VALUE.exec(code);
					if (value) {
						const doc = splitComment(leadingComment(lines, i));
						owner.values?.push({
							name: value[1],
							number: Number(value[2]),
							doc: doc.prose || undefined,
							line: i,
						});
					}
				} else if (owner) {
					const field = RE_FIELD.exec(code);
					if (field && !FIELD_NON_TYPES.has(field[2])) {
						const doc = splitComment(leadingComment(lines, i));
						const entry: RawField = {
							name: field[3],
							type: field[2].replace(/\s+/g, ""),
							number: Number(field[4]),
							repeated: field[1] === "repeated",
							doc: doc.prose || undefined,
							line: i,
						};
						owner.fields?.push(entry);
						if (owner.kind === "extend" && owner.target) {
							annotations.push({
								fqn: join(packageName, entry.name),
								name: entry.name,
								namespace: packageName,
								target: owner.target,
								type: entry.type,
								number: entry.number,
								repeated: entry.repeated,
								doc: doc.prose || owner.blockDoc?.prose || undefined,
								example: doc.code || owner.blockDoc?.code || undefined,
								importPath: ctx.importPath,
								fileId: ctx.fileId,
								line: i,
							});
						}
					}
				}
			}
		}

		depth += braceDelta(code);
		while (stack.length > 0 && depth <= stack[stack.length - 1].closeDepth) {
			const frame = stack.pop();
			if (!frame) {
				break;
			}
			if (frame.kind === "message" && frame.fields) {
				messages.push({
					fqn: frame.fqn,
					fields: frame.fields,
					fileId: ctx.fileId,
					line: frame.line,
				});
			} else if (frame.kind === "enum" && frame.values) {
				enums.push({
					fqn: frame.fqn,
					values: frame.values,
					fileId: ctx.fileId,
					line: frame.line,
				});
			}
		}
	}

	// A file that ends mid-block (an editor buffer mid-edit) still yields what
	// it declared so far.
	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) {
			break;
		}
		if (frame.kind === "message" && frame.fields) {
			messages.push({
				fqn: frame.fqn,
				fields: frame.fields,
				fileId: ctx.fileId,
				line: frame.line,
			});
		} else if (frame.kind === "enum" && frame.values) {
			enums.push({
				fqn: frame.fqn,
				values: frame.values,
				fileId: ctx.fileId,
				line: frame.line,
			});
		}
	}

	return {
		fileId: ctx.fileId,
		importPath: ctx.importPath,
		path: ctx.path,
		packageName,
		imports,
		annotations,
		messages,
		enums,
	};
}
