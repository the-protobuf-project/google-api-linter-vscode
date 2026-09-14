<script lang="ts">
/**
 * The fields of a message, with the `field_behavior` each one carries.
 *
 * An empty `behaviors` is rendered as "unset" rather than blank: several AIP
 * rules fire precisely because nothing was set, so blank would hide the
 * finding instead of showing it.
 *
 * The table scrolls inside its own container. Type names like
 * `google.protobuf.Timestamp` are wider than a 300px sidebar, and letting
 * that scroll the panel body sideways makes every other row unreadable.
 */
import type { FieldDetail } from "../../shared/protocol";

let {
	fields,
	onReveal,
}: {
	fields: readonly FieldDetail[];
	onReveal: (field: FieldDetail) => void;
} = $props();
</script>

<div class="overflow-x-auto">
	<table class="w-full border-collapse font-mono text-[11px]">
		<thead>
			<tr class="border-b border-line">
				<th
					class="px-3 pb-1 text-left text-[9.5px] font-normal tracking-[0.06em] text-muted uppercase"
					>Field</th
				>
				<th
					class="px-2 pb-1 text-left text-[9.5px] font-normal tracking-[0.06em] text-muted uppercase"
					>Type</th
				>
				<th
					class="px-2 pb-1 text-right text-[9.5px] font-normal tracking-[0.06em] text-muted uppercase"
					>#</th
				>
				<th
					class="px-2 pb-1 text-left text-[9.5px] font-normal tracking-[0.06em] text-muted uppercase"
					>Behavior</th
				>
				<th
					class="px-3 pb-1 text-right text-[9.5px] font-normal tracking-[0.06em] text-muted uppercase"
					>!</th
				>
			</tr>
		</thead>
		<tbody>
			{#each fields as field (field.name)}
				<tr class="hover:bg-hover">
					<td class="px-3 py-0.5 align-baseline">
						<button
							type="button"
							class="text-left text-sym-field hover:underline"
							onclick={() => onReveal(field)}
							title={`Go to ${field.name}`}
						>
							{field.name}
						</button>
					</td>
					<td class="px-2 py-0.5 align-baseline whitespace-nowrap text-muted">
						{field.repeated ? "repeated " : ""}{field.type}
					</td>
					<td class="tnum px-2 py-0.5 text-right align-baseline">{field.number}</td>
					<td class="px-2 py-0.5 align-baseline whitespace-nowrap">
						{#if field.behaviors.length > 0}
							<span class="text-[10px] tracking-[0.03em] text-ok">
								{field.behaviors.join(", ")}
							</span>
						{:else}
							<span class="text-[10px] tracking-[0.03em] text-danger">unset</span>
						{/if}
					</td>
					<td class="tnum px-3 py-0.5 text-right align-baseline">
						{#if field.problemCount > 0}
							<span class="font-bold text-danger">{field.problemCount}</span>
						{:else}
							<span class="text-muted">·</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
