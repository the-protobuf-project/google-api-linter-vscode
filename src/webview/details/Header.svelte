<script lang="ts">
/**
 * The panel's identity block: what is selected, and the one-line summary of
 * how much is wrong with it.
 */
import type { SymbolDetail } from "../../shared/protocol";
import { countLabel, formatLoc, fullLoc } from "./format";
import Icon from "./Icon.svelte";
import { KIND_COLOR, KIND_ICON } from "./icons";

let { detail, onReveal }: { detail: SymbolDetail; onReveal: () => void } =
	$props();
</script>

<header class="border-b border-line px-3 pt-2.5 pb-2.5">
	<div class="flex items-center gap-1.5 font-mono text-[10px] text-muted">
		<span class={KIND_COLOR[detail.kind]}>
			<Icon name={KIND_ICON[detail.kind]} size={13} />
		</span>
		<span class="truncate" title={detail.fqn}>{detail.fqn}</span>
	</div>

	<h1
		class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[15px] font-bold tracking-tight"
	>
		{detail.name}
		{#if detail.isResource}
			<span
				class="rounded-sm bg-sym-class/20 px-1.5 py-px text-[9.5px] font-bold tracking-[0.05em] text-sym-class uppercase"
			>
				resource
			</span>
		{/if}
		{#if detail.problemTotal > 0}
			<span
				class="rounded-sm bg-danger/15 px-1.5 py-px text-[9.5px] font-bold tracking-[0.05em] text-danger uppercase"
			>
				{countLabel(detail.problemTotal, "problem")}
			</span>
		{/if}
	</h1>

	{#if detail.doc}
		<p class="mt-1.5 mb-0 text-[12px] leading-snug text-muted">{detail.doc}</p>
	{/if}

	<button
		type="button"
		class="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-link hover:underline"
		onclick={onReveal}
		title={fullLoc(detail.loc)}
	>
		<Icon name="file" size={12} />
		{formatLoc(detail.loc)}
	</button>
</header>
