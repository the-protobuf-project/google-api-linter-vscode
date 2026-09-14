<script lang="ts">
/**
 * Why this symbol is failing.
 *
 * Findings arrive already collapsed by rule, because `api-linter` reports
 * several rules once per field: eight rows that are really one problem. The
 * `×N` and the line span carry what the collapse folded away.
 */
import type { ProblemDetail } from "../../shared/protocol";
import { formatLines } from "./format";
import Icon from "./Icon.svelte";
import { SEVERITY_COLOR, SEVERITY_ICON } from "./icons";

let {
	problems,
	onReveal,
	onOpenUrl,
}: {
	problems: readonly ProblemDetail[];
	onReveal: (problem: ProblemDetail) => void;
	onOpenUrl: (url: string) => void;
} = $props();
</script>

<ul class="m-0 flex list-none flex-col p-0">
	{#each problems as problem (problem.ruleId)}
		<li class="px-3 py-1.5 hover:bg-hover">
			<div class="grid grid-cols-[1rem_minmax(0,1fr)] gap-2">
				<span class={`pt-px ${SEVERITY_COLOR[problem.severity]}`}>
					<Icon name={SEVERITY_ICON[problem.severity]} size={13} />
				</span>
				<div class="min-w-0">
					<button
						type="button"
						class="block w-full text-left text-[11.5px] leading-snug"
						onclick={() => onReveal(problem)}
					>
						{problem.message}
					</button>
					<div
						class="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] text-muted"
					>
						{#if formatLines(problem.lines)}
							<span class="tnum">{formatLines(problem.lines)}</span>
						{/if}
						{#if problem.docUrl}
							<button
								type="button"
								class="inline-flex items-center gap-1 text-link hover:underline"
								onclick={() => onOpenUrl(problem.docUrl as string)}
							>
								{problem.ruleId}
								<Icon name="link-external" size={10} />
							</button>
						{:else}
							<span>{problem.ruleId}</span>
						{/if}
						{#if problem.occurrences > 1}
							<span class="tnum">×{problem.occurrences}</span>
						{/if}
					</div>
				</div>
			</div>
		</li>
	{/each}
</ul>
