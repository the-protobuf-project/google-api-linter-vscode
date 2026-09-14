<script lang="ts">
/**
 * What the panel shows before a model arrives, or when one cannot be built.
 */
import Icon from "./Icon.svelte";

let { message, detail }: { message: string; detail?: string } = $props();
</script>

<div class="grid place-items-center px-6 py-16 text-center">
	<div class="max-w-[42ch]">
		<span class="text-muted"><Icon name="registry" size={28} /></span>
		<p class="mt-3 mb-0 text-[13px]">{message}</p>
		{#if detail}
			<p class="mt-1.5 mb-0 text-[11.5px] text-muted">{detail}</p>
		{/if}
	</div>
</div>
