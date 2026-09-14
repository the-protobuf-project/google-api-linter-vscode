<script lang="ts">
/**
 * The RPCs of a service, with their HTTP bindings.
 *
 * The `google.api.http` rule is shown inline because it is the thing most
 * often being reviewed on a service — an AIP method is judged by its verb
 * and path as much as by its name.
 */
import type { RpcDetail } from "../../shared/protocol";
import { streamed } from "./format";
import Icon from "./Icon.svelte";

let {
	rpcs,
	onReveal,
}: { rpcs: readonly RpcDetail[]; onReveal: (rpc: RpcDetail) => void } =
	$props();
</script>

<ul class="m-0 flex list-none flex-col p-0">
	{#each rpcs as rpc (rpc.name)}
		<li class="hover:bg-hover">
			<button
				type="button"
				class="flex w-full items-start gap-2 px-3 py-1 text-left"
				onclick={() => onReveal(rpc)}
			>
				<span class="pt-0.5 text-sym-method">
					<Icon name="symbol-method" size={13} />
				</span>
				<span class="min-w-0 grow">
					<span class="flex items-baseline gap-2">
						<span class="truncate font-mono text-[11.5px]">{rpc.name}</span>
						{#if rpc.problemCount > 0}
							<span class="tnum ml-auto shrink-0 font-mono text-[10px] font-bold text-danger">
								{rpc.problemCount}
							</span>
						{/if}
					</span>
					<span class="mt-px block truncate font-mono text-[10px] text-muted">
						{streamed(rpc.requestType, rpc.clientStreaming)} → {streamed(
							rpc.responseType,
							rpc.serverStreaming,
						)}
					</span>
					{#if rpc.httpRule}
						<span class="mt-px block truncate font-mono text-[10px] text-sym-field">
							{rpc.httpRule}
						</span>
					{/if}
				</span>
			</button>
		</li>
	{/each}
</ul>
