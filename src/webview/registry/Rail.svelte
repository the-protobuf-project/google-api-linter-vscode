<script lang="ts">
/**
 * The filter rail.
 *
 * Rows are derived from the model, never listed here — a workspace pulling
 * from an owner nobody anticipated still gets a row.
 */
import Icon from "./Icon.svelte";
import type { FilterId, RailGroup } from "./model";

let {
	groups,
	selected,
	onSelect,
}: {
	groups: readonly RailGroup[];
	selected: FilterId;
	onSelect: (id: FilterId) => void;
} = $props();
</script>

<nav class="flex flex-col gap-px py-2" aria-label="Filter dependencies">
	{#each groups as group (group.label)}
		{#if group.items.length > 0}
			<h2
				class="px-3 pt-2 pb-0.5 text-[9px] font-bold tracking-[0.07em] text-muted uppercase"
			>
				{group.label}
			</h2>
			{#each group.items as item (item.id)}
				<button
					type="button"
					class="flex items-center gap-2 px-3 py-0.5 text-left text-[11.5px] hover:bg-hover"
					class:bg-active={item.id === selected}
					class:text-active-fg={item.id === selected}
					aria-pressed={item.id === selected}
					onclick={() => onSelect(item.id)}
				>
					<span class="opacity-80"><Icon name={item.icon} size={14} /></span>
					<span class="truncate">{item.label}</span>
					<span class="tnum ml-auto shrink-0 font-mono text-[10.5px] opacity-70">
						{item.count}
					</span>
				</button>
			{/each}
		{/if}
	{/each}
</nav>
