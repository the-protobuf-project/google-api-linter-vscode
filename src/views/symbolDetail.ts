/**
 * Builds the payload the Details panel renders for one selected symbol.
 *
 * Three sources are joined here and nowhere else:
 *
 *   1. The in-memory {@link ProtoIndex} supplies structure — what a symbol is,
 *      where it starts, and what it contains.
 *   2. The diagnostic collection supplies findings, which carry a range but no
 *      idea which symbol they belong to. Attribution is this file's job.
 *   3. The file's own text supplies option values, which the index does not
 *      store: it records the `extend` blocks that *declare* custom options, not
 *      the places that *apply* them.
 *
 * Exactly one file is read, for the selection the user just made. That is a
 * deliberate boundary: reading a file per selection is fine, and reading one
 * per symbol in a loop is what previously grew the extension host to ~60 GB.
 */

import * as vscode from "vscode";
import { DIAGNOSTIC_SOURCE } from "../constants";
import type { IndexedSymbol, ProtoIndex } from "../index/types";
import type {
	AnnotationDetail,
	AnnotationKey,
	FieldDetail,
	Loc,
	ProblemDetail,
	RpcDetail,
	SymbolDetail,
} from "../shared/protocol";

/**
 * Keys `google.api.resource` can carry, in the order AIP-123 presents them.
 *
 * Listed so the panel can show a key as *absent* rather than simply omitting
 * it — "singular is not set" is the finding, and a UI that renders only what
 * exists can never say it.
 */
const RESOURCE_KEYS = [
	"type",
	"pattern",
	"singular",
	"plural",
	"name_field",
	"history",
	"style",
] as const;

/** Matches `name = 3` or `repeated Foo bar = 3`, capturing through the `=`. */
const FIELD_RE =
	/^\s*(?:(repeated|optional|required)\s+)?([A-Za-z_][\w.]*(?:\s*<[^>]*>)?)\s+([A-Za-z_]\w*)\s*=\s*(\d+)/;

/** Matches `rpc Name(Req) returns (Res)`, tolerating `stream` on either side. */
const RPC_RE =
	/^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/;

/** Matches an enum value `NAME = 0`. */
const ENUM_VALUE_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*;/;

/** Matches `(google.api.field_behavior) = REQUIRED`, any spacing. */
const BEHAVIOR_RE = /\(\s*google\.api\.field_behavior\s*\)\s*=\s*(\w+)/g;

/** Matches the opening of an applied custom option: `option (foo.bar) = `. */
const OPTION_OPEN_RE = /^\s*option\s*\(\s*([\w.]+)\s*\)\s*=\s*(.*)$/;

/** Matches `key: value` inside an option body. */
const OPTION_KEY_RE = /^\s*([a-z_]\w*)\s*:\s*(.+?)\s*$/;

/** Matches an `(google.api.http)` verb line, e.g. `post: "/v1/books"`. */
const HTTP_VERB_RE =
	/^\s*(get|put|post|delete|patch|custom)\s*:\s*"([^"]*)"\s*$/;

/**
 * The line range a symbol occupies.
 *
 * The index stores only a declaration line, so the end is derived: a symbol
 * owns every line up to the next declaration that is not nested inside it.
 * Comparing fully-qualified names rather than counting braces means a comment
 * or string containing `}` cannot throw the span off.
 *
 * @param symbols - Every symbol in the file, any order
 * @param target - The symbol to measure
 * @param lineCount - Total lines in the file, used for the last symbol
 * @returns Inclusive `[start, end]` zero-based line numbers
 */
export function symbolSpan(
	symbols: readonly IndexedSymbol[],
	target: IndexedSymbol,
	lineCount: number,
): [number, number] {
	const prefix = `${target.fqn}.`;
	let end = lineCount - 1;
	for (const symbol of symbols) {
		if (symbol.line <= target.line || symbol.fqn === target.fqn) {
			continue;
		}
		// A descendant lives inside the span; anything else closes it.
		if (symbol.fqn.startsWith(prefix)) {
			continue;
		}
		end = Math.min(end, symbol.line - 1);
	}
	return [target.line, Math.max(target.line, end)];
}

/**
 * The part of a `vscode.Diagnostic` this file reads.
 *
 * Declared structurally rather than importing the class: nothing here needs a
 * `Range`'s methods, only where it starts, and a narrower parameter says so in
 * the signature instead of in a comment.
 */
export interface FindingLike {
	readonly range: {
		readonly start: { readonly line: number; readonly character: number };
	};
	readonly message: string;
	/** Optional: not every producer sets one, and the default is Error. */
	readonly severity?: vscode.DiagnosticSeverity;
	readonly source?: string;
	readonly code?: unknown;
}

/** True when a diagnostic came from this extension's linter. */
function isOurs(diagnostic: FindingLike): boolean {
	return diagnostic.source === DIAGNOSTIC_SOURCE;
}

/** The rule id carried on a diagnostic's `code`, when it has one. */
function ruleIdOf(diagnostic: FindingLike): string {
	const code = diagnostic.code;
	if (typeof code === "string") {
		return code;
	}
	if (typeof code === "number") {
		return String(code);
	}
	if (code && typeof code === "object" && "value" in code) {
		return String((code as { value: string | number }).value);
	}
	return "unknown";
}

/** The documentation URL on a diagnostic's `code`, when it has one. */
function docUrlOf(diagnostic: FindingLike): string | undefined {
	const code = diagnostic.code;
	if (code && typeof code === "object" && "target" in code) {
		const target = (code as { target?: vscode.Uri }).target;
		return target ? target.toString() : undefined;
	}
	return undefined;
}

/** Maps VS Code severities onto the three the panel renders. */
function severityOf(
	severity: vscode.DiagnosticSeverity | undefined,
): ProblemDetail["severity"] {
	if (severity === undefined) {
		return "error";
	}
	if (severity === vscode.DiagnosticSeverity.Error) {
		return "error";
	}
	if (severity === vscode.DiagnosticSeverity.Warning) {
		return "warning";
	}
	return "info";
}

/**
 * Findings inside a line span, collapsed by rule.
 *
 * `api-linter` reports several rules once per field, so a message that is
 * really one problem arrives as eight. Collapsing by rule id and counting keeps
 * the list readable while `occurrences` and `lines` preserve the detail.
 *
 * @param diagnostics - Every diagnostic on the file
 * @param span - Inclusive line range to attribute
 * @param path - Absolute file path, for the resulting locations
 * @returns Collapsed findings, most occurrences first
 */
export function attributeProblems(
	diagnostics: readonly FindingLike[],
	span: readonly [number, number],
	path: string,
): ProblemDetail[] {
	// The protocol type is deeply readonly — correct for something crossing a
	// process boundary, but this function accumulates before it publishes.
	type Building = Omit<ProblemDetail, "occurrences" | "lines"> & {
		occurrences: number;
		lines: number[];
	};
	const byRule = new Map<string, Building>();
	for (const diagnostic of diagnostics) {
		if (!isOurs(diagnostic)) {
			continue;
		}
		const line = diagnostic.range.start.line;
		if (line < span[0] || line > span[1]) {
			continue;
		}
		const ruleId = ruleIdOf(diagnostic);
		const existing = byRule.get(ruleId);
		if (existing) {
			existing.occurrences += 1;
			if (!existing.lines.includes(line)) {
				existing.lines.push(line);
			}
			continue;
		}
		byRule.set(ruleId, {
			ruleId,
			message: diagnostic.message,
			docUrl: docUrlOf(diagnostic),
			severity: severityOf(diagnostic.severity),
			loc: { path, line, character: diagnostic.range.start.character },
			occurrences: 1,
			lines: [line],
		});
	}
	const out = [...byRule.values()];
	for (const problem of out) {
		problem.lines.sort((a, b) => a - b);
	}
	// Most-repeated first: the rule firing eight times is the one worth reading.
	out.sort(
		(a, b) => b.occurrences - a.occurrences || a.ruleId.localeCompare(b.ruleId),
	);
	return out;
}

/** Problems whose line falls exactly on one line. Used for per-field counts. */
function countOnLine(
	diagnostics: readonly FindingLike[],
	line: number,
): number {
	let count = 0;
	for (const diagnostic of diagnostics) {
		if (isOurs(diagnostic) && diagnostic.range.start.line === line) {
			count += 1;
		}
	}
	return count;
}

/**
 * The full text of one declaration, following a trailing `[` option block.
 *
 * A field's `field_behavior` is routinely written across several lines, so
 * reading only the declaration line finds no behaviour and reports every such
 * field as unset — the opposite of the truth.
 *
 * @param lines - The file, split on newlines
 * @param start - Index of the declaration's first line
 * @returns The joined declaration and the index of its last line
 */
function declarationText(
	lines: readonly string[],
	start: number,
): { text: string; end: number } {
	let text = lines[start] ?? "";
	let end = start;
	let depth =
		(text.match(/\[/g)?.length ?? 0) - (text.match(/\]/g)?.length ?? 0);
	while (depth > 0 && end + 1 < lines.length) {
		end += 1;
		const line = lines[end] ?? "";
		text += `\n${line}`;
		depth +=
			(line.match(/\[/g)?.length ?? 0) - (line.match(/\]/g)?.length ?? 0);
	}
	return { text, end };
}

/** Every `field_behavior` value in a declaration, in source order. */
function behaviorsIn(declaration: string): string[] {
	const out: string[] = [];
	BEHAVIOR_RE.lastIndex = 0;
	let match = BEHAVIOR_RE.exec(declaration);
	while (match) {
		out.push(match[1]);
		match = BEHAVIOR_RE.exec(declaration);
	}
	return out;
}

/**
 * Fields declared directly inside a span.
 *
 * Nested messages are skipped by brace depth: only depth 1 relative to the
 * owning declaration is this message's own.
 */
function parseFields(
	lines: readonly string[],
	span: readonly [number, number],
	path: string,
	diagnostics: readonly FindingLike[],
): FieldDetail[] {
	const out: FieldDetail[] = [];
	let depth = 0;
	for (let i = span[0]; i <= span[1] && i < lines.length; i++) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();
		const opens = line.match(/\{/g)?.length ?? 0;
		const closes = line.match(/\}/g)?.length ?? 0;

		// Only direct members count, and only outside comments and options.
		if (
			depth === 1 &&
			!trimmed.startsWith("//") &&
			!trimmed.startsWith("option") &&
			!trimmed.startsWith("reserved")
		) {
			const match = FIELD_RE.exec(line);
			if (match) {
				const { text, end } = declarationText(lines, i);
				out.push({
					name: match[3],
					type: match[2].replace(/\s+/g, ""),
					number: Number(match[4]),
					repeated: match[1] === "repeated",
					behaviors: behaviorsIn(text),
					loc: { path, line: i, character: line.indexOf(match[3]) },
					problemCount: countOnLine(diagnostics, i),
				});
				// Skip the option block so its inner lines are not re-scanned.
				i = end;
				continue;
			}
		}
		depth += opens - closes;
	}
	return out;
}

/** RPCs declared directly inside a service span. */
function parseRpcs(
	lines: readonly string[],
	span: readonly [number, number],
	path: string,
	diagnostics: readonly FindingLike[],
): RpcDetail[] {
	const out: RpcDetail[] = [];
	for (let i = span[0]; i <= span[1] && i < lines.length; i++) {
		const match = RPC_RE.exec(lines[i] ?? "");
		if (!match) {
			continue;
		}
		// An rpc body may carry `google.api.http`; look ahead until it closes.
		let httpRule: string | undefined;
		let depth =
			(lines[i]?.match(/\{/g)?.length ?? 0) -
			(lines[i]?.match(/\}/g)?.length ?? 0);
		let j = i;
		while (depth > 0 && j + 1 <= span[1] && j + 1 < lines.length) {
			j += 1;
			const inner = lines[j] ?? "";
			const verb = HTTP_VERB_RE.exec(inner);
			if (verb && !httpRule) {
				httpRule = `${verb[1].toUpperCase()} ${verb[2]}`;
			}
			depth +=
				(inner.match(/\{/g)?.length ?? 0) - (inner.match(/\}/g)?.length ?? 0);
		}
		out.push({
			name: match[1],
			requestType: match[3],
			responseType: match[5],
			clientStreaming: Boolean(match[2]),
			serverStreaming: Boolean(match[4]),
			httpRule,
			loc: { path, line: i, character: (lines[i] ?? "").indexOf(match[1]) },
			problemCount: countOnLine(diagnostics, i),
		});
		i = j;
	}
	return out;
}

/** Enum values declared directly inside an enum span. */
function parseEnumValues(
	lines: readonly string[],
	span: readonly [number, number],
): { name: string; number: number }[] {
	const out: { name: string; number: number }[] = [];
	for (let i = span[0] + 1; i <= span[1] && i < lines.length; i++) {
		const match = ENUM_VALUE_RE.exec(lines[i] ?? "");
		if (match) {
			out.push({ name: match[1], number: Number(match[2]) });
		}
	}
	return out;
}

/**
 * Which absent option key a rule is complaining about.
 *
 * Derived from the rule id rather than a hardcoded table: AIP rule names end in
 * the thing they want, so `core::0123::resource-singular` is asking for
 * `singular`. New rules therefore link themselves without a code change.
 */
function keyForRule(
	ruleId: string,
	keys: readonly string[],
): string | undefined {
	const tail = ruleId.split("::").pop() ?? "";
	// Longest match first, so `name_field` wins over `name`.
	return [...keys]
		.sort((a, b) => b.length - a.length)
		.find((key) => tail.endsWith(key.replace(/_/g, "-")) || tail.endsWith(key));
}

/**
 * Custom options applied to the declaration at the top of a span.
 *
 * Absent keys matter as much as present ones, so for a known option the full
 * key list is returned with `value` left undefined where nothing was written,
 * and any finding that names that key attached as `requiredBy`.
 */
function parseAnnotations(
	lines: readonly string[],
	span: readonly [number, number],
	problems: readonly ProblemDetail[],
): AnnotationDetail[] {
	const out: AnnotationDetail[] = [];
	for (let i = span[0]; i <= span[1] && i < lines.length; i++) {
		const open = OPTION_OPEN_RE.exec(lines[i] ?? "");
		if (!open) {
			continue;
		}
		const name = open[1];
		const written = new Map<string, string>();

		if (open[2].includes("{")) {
			let depth =
				(open[2].match(/\{/g)?.length ?? 0) -
				(open[2].match(/\}/g)?.length ?? 0);
			let j = i;
			while (depth > 0 && j + 1 <= span[1] && j + 1 < lines.length) {
				j += 1;
				const inner = lines[j] ?? "";
				const pair = OPTION_KEY_RE.exec(inner);
				if (pair) {
					written.set(pair[1], pair[2].replace(/[,;]$/, ""));
				}
				depth +=
					(inner.match(/\{/g)?.length ?? 0) - (inner.match(/\}/g)?.length ?? 0);
			}
			i = j;
		} else {
			// Scalar form: `option (google.api.default_host) = "example.com";`
			written.set("value", open[2].replace(/[;]$/, "").trim());
		}

		const known = name === "google.api.resource" ? RESOURCE_KEYS : undefined;
		const keyNames = known ?? [...written.keys()];
		const keys: AnnotationKey[] = keyNames.map((key) => {
			const value = written.get(key);
			if (value !== undefined) {
				return { key, value };
			}
			const blame = problems.find(
				(p) => keyForRule(p.ruleId, keyNames) === key,
			);
			return {
				key,
				requiredBy: blame?.ruleId,
				requiredByUrl: blame?.docUrl,
			};
		});
		// A key nothing wrote and no rule wants is noise, not information.
		out.push({
			name,
			keys: keys.filter(
				(k) => k.value !== undefined || k.requiredBy !== undefined,
			),
		});
	}
	return out;
}

/**
 * Assemble the Details payload for one symbol.
 *
 * @param index - The workspace index
 * @param fqn - Fully-qualified name of the selected symbol
 * @param diagnostics - The diagnostic collection to attribute findings from
 * @returns The payload, or `null` when the symbol is not indexed
 */
export async function buildSymbolDetail(
	index: ProtoIndex,
	fqn: string,
	diagnostics: vscode.DiagnosticCollection,
): Promise<SymbolDetail | null> {
	const symbol = index.symbol(fqn);
	if (!symbol) {
		return null;
	}
	const file = index.file(symbol.fileId);
	if (!file) {
		return null;
	}
	const path = file.path;
	const uri = vscode.Uri.file(path);

	let text: string;
	try {
		// One read, for one selection. See the note at the top of this file.
		text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
			"utf8",
		);
	} catch {
		return null;
	}
	const lines = text.split(/\r?\n/);

	const inFile = index.symbolsInFile(symbol.fileId);
	const span = symbolSpan(inFile, symbol, lines.length);
	const fileDiagnostics = diagnostics.get(uri) ?? [];
	const problems = attributeProblems(fileDiagnostics, span, path);

	const kind = symbol.kind as SymbolDetail["kind"];
	const isMessage = kind === "message";
	const isService = kind === "service";
	const isEnum = kind === "enum";

	const annotations = parseAnnotations(lines, span, problems);
	const loc: Loc = { path, line: symbol.line, character: symbol.startCol };

	return {
		name: symbol.name,
		fqn: symbol.fqn,
		kind,
		package: file.packageName,
		loc,
		doc: symbol.doc,
		isResource: annotations.some((a) => a.name === "google.api.resource"),
		fields: isMessage ? parseFields(lines, span, path, fileDiagnostics) : [],
		rpcs: isService ? parseRpcs(lines, span, path, fileDiagnostics) : [],
		enumValues: isEnum ? parseEnumValues(lines, span) : [],
		annotations,
		problems,
		problemTotal: problems.reduce((sum, p) => sum + p.occurrences, 0),
	};
}
