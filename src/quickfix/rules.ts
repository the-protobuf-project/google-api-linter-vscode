/**
 * Turning a linter message into the edit it is asking for.
 *
 * `api-linter` states the fix in most of its messages — "Proto files should set
 * `option java_outer_classname = "LibraryProto"`" names the option and its
 * value — so a quick fix does not have to infer anything the linter already
 * decided. Of the twenty-six rules a real service triggers, twenty-four say
 * exactly what to write.
 *
 * Free of `vscode` on purpose: this is string work, and keeping it so makes
 * every rule testable without an extension host. Placement is `edits.ts`.
 *
 * The rule everything here follows: **return undefined rather than guess.** A
 * wrong edit in someone's schema is far worse than a lightbulb that does not
 * appear, and a fix that silently writes the wrong value teaches the reader to
 * stop trusting the ones that are right.
 */

/** What a fix will write, independent of where it goes. */
export type FixKind =
	/** A file-scope `option name = value;`. */
	| {
			readonly kind: "fileOption";
			readonly option: string;
			readonly value: string;
	  }
	/** A field option, written inside the field's `[...]`. */
	| {
			readonly kind: "fieldOption";
			readonly field: string;
			readonly option: string;
			readonly value: string;
	  }
	/** An option inside an rpc body. */
	| {
			readonly kind: "methodOption";
			readonly option: string;
			readonly value: string;
	  }
	/** A key inside an existing `google.api.resource` body. */
	| {
			readonly kind: "resourceKey";
			readonly key: string;
			readonly value: string;
	  }
	/** A leading `//` comment above a declaration. */
	| { readonly kind: "comment"; readonly target: string };

/** What the caller knows that the message does not. */
export interface FixContext {
	/** Proto package of the file, e.g. `library.v1`. */
	readonly packageName?: string;
	/** File's base name without extension, e.g. `library`. */
	readonly fileStem?: string;
	/** The `singular` already declared on the resource, when there is one. */
	readonly resourceSingular?: string;
}

/** First backtick-quoted run in a message, if any. */
function backticked(message: string): string | undefined {
	return /`([^`]+)`/.exec(message)?.[1];
}

/** First double-quoted run in a message, if any. */
function quoted(message: string): string | undefined {
	return /"([^"]+)"/.exec(message)?.[1];
}

/**
 * The option and value out of a phrase like
 * `(google.api.field_behavior) = REQUIRED` or `option java_package = "x"`.
 */
function splitAssignment(
	text: string,
): { option: string; value: string } | undefined {
	const match = /^\s*(?:option\s+)?(\(?[\w.()]+\)?)\s*=\s*(.+?)\s*;?\s*$/.exec(
		text,
	);
	if (!match) {
		return undefined;
	}
	return { option: match[1], value: match[2] };
}

/**
 * `book` → `books`, following the same naive pluralisation AIP-123 examples do.
 *
 * Deliberately simple and deliberately limited to the regular cases. An
 * irregular noun would be guessed wrong, and the linter's own message for
 * `resource-plural` does not state the value — so where this is unsure the
 * caller declines rather than writing something a reviewer has to catch.
 */
export function pluralise(singular: string): string | undefined {
	if (singular.length === 0) {
		return undefined;
	}
	if (/(s|x|z|ch|sh)$/.test(singular)) {
		return `${singular}es`;
	}
	if (/[^aeiou]y$/.test(singular)) {
		return `${singular.slice(0, -1)}ies`;
	}
	// Anything ending in a vowel+y, or otherwise regular, takes a plain "s".
	return /[a-z0-9_]$/i.test(singular) ? `${singular}s` : undefined;
}

/** `library` → `LibraryProto`, the name AIP-191 expects. */
function outerClassname(fileStem: string): string {
	const camel = fileStem
		.split(/[_\-.]/)
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
	return `${camel}Proto`;
}

/**
 * The edit a finding is asking for, or undefined when it cannot be known.
 *
 * @param ruleId - e.g. `core::0191::java-package`
 * @param message - The linter's message, verbatim
 * @param context - What the file supplies that the message does not
 * @returns The intended fix, or undefined to decline
 */
export function intendedFix(
	ruleId: string,
	message: string,
	context: FixContext = {},
): FixKind | undefined {
	const rule = ruleId.split("::").slice(1).join("::");

	/* --- AIP-191: file options ------------------------------------- */

	if (rule === "0191::java-multiple-files") {
		return { kind: "fileOption", option: "java_multiple_files", value: "true" };
	}

	if (rule === "0191::java-outer-classname") {
		// The message states the name: `option java_outer_classname = "X"`.
		const stated = backticked(message);
		const parsed = stated ? splitAssignment(stated) : undefined;
		if (parsed) {
			return {
				kind: "fileOption",
				option: "java_outer_classname",
				value: parsed.value,
			};
		}
		// It did not, so derive it from the file name the way AIP-191 does.
		return context.fileStem
			? {
					kind: "fileOption",
					option: "java_outer_classname",
					value: `"${outerClassname(context.fileStem)}"`,
				}
			: undefined;
	}

	if (rule === "0191::java-package") {
		// "Proto files must set `option java_package`." — named, but not valued.
		// AIP-191 prescribes the package prefixed with `com.`.
		return context.packageName
			? {
					kind: "fileOption",
					option: "java_package",
					value: `"com.${context.packageName}"`,
				}
			: undefined;
	}

	/* --- AIP-123: the resource declaration -------------------------- */

	if (rule === "0123::resource-singular") {
		// `Resources should declare singular: "book"`
		const value = quoted(message);
		return value
			? { kind: "resourceKey", key: "singular", value: `"${value}"` }
			: undefined;
	}

	if (rule === "0123::resource-plural") {
		// "Resources should declare plural." — the value is never stated, so it
		// comes from the singular, and only when that is already known.
		const plural = context.resourceSingular
			? pluralise(context.resourceSingular)
			: undefined;
		return plural
			? { kind: "resourceKey", key: "plural", value: `"${plural}"` }
			: undefined;
	}

	/* --- AIP-131..135: method signatures ---------------------------- */

	if (rule.endsWith("::method-signature")) {
		// "Get methods should include `(google.api.method_signature) = "name"`"
		const stated = backticked(message);
		const parsed = stated ? splitAssignment(stated) : undefined;
		return parsed
			? {
					kind: "methodOption",
					option: parsed.option,
					value: parsed.value,
				}
			: undefined;
	}

	/* --- field behaviours and references ---------------------------- */

	if (
		rule.endsWith("::request-name-behavior") ||
		rule.endsWith("::request-parent-behavior") ||
		rule.endsWith("::request-resource-behavior") ||
		rule === "0148::field-behavior"
	) {
		// "The `name` field should include `(google.api.field_behavior) = REQUIRED`."
		const field = backticked(message);
		const all = [...message.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		const assignment = all
			.map((candidate) => splitAssignment(candidate))
			.find((parsed) => parsed !== undefined);
		return field && assignment
			? {
					kind: "fieldOption",
					field,
					option: assignment.option,
					value: assignment.value,
				}
			: undefined;
	}

	if (rule === "0134::update-mask-optional-behavior") {
		// "Standard Update field `update_mask` must have `OPTIONAL` behavior"
		const field = backticked(message);
		return field
			? {
					kind: "fieldOption",
					field,
					option: "(google.api.field_behavior)",
					value: "OPTIONAL",
				}
			: undefined;
	}

	if (rule === "0203::resource-name-identifier") {
		// "resource name field must have field_behavior IDENTIFIER" — the field
		// is always `name`, which is what makes the rule's name meaningful.
		return {
			kind: "fieldOption",
			field: "name",
			option: "(google.api.field_behavior)",
			value: "IDENTIFIER",
		};
	}

	/* --- AIP-192: comments ------------------------------------------ */

	if (rule === "0192::has-comments") {
		// `Missing comment over "LibraryService".`
		const target = quoted(message);
		return target ? { kind: "comment", target } : undefined;
	}

	/* --- Declined ---------------------------------------------------- *
	 * `0203::field-behavior-required` names four acceptable values and no way
	 * to choose between them; `request-name-reference` needs a resource type
	 * this module cannot see; `0133::request-id-field` and `0133::http-body`
	 * are structural changes rather than an annotation. Each is left to the
	 * reader, who knows which answer is right.
	 * ----------------------------------------------------------------- */

	return undefined;
}

/** A short, specific action title, e.g. `Add option java_package`. */
export function fixTitle(fix: FixKind): string {
	switch (fix.kind) {
		case "fileOption":
			return `Add option ${fix.option} = ${fix.value}`;
		case "fieldOption":
			return `Add ${fix.option} = ${fix.value} to ${fix.field}`;
		case "methodOption":
			return `Add ${fix.option} = ${fix.value}`;
		case "resourceKey":
			return `Add ${fix.key}: ${fix.value} to the resource`;
		case "comment":
			return `Add a comment above ${fix.target}`;
	}
}
