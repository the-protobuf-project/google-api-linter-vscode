/**
 * Entry point for annotation support.
 *
 * One call registers semantic tokens, hover, completion and diagnostics, and
 * returns a single `Disposable` that tears all of them down.
 *
 * The registry arrives by injection. No provider scans anything: a provider
 * that built its own index would duplicate the workspace walk the extension
 * already does, and duplicating that walk is what this rewrite exists to stop.
 * Passing `undefined` for the index is legal and turns every feature into a
 * no-op, which is the correct behaviour while the index is still building or
 * when the workspace has none.
 *
 * `package.json` must contribute the semantic token types this module emits;
 * the exact JSON is {@link SEMANTIC_TOKEN_TYPE_CONTRIBUTION} and
 * {@link SEMANTIC_TOKEN_SCOPE_CONTRIBUTION} below, kept here so the two cannot
 * drift apart.
 */

import * as vscode from "vscode";
import type { ProtoIndex } from "../index/types";
import {
	ANNOTATION_TRIGGER_CHARACTERS,
	AnnotationCompletionProvider,
} from "./completion";
import { AnnotationDiagnostics } from "./diagnostics";
import { AnnotationHoverProvider } from "./hover";
import type { AnnotationRegistryImpl } from "./registry";
import { AnnotationSource } from "./resolve";
import {
	ANNOTATION_SEMANTIC_LEGEND,
	AnnotationSemanticTokensProvider,
} from "./semanticTokens";

/** Documents the annotation features attach to. */
const DEFAULT_SELECTOR: vscode.DocumentSelector = [
	{ language: "proto3" },
	{ language: "proto" },
];

/**
 * `contributes.semanticTokenTypes` — paste verbatim into `package.json`.
 *
 * `superType` gives each custom type a standard type to inherit colour from, so
 * a theme that knows nothing about protobuf still renders something sensible.
 */
export const SEMANTIC_TOKEN_TYPE_CONTRIBUTION = [
	{
		id: "protoAnnotation",
		superType: "decorator",
		description: "A custom protobuf option that resolves to a known extension",
	},
	{
		id: "protoAnnotationNamespace",
		superType: "namespace",
		description: "The package portion of a custom protobuf option name",
	},
	{
		id: "protoAnnotationField",
		superType: "property",
		description: "A field inside a custom option's message body",
	},
	{
		id: "protoAnnotationUnknown",
		superType: "decorator",
		description:
			"A custom protobuf option that no indexed extend block declares, or whose annotations.proto this file does not import",
	},
	{
		id: "protoAnnotationFieldUnknown",
		superType: "property",
		description: "A field the custom option's message body does not declare",
	},
] as const;

/**
 * `contributes.semanticTokenScopes` — paste verbatim into `package.json`.
 *
 * The scope lists are fallbacks a theme can colour without the user configuring
 * `editor.semanticTokenColorCustomizations`. The unknown pair maps to
 * `invalid.illegal`, which every shipped theme renders as an error.
 */
export const SEMANTIC_TOKEN_SCOPE_CONTRIBUTION = [
	{
		language: "proto3",
		scopes: {
			protoAnnotation: [
				"entity.name.function.decorator",
				"entity.name.tag",
				"support.type.property-name",
			],
			protoAnnotationNamespace: [
				"entity.name.namespace",
				"entity.name.type.namespace",
				"support.type",
			],
			protoAnnotationField: [
				"variable.other.property",
				"support.type.property-name",
				"meta.object-literal.key",
			],
			protoAnnotationUnknown: ["invalid.illegal", "invalid"],
			protoAnnotationFieldUnknown: ["invalid.illegal", "invalid"],
		},
	},
] as const;

/** Optional overrides, used mainly by tests. */
export interface AnnotationSupportOptions {
	/** Documents to attach to. Defaults to proto buffers. */
	readonly selector?: vscode.DocumentSelector;
	/** Registry to use when no index is available. */
	readonly registry?: AnnotationRegistryImpl;
}

/** Everything annotation support exposes to its host. */
export interface AnnotationSupport extends vscode.Disposable {
	/** Semantic tokens provider, for forcing a re-highlight. */
	readonly semanticTokens: AnnotationSemanticTokensProvider;
	/** Diagnostics, for forcing a re-validation. */
	readonly diagnostics: AnnotationDiagnostics;
	/** Re-highlights and re-validates every open proto buffer. */
	refresh(): void;
}

/**
 * Registers every annotation feature.
 *
 * @param context - Extension context; the returned disposable is added to its subscriptions
 * @param index - The workspace index, or undefined to register no-op features
 * @param options - Selector and registry overrides
 * @returns A handle that disposes all four providers
 *
 * @example
 * ```ts
 * const annotations = registerAnnotationSupport(context, protoIndex);
 * ```
 */
export function registerAnnotationSupport(
	context: vscode.ExtensionContext,
	index: ProtoIndex | undefined,
	options: AnnotationSupportOptions = {},
): AnnotationSupport {
	const source = new AnnotationSource(index, options.registry);
	const selector = options.selector ?? DEFAULT_SELECTOR;

	const semanticTokens = new AnnotationSemanticTokensProvider(source);
	const diagnostics = new AnnotationDiagnostics(source);

	// An index build can turn an unknown annotation into a known one without the
	// buffer changing, so highlighting is re-run on it. Diagnostics subscribe to
	// the same event themselves, in `start`.
	const indexListener = source.onDidChange(() => semanticTokens.refresh());

	const disposables: vscode.Disposable[] = [
		vscode.languages.registerDocumentSemanticTokensProvider(
			selector,
			semanticTokens,
			ANNOTATION_SEMANTIC_LEGEND,
		),
		vscode.languages.registerHoverProvider(
			selector,
			new AnnotationHoverProvider(source),
		),
		vscode.languages.registerCompletionItemProvider(
			selector,
			new AnnotationCompletionProvider(source),
			...ANNOTATION_TRIGGER_CHARACTERS,
		),
		new vscode.Disposable(() => indexListener.dispose()),
		semanticTokens,
		diagnostics,
	];

	diagnostics.start();

	let disposed = false;
	const support: AnnotationSupport = {
		semanticTokens,
		diagnostics,
		refresh(): void {
			semanticTokens.refresh();
			diagnostics.refreshAll();
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const disposable of [...disposables].reverse()) {
				disposable.dispose();
			}
		},
	};
	context.subscriptions.push(support);
	return support;
}
