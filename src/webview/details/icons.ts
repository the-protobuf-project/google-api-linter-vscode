/**
 * Glyph names and the theme tokens that colour them.
 *
 * Codicons are a font the host loads for its own chrome; a webview does not
 * inherit it, and the CSP forbids fetching one. Every glyph this panel draws is
 * therefore an inline path in `Icon.svelte`, and this file is the index.
 *
 * The class strings are written out whole rather than composed from fragments.
 * Tailwind scans source files as plain text, so `"text-" + tone` is a class
 * that never reaches the stylesheet.
 */

import type { ProblemDetail, SymbolDetail } from "../../shared/protocol";

/** Every glyph `Icon.svelte` can draw. */
export type IconName =
	| "chevron"
	| "error"
	| "file"
	| "info"
	| "link-external"
	| "symbol-class"
	| "symbol-enum"
	| "symbol-field"
	| "symbol-interface"
	| "symbol-method"
	| "warning";

/** The glyph that stands for each kind of symbol. */
export const KIND_ICON: Record<SymbolDetail["kind"], IconName> = {
	service: "symbol-interface",
	rpc: "symbol-method",
	message: "symbol-class",
	enum: "symbol-enum",
	field: "symbol-field",
	file: "file",
};

/**
 * Token colour per kind, matching the hues VS Code gives the same symbols in
 * its outline view — a field should read as a field in either place.
 */
export const KIND_COLOR: Record<SymbolDetail["kind"], string> = {
	service: "text-sym-iface",
	rpc: "text-sym-method",
	message: "text-sym-class",
	enum: "text-sym-enum",
	field: "text-sym-field",
	file: "text-muted",
};

/** The glyph that stands for each severity. */
export const SEVERITY_ICON: Record<ProblemDetail["severity"], IconName> = {
	error: "error",
	warning: "warning",
	info: "info",
};

/** Token colour per severity. These encode state, so they never use the accent. */
export const SEVERITY_COLOR: Record<ProblemDetail["severity"], string> = {
	error: "text-danger",
	warning: "text-warn",
	info: "text-info",
};
