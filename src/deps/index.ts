/**
 * The buf dependency model: everything the Dependencies view and the Registry
 * panel need, and nothing that requires the extension host.
 *
 * The split is deliberate. {@link buildDependencyModel} is filesystem-only and
 * cheap enough to run on a `buf.lock` change; {@link checkUpdates} is network
 * I/O and must only ever run when the user asks for it. Keeping them in
 * separate calls is what stops a dependency panel from being unusable offline.
 *
 * Typical host wiring:
 *
 * ```ts
 * const model = await buildDependencyModel({ log: outputChannel });
 * panel.postMessage({ type: "registry/update", model });
 * // …later, on a dep/checkUpdates message:
 * const checked = await checkUpdates(model, { bufPath, isCancelled });
 * panel.postMessage({ type: "registry/update", model: checked });
 * ```
 */

export type { GenDiscoveryOptions } from "./bufGen";
export { findGenConfigs, parseBufGenYaml } from "./bufGen";
export type {
	CommandResult,
	CommandRunner,
	CommitLookup,
	RegistryCommit,
	RegistryModuleInfo,
	RegistryOptions,
} from "./bufRegistry";
export {
	checkUpdates,
	computeBehind,
	execCommand,
	fetchCommits,
	fetchModuleInfo,
	isModuleMissing,
	parseCommitList,
	parseModuleInfo,
} from "./bufRegistry";
export type {
	CachedModule,
	CacheScanOptions,
	CountOptions,
	DependencyModelOptions,
	ModuleRef,
} from "./depModel";
export {
	buildDependencyModel,
	countProtoFiles,
	invalidateDepCaches,
	scanModuleCache,
	splitModuleRef,
} from "./depModel";
