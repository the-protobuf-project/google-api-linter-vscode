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

<!--
	One row, not one card.

	The three stacked lines this used to draw made every module 64px tall, so a
	workspace with a dozen dependencies needed scrolling to see half of them.
	Laid out as columns the same facts fit in 26px, and — more usefully — the
	commits and proto counts line up down the list where they can be compared.
-->
<button
	type="button"
	class="grid w-full grid-cols-[1.25rem_minmax(7rem,1.4fr)_minmax(0,1fr)_5.5rem_4.5rem_auto] items-center gap-x-3 border-l-2 border-transparent px-3 py-1 text-left hover:bg-hover"
	class:bg-active={selected}
	class:border-l-focus={selected}
	aria-pressed={selected}
	onclick={onSelect}
>
	<span
		class={`grid size-5 place-items-center rounded-sm border font-mono text-[10px] font-bold ${avatarTone(dep.owner)}`}
		aria-hidden="true"
	>
		{dep.module.charAt(0).toUpperCase()}
	</span>

	<span class="truncate font-mono text-[12px] font-medium">{dep.module}</span>

	<span class="truncate font-mono text-[10.5px] text-muted">
		{dep.remote}/{dep.owner}
	</span>

	<span class="tnum truncate text-right font-mono text-[10.5px] text-muted">
		{protoSummary(dep)}
	</span>

	<span class="tnum truncate font-mono text-[10.5px] text-muted">
		{dep.commit ? shortCommit(dep.commit) : ""}
	</span>

	<span class="flex justify-end"><StatusPill {dep} /></span>
</button>
