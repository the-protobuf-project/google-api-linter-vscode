/**
 * Text-in, plain-data-out `.proto` parser for the index.
 *
 * This is deliberately *not* `src/utils/protoParser.ts`: that one takes a
 * `vscode.TextDocument`, which is the leak this rewrite removes. This parser
 * takes a string and returns arrays of plain objects, so it runs under plain
 * node, in tests and in benchmarks with no extension host anywhere.
 *
 * Two bugs in the old parser are fixed here on purpose:
 *
 *  1. Nested enums were tagged `kind: "enumValue"`. A nested `enum` is an
 *     `enum`.
 *  2. Names were not package-scoped, so `Patient` in `fhir.r4` and `Patient` in
 *     `fhir.r5` were the same symbol. Every name produced here is qualified by
 *     the file's `package` plus its enclosing declarations.
 *
 * Every string returned has been through {@link flattenString}, so storing it
 * cannot retain the source text.
 */

import { flattenString } from "./strings";
import type { SymbolKind } from "./types";

/** Scalar field types, which are never recorded as type references. */
const SCALARS = new Set([
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
	"bool",
	"string",
	"bytes",
	"group",
]);

/** Line-leading keywords that can never start a field declaration. */
const NON_FIELD_KEYWORDS = new Set([
	"option",
	"reserved",
	"extensions",
	"returns",
	"rpc",
	"message",
	"enum",
	"service",
	"extend",
	"oneof",
	"import",
	"package",
	"syntax",
	"edition",
	"public",
	"weak",
	"to",
	"max",
]);

const RE_PACKAGE = /^(\s*package\s+)([A-Za-z_][\w.]*)\s*;/;
const RE_IMPORT = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/;
const RE_DECL = /^(\s*(message|enum|service|extend)\s+)([A-Za-z_][\w.]*)/;
const RE_ONEOF = /^\s*oneof\s+[A-Za-z_]\w*/;
const RE_RPC =
	/^(\s*rpc\s+)([A-Za-z_]\w*)(\s*\(\s*)(?:stream\s+)?([.\w]+)(\s*\)\s*returns\s*\(\s*)(?:stream\s+)?([.\w]+)/;
const RE_MAP_FIELD =
	/^(\s*map\s*<\s*)([.\w]+)(\s*,\s*)([.\w]+)(\s*>\s+)([A-Za-z_]\w*)\s*=\s*\d+/;
const RE_FIELD =
	/^(\s*(?:(?:repeated|optional|required)\s+)?)([.\w]+)(\s+)([A-Za-z_]\w*)\s*=\s*\d+/;
const RE_ENUM_VALUE = /^(\s*)([A-Za-z_]\w*)\s*=\s*-?\d+/;

/** One declaration found in a file, with positions relative to the file. */
export interface ParsedSymbol {
	readonly name: string;
	readonly kind: SymbolKind;
	/** 0-based. */
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
	/**
	 * Fully-qualified name of the enclosing container: the parent declaration
	 * for nested symbols, otherwise the file's package (`""` when it has none).
	 */
	readonly container: string;
	readonly detail?: string;
	readonly doc?: string;
}

/** One use of a named type, as written at the use site. */
export interface ParsedReference {
	readonly typeName: string;
	/** Fully-qualified name of the innermost enclosing container. */
	readonly scope: string;
	/** 0-based. */
	readonly line: number;
	readonly startCol: number;
	readonly endCol: number;
}

/** Everything the index keeps from one file. The text itself is dropped. */
export interface ParsedFile {
	readonly packageName: string;
	readonly imports: string[];
	readonly symbols: ParsedSymbol[];
	readonly references: ParsedReference[];
	readonly lineCount: number;
}

/** Knobs the memory ladder turns down as tiers degrade. */
export interface ParseOptions {
	/** Record `field`, `enumValue` and `rpc` declarations. Off in `reduced`. */
	readonly keepMembers: boolean;
	/** Record leading `//` comments. Off in `reduced`. */
	readonly keepDocs: boolean;
}

/** Brace-depth frame. `fqn` is what child declarations hang off. */
interface Frame {
	readonly fqn: string;
	/** What kind of body this is, which decides how its lines are read. */
	readonly body: "message" | "enum" | "service" | "other";
}

/**
 * Finds the start of a line comment, ignoring `//` inside a string literal.
 * @param line - One source line
 * @returns Index of the comment marker, or -1
 */
function lineCommentAt(line: string): number {
	let quote = 0;
	for (let i = 0; i < line.length - 1; i++) {
		const ch = line.charCodeAt(i);
		if (ch === 92 /* \ */) {
			i++;
			continue;
		}
		if (ch === 34 /* " */ || ch === 39 /* ' */) {
			if (quote === 0) {
				quote = ch;
			} else if (quote === ch) {
				quote = 0;
			}
			continue;
		}
		if (quote === 0 && ch === 47 /* / */ && line.charCodeAt(i + 1) === 47) {
			return i;
		}
	}
	return -1;
}

/**
 * Parses one `.proto` file.
 *
 * The parser is a single line-oriented pass with a brace stack; it is not a
 * grammar-complete protobuf front end. It is exact for declaration names,
 * nesting and type references, which is everything the index stores.
 *
 * @param text - Full file contents
 * @param options - Tier-driven detail level
 * @returns Declarations, references, imports and the package name
 */
export function parseProtoText(
	text: string,
	options: ParseOptions,
): ParsedFile {
	const lines = text.split("\n");
	const symbols: ParsedSymbol[] = [];
	const references: ParsedReference[] = [];
	const imports: string[] = [];
	const stack: Frame[] = [];

	let packageName = "";
	let pending: Frame | undefined;
	let doc: string[] | undefined;
	let inBlockComment = false;

	const container = (): string =>
		stack.length > 0 ? stack[stack.length - 1].fqn : packageName;
	const bodyKind = (): Frame["body"] =>
		stack.length > 0 ? stack[stack.length - 1].body : "other";

	const qualify = (name: string): string => {
		const parent = container();
		return parent ? `${parent}.${name}` : name;
	};

	const takeDoc = (): string | undefined => {
		if (!options.keepDocs || doc === undefined || doc.length === 0) {
			return undefined;
		}
		const joined = doc.join("\n").trim();
		doc = undefined;
		return joined.length > 0 ? flattenString(joined) : undefined;
	};

	const addReference = (
		typeName: string,
		line: number,
		startCol: number,
	): void => {
		if (SCALARS.has(typeName)) {
			return;
		}
		references.push({
			typeName: flattenString(typeName),
			scope: flattenString(container()),
			line,
			startCol,
			endCol: startCol + typeName.length,
		});
	};

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		let line = lines[lineNo];
		if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
			line = line.slice(0, -1);
		}

		if (inBlockComment) {
			const end = line.indexOf("*/");
			if (end < 0) {
				continue;
			}
			line = " ".repeat(end + 2) + line.slice(end + 2);
			inBlockComment = false;
		}

		// Leading `//` comments accumulate as the doc for the next declaration.
		const commentAt = lineCommentAt(line);
		if (commentAt >= 0) {
			const before = line.slice(0, commentAt);
			if (before.trim().length === 0) {
				if (options.keepDocs) {
					if (doc === undefined) {
						doc = [];
					}
					doc.push(line.slice(commentAt + 2).trim());
				}
				continue;
			}
			line = before;
		}

		const blockAt = line.indexOf("/*");
		if (blockAt >= 0) {
			const close = line.indexOf("*/", blockAt + 2);
			if (close < 0) {
				inBlockComment = true;
				line = line.slice(0, blockAt);
			} else {
				line =
					line.slice(0, blockAt) +
					" ".repeat(close + 2 - blockAt) +
					line.slice(close + 2);
			}
		}

		if (line.trim().length === 0) {
			doc = undefined;
			continue;
		}

		if (packageName === "") {
			const pkg = RE_PACKAGE.exec(line);
			if (pkg) {
				packageName = flattenString(pkg[2]);
				doc = undefined;
				continue;
			}
		}

		const imp = RE_IMPORT.exec(line);
		if (imp) {
			imports.push(flattenString(imp[1]));
			doc = undefined;
			continue;
		}

		const decl = RE_DECL.exec(line);
		if (decl) {
			const keyword = decl[2] as "message" | "enum" | "service" | "extend";
			const written = decl[3];
			const startCol = decl[1].length;
			// `extend google.protobuf.MessageOptions` names another file's type;
			// the symbol is recorded under its last segment, and the extendee is
			// a type reference.
			const dot = written.lastIndexOf(".");
			const name = dot < 0 ? written : written.slice(dot + 1);
			const fqn = qualify(name);
			symbols.push({
				name: flattenString(name),
				kind: keyword,
				line: lineNo,
				startCol: dot < 0 ? startCol : startCol + dot + 1,
				endCol: startCol + written.length,
				container: flattenString(container()),
				detail: keyword === "extend" ? flattenString(written) : undefined,
				doc: takeDoc(),
			});
			if (keyword === "extend") {
				addReference(written, lineNo, startCol);
			}
			// An `extend` body holds extension fields whose names are scoped to
			// the enclosing package, not to the extendee, so it stays transparent.
			pending = {
				fqn: keyword === "extend" ? container() : fqn,
				body:
					keyword === "enum"
						? "enum"
						: keyword === "service"
							? "service"
							: "message",
			};
		} else if (RE_ONEOF.test(line)) {
			// `oneof` is a grouping, not a namespace: its fields belong to the
			// enclosing message.
			pending = { fqn: container(), body: "message" };
		} else {
			const body = bodyKind();
			if (body === "service" && options.keepMembers) {
				const rpc = RE_RPC.exec(line);
				if (rpc) {
					const nameCol = rpc[1].length;
					const reqCol = nameCol + rpc[2].length + rpc[3].length;
					const respCol = reqCol + rpc[4].length + rpc[5].length;
					symbols.push({
						name: flattenString(rpc[2]),
						kind: "rpc",
						line: lineNo,
						startCol: nameCol,
						endCol: nameCol + rpc[2].length,
						container: flattenString(container()),
						detail: flattenString(`(${rpc[4]}) returns (${rpc[6]})`),
						doc: takeDoc(),
					});
					addReference(rpc[4], lineNo, reqCol);
					addReference(rpc[6], lineNo, respCol);
					pending = { fqn: container(), body: "other" };
				}
			} else if (body === "service") {
				const rpc = RE_RPC.exec(line);
				if (rpc) {
					const nameCol = rpc[1].length;
					const reqCol = nameCol + rpc[2].length + rpc[3].length;
					addReference(rpc[4], lineNo, reqCol);
					addReference(rpc[6], lineNo, reqCol + rpc[4].length + rpc[5].length);
					pending = { fqn: container(), body: "other" };
				}
			} else if (body === "enum") {
				const value = RE_ENUM_VALUE.exec(line);
				if (value && options.keepMembers) {
					symbols.push({
						name: flattenString(value[2]),
						kind: "enumValue",
						line: lineNo,
						startCol: value[1].length,
						endCol: value[1].length + value[2].length,
						container: flattenString(container()),
						doc: takeDoc(),
					});
				}
			} else if (body === "message") {
				const map = RE_MAP_FIELD.exec(line);
				if (map) {
					const keyCol = map[1].length;
					const valueCol = keyCol + map[2].length + map[3].length;
					const nameCol = valueCol + map[4].length + map[5].length;
					addReference(map[2], lineNo, keyCol);
					addReference(map[4], lineNo, valueCol);
					if (options.keepMembers) {
						symbols.push({
							name: flattenString(map[6]),
							kind: "field",
							line: lineNo,
							startCol: nameCol,
							endCol: nameCol + map[6].length,
							container: flattenString(container()),
							detail: flattenString(`map<${map[2]}, ${map[4]}>`),
							doc: takeDoc(),
						});
					}
				} else {
					const field = RE_FIELD.exec(line);
					if (field && !NON_FIELD_KEYWORDS.has(field[2])) {
						const typeCol = field[1].length;
						const nameCol = typeCol + field[2].length + field[3].length;
						addReference(field[2], lineNo, typeCol);
						if (options.keepMembers) {
							symbols.push({
								name: flattenString(field[4]),
								kind: "field",
								line: lineNo,
								startCol: nameCol,
								endCol: nameCol + field[4].length,
								container: flattenString(container()),
								detail: flattenString(field[2]),
								doc: takeDoc(),
							});
						}
					}
				}
			}
		}

		// Brace bookkeeping last: a declaration and its `{` usually share a line.
		for (let i = 0; i < line.length; i++) {
			const ch = line.charCodeAt(i);
			if (ch === 123 /* { */) {
				stack.push(pending ?? { fqn: container(), body: "other" });
				pending = undefined;
			} else if (ch === 125 /* } */) {
				stack.pop();
			}
		}
		doc = undefined;
	}

	return {
		packageName,
		imports,
		symbols,
		references,
		lineCount: lines.length,
	};
}
