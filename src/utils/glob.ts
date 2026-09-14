/**
 * The small glob dialect used by `.api-linter.yaml` path scoping and by
 * `workspace.protobuf.yaml`'s `exclude` key.
 *
 * api-linter matches its own `included_paths` / `excluded_paths` with Go's
 * doublestar, so this deliberately implements the same three wildcards and
 * nothing else. Patterns are matched against a **posix** path relative to the
 * directory the config file lives in, which is also the path api-linter itself
 * sees once `buildLinterArgs` hands it a root-relative file argument.
 *
 * - `**` spans any number of path segments, including zero
 * - `*` spans any run of characters inside one segment
 * - `?` is exactly one character inside one segment
 */

/** Characters that are regex-special and carry no meaning in a glob. */
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Escapes one glob segment's literal text for embedding in a RegExp. */
const escapeLiteral = (text: string): string =>
	text.replace(REGEX_SPECIAL, "\\$&");

/**
 * Translates one segment's `*` and `?` wildcards, neither of which may cross a
 * path separator.
 */
const segmentToPattern = (segment: string): string => {
	let out = "";
	for (const char of segment) {
		if (char === "*") {
			out += "[^/]*";
		} else if (char === "?") {
			out += "[^/]";
		} else {
			out += escapeLiteral(char);
		}
	}
	return out;
};

/**
 * Compiles a glob to an anchored RegExp.
 *
 * A `**` segment is the only one that may match a separator, and it matches
 * zero segments as readily as many: a doubled-star segment followed by
 * `b.proto` still matches `a/b.proto`, with `**` standing for nothing at all.
 * That is what lets api-linter's idiomatic "every proto" pattern cover protos
 * sitting directly in the root as well as nested ones.
 *
 * @param pattern - Glob in posix form; backslashes are read as separators too
 * @returns A RegExp anchored at both ends of the candidate path
 */
export const globToRegExp = (pattern: string): RegExp => {
	const segments = pattern.replace(/\\/g, "/").split("/").filter(Boolean);
	let source = "";
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const last = i === segments.length - 1;
		if (segment === "**") {
			// Trailing `**` swallows the remainder; an interior one swallows whole
			// segments only, so `a/**/b` still requires the `b`.
			source += last ? ".*" : "(?:[^/]+/)*";
			continue;
		}
		source += segmentToPattern(segment);
		if (!last) {
			source += "/";
		}
	}
	return new RegExp(`^${source}$`);
};

/** True when `relativePath` (posix, no leading `./`) matches `pattern`. */
export const matchesGlob = (relativePath: string, pattern: string): boolean =>
	globToRegExp(pattern).test(toPosix(relativePath));

/** Rewrites a native path to the posix form every glob here is written in. */
export const toPosix = (filePath: string): string =>
	filePath.replace(/\\/g, "/").replace(/^\.\//, "");

/** True when the pattern has no wildcard, and so names a literal path. */
const isLiteral = (pattern: string): boolean => !/[*?]/.test(pattern);

/**
 * Expands the shorthand people actually write. `vendor` and `vendor/` are meant
 * as "that directory", so they also cover everything beneath it -- otherwise a
 * bare directory name would silently match nothing and the exclusion would look
 * broken rather than wrong.
 *
 * @param pattern - Raw pattern as written in the config file
 * @returns Every glob the pattern should be tested against
 */
export const expandPattern = (pattern: string): string[] => {
	const cleaned = toPosix(pattern.trim()).replace(/\/+$/, "");
	if (!cleaned) {
		return [];
	}
	if (isLiteral(cleaned)) {
		return [cleaned, `${cleaned}/**`];
	}
	return [cleaned];
};

/**
 * Builds a matcher over many patterns, compiling each glob once rather than per
 * candidate -- a workspace lint asks this about every proto it found.
 *
 * @param patterns - Raw patterns from a config file
 * @returns Predicate over posix paths relative to that config's directory
 */
export const createGlobMatcher = (
	patterns: readonly string[],
): ((relativePath: string) => boolean) => {
	const compiled = patterns
		.flatMap(expandPattern)
		.map((pattern) => globToRegExp(pattern));
	if (compiled.length === 0) {
		return () => false;
	}
	return (relativePath: string) => {
		const candidate = toPosix(relativePath);
		return compiled.some((regex) => regex.test(candidate));
	};
};
