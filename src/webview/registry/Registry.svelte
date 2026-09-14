<script lang="ts">
/**
 * The Proto Registry.
 *
 * Three panes: what you can filter by, what matches, and what one of them
 * is. The grid collapses to one column on a narrow tab rather than letting
 * the page scroll sideways.
 */
import type { DependencyModel } from "../../shared/protocol";
import DetailPane from "./DetailPane.svelte";
import EmptyState from "./EmptyState.svelte";
import Icon from "./Icon.svelte";
import ModuleCard from "./ModuleCard.svelte";
import {
	type Action,
	actionKey,
	allDeps,
	buildRail,
	type CommitRow,
	type FilterId,
	filterDeps,
	genForRoot,
	groupDeps,
	moduleFor,
	type TaskRecord,
} from "./model";
import Rail from "./Rail.svelte";

let {
	model,
	filter,
	query,
	selectedName,
	tasks,
	history,
	onFilter,
	onQuery,
	onSelect,
	onAction,
	onOpenUrl,
}: {
	model: DependencyModel | null;
	filter: FilterId;
	query: string;
	selectedName: string | undefined;
	tasks: Record<string, TaskRecord>;
	history: Readonly<Record<string, readonly CommitRow[]>>;
	onFilter: (id: FilterId) => void;
	onQuery: (value: string) => void;
	onSelect: (name: string) => void;
	onAction: (action: Action) => void;
	onOpenUrl: (url: string) => void;
} = $props();

const rail = $derived(model ? buildRail(model) : []);
const visible = $derived(
	model ? filterDeps(allDeps(model), filter, query) : [],
);
const groups = $derived(groupDeps(visible));
const selected = $derived(
	visible.find((dep) => dep.name === selectedName) ?? visible[0],
);
const owningModule = $derived(
	model && selected ? moduleFor(model, selected) : undefined,
);
const checking = $derived(tasks[actionKey({ kind: "check" })]);
</script>

{#if !model}
	<EmptyState message="Reading buf configuration…" />
{:else if model.error}
	<EmptyState message="Could not read buf configuration" detail={model.error} />
{:else}
	<div class="grid min-h-dvh grid-cols-1 lg:grid-cols-[10.5rem_minmax(0,1.15fr)_minmax(0,1fr)]">
		<div class="border-line lg:border-r">
			<Rail groups={rail} selected={filter} onSelect={onFilter} />
		</div>

		<div class="flex min-w-0 flex-col border-line lg:border-r">
			<div class="flex items-center gap-2 border-b border-line px-3 py-2.5">
				<label class="flex h-6 min-w-0 grow items-center gap-1.5 rounded-sm border border-input-line bg-input px-1.5 focus-within:border-focus">
					<span class="text-muted"><Icon name="search" size={14} /></span>
					<input
						type="text"
						value={query}
						oninput={(event) => onQuery(event.currentTarget.value)}
						placeholder="Search modules…"
						aria-label="Search modules"
						class="min-w-0 grow border-0 bg-transparent p-0 text-[12px] text-input-fg outline-none placeholder:text-muted"
					/>
					<span class="tnum shrink-0 font-mono text-[10.5px] text-muted">
						{visible.length}
					</span>
				</label>
				<button
					type="button"
					class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-2 py-1 text-[11px] hover:bg-hover disabled:opacity-50"
					disabled={checking?.state === "running"}
					onclick={() => onAction({ kind: "check" })}
					title="Ask the registry for each module's newest commit"
				>
					<Icon name="sync" size={12} />
					{checking?.state === "running" ? "Checking…" : "Check updates"}
				</button>
			</div>

			<div class="grow overflow-auto">
				{#if visible.length === 0}
					<p class="px-4 py-8 text-center text-[12px] text-muted">
						Nothing matches this filter.
					</p>
				{:else}
					{#each groups as group (group.label)}
						<h2
							class="flex justify-between gap-2 px-3.5 pt-3 pb-1.5 text-[9.5px] font-bold tracking-[0.07em] text-muted uppercase"
						>
							<span>{group.label}</span>
							<span class="tnum font-mono">{group.deps.length}</span>
						</h2>
						{#each group.deps as dep (dep.name)}
							<ModuleCard
								{dep}
								selected={dep.name === selected?.name}
								onSelect={() => onSelect(dep.name)}
							/>
						{/each}
					{/each}
				{/if}
			</div>
		</div>

		{#if selected}
			<DetailPane
				dep={selected}
				module={owningModule}
				gen={genForRoot(model, owningModule?.root)}
				history={history[selected.name]}
				{tasks}
				{onAction}
				{onOpenUrl}
			/>
		{:else}
			<EmptyState message="Select a module to see its detail." />
		{/if}
	</div>
{/if}
