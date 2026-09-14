<script lang="ts">
/**
 * The Details panel.
 *
 * Sections are ordered by what a reviewer asks first: what is this, what is
 * declared on it, what does it contain, and then why is it failing. Problems
 * come last rather than first because they only make sense once the reader
 * knows which fields they are about.
 */
import type {
	FieldDetail,
	Loc,
	ProblemDetail,
	RpcDetail,
	SymbolDetail,
} from "../../shared/protocol";
import AnnotationBlock from "./AnnotationBlock.svelte";
import FieldTable from "./FieldTable.svelte";
import { countLabel } from "./format";
import Header from "./Header.svelte";
import ProblemList from "./ProblemList.svelte";
import RpcList from "./RpcList.svelte";
import Section from "./Section.svelte";

let {
	detail,
	collapsed,
	onToggleSection,
	onReveal,
	onOpenUrl,
}: {
	detail: SymbolDetail | null;
	collapsed: Record<string, boolean>;
	onToggleSection: (id: string) => void;
	onReveal: (loc: Loc) => void;
	onOpenUrl: (url: string) => void;
} = $props();

const isOpen = (id: string): boolean => collapsed[id] !== true;

const revealField = (field: FieldDetail): void => onReveal(field.loc);
const revealRpc = (rpc: RpcDetail): void => onReveal(rpc.loc);
const revealProblem = (problem: ProblemDetail): void => onReveal(problem.loc);
</script>

{#if !detail}
	<p class="m-0 px-4 py-6 text-center text-[12px] text-muted">
		Select a symbol in Structure to see its fields, annotations and findings.
	</p>
{:else}
	<Header {detail} onReveal={() => onReveal(detail.loc)} />

	{#if detail.annotations.length > 0}
		<Section
			title="Annotations"
			count={String(detail.annotations.length)}
			open={isOpen("annotations")}
			onToggle={() => onToggleSection("annotations")}
		>
			{#each detail.annotations as annotation (annotation.name)}
				<AnnotationBlock {annotation} {onOpenUrl} />
			{/each}
		</Section>
	{/if}

	{#if detail.fields.length > 0}
		<Section
			title="Fields"
			count={String(detail.fields.length)}
			open={isOpen("fields")}
			onToggle={() => onToggleSection("fields")}
		>
			<FieldTable fields={detail.fields} onReveal={revealField} />
		</Section>
	{/if}

	{#if detail.rpcs.length > 0}
		<Section
			title="RPCs"
			count={String(detail.rpcs.length)}
			open={isOpen("rpcs")}
			onToggle={() => onToggleSection("rpcs")}
		>
			<RpcList rpcs={detail.rpcs} onReveal={revealRpc} />
		</Section>
	{/if}

	{#if detail.enumValues.length > 0}
		<Section
			title="Values"
			count={String(detail.enumValues.length)}
			open={isOpen("values")}
			onToggle={() => onToggleSection("values")}
		>
			<dl class="m-0 grid gap-0.5 px-3 pt-1">
				{#each detail.enumValues as value (value.name)}
					<div class="flex items-baseline justify-between gap-3">
						<dt class="truncate font-mono text-[11px] text-sym-enum">
							{value.name}
						</dt>
						<dd class="tnum m-0 font-mono text-[11px] text-muted">
							{value.number}
						</dd>
					</div>
				{/each}
			</dl>
		</Section>
	{/if}

	{#if detail.problems.length > 0}
		<Section
			title="Why this symbol"
			count={`${detail.problemTotal} · ${countLabel(detail.problems.length, "rule")}`}
			open={isOpen("problems")}
			onToggle={() => onToggleSection("problems")}
		>
			<ProblemList
				problems={detail.problems}
				onReveal={revealProblem}
				{onOpenUrl}
			/>
		</Section>
	{:else}
		<p class="m-0 px-3 py-3 text-[11.5px] text-ok">No findings on this symbol.</p>
	{/if}
{/if}
