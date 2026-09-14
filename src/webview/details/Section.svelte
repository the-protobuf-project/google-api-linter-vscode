<script lang="ts">
/**
 * A collapsible block with a heading and an optional count.
 *
 * Open state is owned by the caller so it can be persisted: VS Code destroys
 * a hidden webview's DOM, and a section that silently re-opens on every
 * return loses the reader's place.
 */
import type { Snippet } from "svelte";
import Icon from "./Icon.svelte";

let {
	title,
	count,
	open = true,
	onToggle,
	children,
}: {
	title: string;
	count?: string;
	open?: boolean;
	onToggle?: () => void;
	children: Snippet;
} = $props();
</script>

<section class="border-b border-line last:border-b-0">
	<h2 class="m-0">
		<button
			type="button"
			class="flex w-full items-center gap-1 px-2 py-1.5 text-left hover:bg-hover"
			aria-expanded={open}
			onclick={onToggle}
		>
			<span
				class="flex size-4 shrink-0 items-center justify-center transition-transform motion-reduce:transition-none"
				class:rotate-90={open}
			>
				<Icon name="chevron" size={14} />
			</span>
			<span
				class="grow truncate text-[10px] font-bold tracking-[0.07em] text-muted uppercase"
			>
				{title}
			</span>
			{#if count}
				<span class="tnum shrink-0 font-mono text-[10px] text-muted">
					{count}
				</span>
			{/if}
		</button>
	</h2>
	{#if open}
		<div class="pb-2">
			{@render children()}
		</div>
	{/if}
</section>
