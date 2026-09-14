/**
 * Public surface of the proto index.
 *
 * Consumers import from `src/index` and nothing deeper. The implementation is
 * pure node — it never imports `vscode` and never opens a `TextDocument` — so
 * providers, the Proto view, tests and benchmarks all build against the same
 * object.
 *
 * @example
 * ```ts
 * import { createProtoIndex } from "./index";
 *
 * const index = createProtoIndex({
 *   budget: { maxMemoryMB: 256, maxFiles: 20000 },
 *   annotationRoots: bufCacheRoots,
 * });
 * const stats = await index.build([workspaceFolder.uri.fsPath]);
 * if (stats.degradeReason) {
 *   void vscode.window.showWarningMessage(`Proto index: ${stats.degradeReason}`);
 * }
 * context.subscriptions.push({ dispose: () => index.dispose() });
 * ```
 */

export type {
	ParsedFile,
	ParsedReference,
	ParsedSymbol,
	ParseOptions,
} from "./parser";
export { parseProtoText } from "./parser";
export type { ProtoIndexOptions } from "./protoIndex";
export {
	createProtoIndex,
	DEFAULT_INDEX_BUDGET,
	ProtoIndexImpl,
} from "./protoIndex";
export { flattenString, StringPool } from "./strings";
export * from "./types";
export type { WalkedFile, WalkOptions, WalkResult } from "./walk";
export { importPathFor, walkProtoFiles } from "./walk";
