<script lang="ts">
/**
 * One custom option and its keys.
 *
 * The absent keys are the reason this block exists. A panel that renders only
 * what the file wrote can never say "singular is not set", which is exactly
 * what `core::0123::resource-singular` is complaining about — so a key with
 * no value still gets a row, carrying the rule that wants it.
 */
import type { AnnotationDetail } from "../../shared/protocol";
import Icon from "./Icon.svelte";

let {
	annotation,
	onOpenUrl,
}: {
	annotation: AnnotationDetail;
	onOpenUrl: (url: string) => void;
} = $props();

const setCount = $derived(
	annotation.keys.filter((key) => key.value !== undefined).length,
);
</script>

<div class="px-3 pt-1.5 pb-1">
	<div class="flex items-baseline justify-between gap-2">
		<span class="truncate font-mono text-[11.5px] text-fg">{annotation.name}</span>
		<span class="tnum shrink-0 font-mono text-[10px] text-muted">
			{setCount} of {annotation.keys.length} set
		</span>
	</div>

	<dl class="mt-1 grid gap-0.5">
		{#each annotation.keys as key (key.key)}
			<div class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-2">
				<dt class="truncate font-mono text-[11px] text-muted">{key.key}</dt>
				<dd class="m-0 font-mono text-[11px] break-words">
					{#if key.value !== undefined}
						{key.value}
					{:else if key.requiredByUrl}
						<button
							type="button"
							class="inline-flex items-center gap-1 text-left text-danger hover:underline"
							onclick={() => onOpenUrl(key.requiredByUrl as string)}
						>
							<Icon name="error" size={11} />
							<span>not set — {key.requiredBy}</span>
							<Icon name="link-external" size={10} />
						</button>
					{:else}
						<span class="inline-flex items-center gap-1 text-danger">
							<Icon name="error" size={11} />
							not set
						</span>
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
</div>
