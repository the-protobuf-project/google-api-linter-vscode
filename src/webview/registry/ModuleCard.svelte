<script lang="ts">
/**
 * One dependency as a row in the middle list.
 */
import type { BufDep } from "../../shared/protocol";
import { avatarTone, protoSummary, shortCommit } from "./model";
import StatusPill from "./StatusPill.svelte";

let {
	dep,
	selected,
	onSelect,
}: { dep: BufDep; selected: boolean; onSelect: () => void } = $props();
</script>

<button
	type="button"
	class="grid w-full grid-cols-[1.875rem_minmax(0,1fr)_auto] items-start gap-2.5 border-l-2 border-transparent px-3.5 py-2 text-left hover:bg-hover"
	class:bg-active={selected}
	class:border-l-focus={selected}
	aria-pressed={selected}
	onclick={onSelect}
>
	<span
		class={`grid size-[1.875rem] place-items-center rounded border font-mono text-[13px] font-bold ${avatarTone(dep.owner)}`}
		aria-hidden="true"
	>
		{dep.module.charAt(0).toUpperCase()}
	</span>

	<span class="min-w-0">
		<span class="block truncate font-mono text-[12.5px] font-medium">
			{dep.module}
		</span>
		<span class="block truncate font-mono text-[10.5px] text-muted">
			{dep.remote}/{dep.owner}
		</span>
		<span
			class="tnum mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10.5px] text-muted"
		>
			<span>{protoSummary(dep)}</span>
			{#if dep.commit}
				<span>{shortCommit(dep.commit)}</span>
			{/if}
		</span>
	</span>

	<span class="flex items-center pt-1"><StatusPill {dep} /></span>
</button>
