/**
 * Where a fix goes in the file.
 *
 * Split from `rules.ts` because deciding *what* to write and deciding *where*
 * fail differently. What to write is settled by the linter's own message;
 * where is a judgement about surrounding text, and it is the half that can
 * corrupt a schema. Every function here returns undefined when the placement is
 * not certain, which is always better than an edit a reviewer has to catch.
 *
 * Text is taken as lines rather than a `TextDocument`, so the placement rules
 * are testable without an extension host.
 */

import type { FixKind } from "./rules";

/** A single-line insertion: text to put at the start of `line`. */
export interface LineInsert {
	readonly kind: "insertLine";
	/** 0-based line the new line is inserted before. */
	readonly line: number;
	readonly text: string;
}

/** A replacement of one line, for edits made inside an existing construct. */
export interface LineReplace {
	readonly kind: "replaceLine";
	/** 0-based line to replace. */
	readonly line: number;
	readonly text: string;
}

/** What an edit does to the document. */
export type TextChange = LineInsert | LineReplace;

/** The indentation of a line, as written. */
function indentOf(line: string): string {
	return /^\s*/.exec(line)?.[0] ?? "";
}

/** True when a line is a comment or blank, and so carries no declaration. */
function isTrivia(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length === 0 || trimmed.startsWith("//");
}

/**
 * Where a file-scope option belongs: after the last one already there.
 *
 * Grouping them keeps a file readable, and matches what every proto in
 * googleapis does. With no options at all, the block goes after `package`,
 * which is the only anchor guaranteed to exist above the first declaration.
 */
export function fileOptionInsertion(
	lines: readonly string[],
	option: string,
	value: string,
): TextChange | undefined {
	let lastOption = -1;
	let packageLine = -1;
	let depth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isTrivia(line)) {
			continue;
		}
		// Only file scope counts: an option inside a message is not one of these.
		if (depth === 0) {
			if (/^\s*option\s+[\w.]+\s*=/.test(line)) {
				lastOption = i;
			} else if (/^\s*package\s+[\w.]+\s*;/.test(line)) {
				packageLine = i;
			}
		}
		depth +=
			(line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
	}

	const text = `option ${option} = ${value};`;
	if (lastOption >= 0) {
		return { kind: "insertLine", line: lastOption + 1, text };
	}
	if (packageLine >= 0) {
		// A blank line keeps the new block off the package statement, which is
		// how every file in googleapis is written.
		return { kind: "insertLine", line: packageLine + 1, text: `\n${text}` };
	}
	return undefined;
}

/**
 * The line a field's declaration ends on, following a trailing `[...]`.
 *
 * Field options are routinely written across several lines, so the `;` is not
 * reliably on the line the declaration starts on.
 */
function fieldEnd(lines: readonly string[], start: number): number {
	let depth = 0;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		depth += (line.match(/\[/g)?.length ?? 0) - (line.match(/]/g)?.length ?? 0);
		if (depth <= 0 && line.includes(";")) {
			return i;
		}
	}
	return start;
}

/**
 * Adds an option to a field, into its existing `[...]` when it has one.
 *
 * @param lines - The file
 * @param field - Field name, e.g. `create_time`
 * @param option - e.g. `(google.api.field_behavior)`
 * @param value - e.g. `OUTPUT_ONLY`
 * @param near - Line the finding pointed at, to disambiguate a repeated name
 */
export function fieldOptionChange(
	lines: readonly string[],
	field: string,
	option: string,
	value: string,
	near?: number,
): TextChange | undefined {
	// The same field name appears in many messages of one file — `name` is in
	// every request type — so the finding's own line decides which is meant.
	const declaration = new RegExp(
		`^\\s*(?:repeated\\s+|optional\\s+)?[\\w.]+(?:\\s*<[^>]*>)?\\s+${field}\\s*=\\s*\\d+`,
	);
	let start = -1;
	if (
		near !== undefined &&
		near < lines.length &&
		declaration.test(lines[near])
	) {
		start = near;
	} else {
		for (let i = 0; i < lines.length; i++) {
			if (declaration.test(lines[i])) {
				start = i;
				break;
			}
		}
	}
	if (start < 0) {
		return undefined;
	}

	const end = fieldEnd(lines, start);
	// A field spanning lines has an options block whose interior this would have
	// to reflow; appending to the single-line form is unambiguous, and the
	// multi-line case is left alone rather than reformatted.
	if (end !== start) {
		return undefined;
	}

	const line = lines[start];
	const assignment = `${option} = ${value}`;

	if (line.includes("[")) {
		if (line.includes(assignment)) {
			return undefined;
		}
		const close = line.lastIndexOf("]");
		if (close < 0) {
			return undefined;
		}
		return {
			kind: "replaceLine",
			line: start,
			text: `${line.slice(0, close)}, ${assignment}${line.slice(close)}`,
		};
	}

	const semicolon = line.lastIndexOf(";");
	if (semicolon < 0) {
		return undefined;
	}
	return {
		kind: "replaceLine",
		line: start,
		text: `${line.slice(0, semicolon)} [${assignment}]${line.slice(semicolon)}`,
	};
}

/**
 * Adds an option inside an rpc body, opening one when the rpc has none.
 *
 * @param lines - The file
 * @param rpcLine - Line the rpc is declared on
 */
export function methodOptionChange(
	lines: readonly string[],
	rpcLine: number,
	option: string,
	value: string,
): TextChange | undefined {
	const line = lines[rpcLine];
	if (line === undefined || !/^\s*rpc\s+\w+/.test(line)) {
		return undefined;
	}
	const indent = indentOf(line);
	const body = `${indent}  option ${option} = ${value};`;

	if (line.includes("{")) {
		return { kind: "insertLine", line: rpcLine + 1, text: body };
	}
	// `rpc A(R) returns (S);` has to become a block to hold an option.
	const semicolon = line.lastIndexOf(";");
	if (semicolon < 0) {
		return undefined;
	}
	return {
		kind: "replaceLine",
		line: rpcLine,
		text: `${line.slice(0, semicolon)} {\n${body}\n${indent}}`,
	};
}

/**
 * Adds a key to an existing `google.api.resource` body.
 *
 * Only ever into one that exists. Declaring the whole option is a decision
 * about what the resource *is* — its type and pattern — which the linter does
 * not state and this cannot infer.
 */
export function resourceKeyChange(
	lines: readonly string[],
	key: string,
	value: string,
	near?: number,
): TextChange | undefined {
	let open = -1;
	const from = near ?? 0;
	for (let i = from; i < lines.length; i++) {
		if (/option\s*\(\s*google\.api\.resource\s*\)\s*=\s*\{/.test(lines[i])) {
			open = i;
			break;
		}
	}
	if (open < 0 && near !== undefined) {
		for (let i = 0; i < lines.length; i++) {
			if (/option\s*\(\s*google\.api\.resource\s*\)\s*=\s*\{/.test(lines[i])) {
				open = i;
				break;
			}
		}
	}
	if (open < 0) {
		return undefined;
	}

	// Last key of the body is where a new one reads naturally, and it is also
	// the only position that cannot land after the closing brace.
	let depth = 0;
	let lastKey = -1;
	for (let i = open; i < lines.length; i++) {
		const line = lines[i];
		depth +=
			(line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
		if (i > open && /^\s*[a-z_]\w*\s*:/.test(line)) {
			lastKey = i;
		}
		if (depth <= 0) {
			break;
		}
	}
	if (lastKey < 0) {
		return undefined;
	}
	if (
		lines
			.slice(open, lastKey + 1)
			.some((l) => new RegExp(`^\\s*${key}\\s*:`).test(l))
	) {
		return undefined;
	}
	return {
		kind: "insertLine",
		line: lastKey + 1,
		text: `${indentOf(lines[lastKey])}${key}: ${value}`,
	};
}

/**
 * Adds a leading comment above a declaration.
 *
 * The text is a placeholder on purpose: AIP-192 wants prose describing the
 * element, which nothing here can write. A stub that says what it is beats
 * either inventing a description or leaving the finding unfixable.
 */
export function commentChange(
	lines: readonly string[],
	target: string,
	near?: number,
): TextChange | undefined {
	const declaration = new RegExp(
		`^\\s*(?:message|enum|service|rpc)\\s+${target}\\b|^\\s*[\\w.<>, ]+\\s+${target}\\s*=\\s*\\d+`,
	);
	let at = -1;
	if (
		near !== undefined &&
		near < lines.length &&
		declaration.test(lines[near])
	) {
		at = near;
	} else {
		for (let i = 0; i < lines.length; i++) {
			if (declaration.test(lines[i])) {
				at = i;
				break;
			}
		}
	}
	if (at < 0) {
		return undefined;
	}
	// Something is already documented here; adding a second comment would be
	// the wrong fix even though the finding is real.
	if (at > 0 && lines[at - 1].trim().startsWith("//")) {
		return undefined;
	}
	return {
		kind: "insertLine",
		line: at,
		text: `${indentOf(lines[at])}// TODO: describe ${target}.`,
	};
}

/**
 * The change one fix makes to one file.
 *
 * @param lines - The file, split on newlines
 * @param fix - What to write, from `intendedFix`
 * @param near - Line the finding pointed at
 * @returns The change, or undefined when placement is not certain
 */
export function changeFor(
	lines: readonly string[],
	fix: FixKind,
	near?: number,
): TextChange | undefined {
	switch (fix.kind) {
		case "fileOption":
			return fileOptionInsertion(lines, fix.option, fix.value);
		case "fieldOption":
			return fieldOptionChange(lines, fix.field, fix.option, fix.value, near);
		case "methodOption":
			return near === undefined
				? undefined
				: methodOptionChange(lines, near, fix.option, fix.value);
		case "resourceKey":
			return resourceKeyChange(lines, fix.key, fix.value, near);
		case "comment":
			return commentChange(lines, fix.target, near);
	}
}

/**
 * Drops changes that would collide, keeping the first for each line.
 *
 * Every change is computed against the *original* text, so two that touch one
 * line cannot both be right: each replacement rewrites the whole line, so the
 * second silently discards the first — and two findings on one field is the
 * common case, not an edge one. Applying both duplicated the declaration and
 * produced a file that would not compile, which is the worst outcome available
 * to a feature whose whole promise is a safe bulk edit.
 *
 * Rather than merge them — which would mean re-deriving each fix against text
 * the other had already changed — the collision is declined. The reader sees
 * one fix applied, re-lints, and gets the next; a second pass is cheap, and
 * being right the first time matters more than being complete.
 *
 * @param changes - Changes in any order
 * @returns Changes that can be applied together, in document order
 */
export function withoutCollisions(
	changes: readonly TextChange[],
): readonly TextChange[] {
	const claimed = new Set<number>();
	const kept: TextChange[] = [];
	for (const change of [...changes].sort((a, b) => a.line - b.line)) {
		if (claimed.has(change.line)) {
			continue;
		}
		claimed.add(change.line);
		kept.push(change);
	}
	return kept;
}

/**
 * Applies changes to text, for previewing and for testing placement.
 *
 * Applied bottom-up so each change's line numbers still refer to the text it
 * was computed against — the same reason the editor's own multi-edit
 * application works that way. Colliding changes are dropped first; see
 * {@link withoutCollisions}.
 *
 * @param lines - The file
 * @param changes - Changes in any order
 * @returns The resulting text
 */
export function applyChanges(
	lines: readonly string[],
	changes: readonly TextChange[],
): string {
	const out = [...lines];
	const ordered = [...withoutCollisions(changes)].sort(
		(a, b) => b.line - a.line,
	);
	for (const change of ordered) {
		if (change.kind === "insertLine") {
			out.splice(change.line, 0, change.text);
		} else {
			out[change.line] = change.text;
		}
	}
	return out.join("\n");
}
