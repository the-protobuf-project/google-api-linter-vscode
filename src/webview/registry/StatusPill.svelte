<script lang="ts">
/**
 * A dependency's standing at a glance.
 *
 * State is encoded in the word as well as the colour: "↑ 8" and "current"
 * differ without relying on hue, which colour-blind readers and greyscale
 * screenshots both need.
 */
import type { BufDep } from "../../shared/protocol";
import { isBehind, isGone } from "./model";

let { dep }: { dep: BufDep } = $props();
</script>

{#if isGone(dep)}
	<span
		class="rounded-sm bg-danger/15 px-1.5 py-px font-mono text-[10px] font-bold whitespace-nowrap text-danger"
		title={dep.update?.error}
	>
		gone
	</span>
{:else if isBehind(dep)}
	<span
		class="tnum rounded-sm bg-warn/15 px-1.5 py-px font-mono text-[10px] font-bold whitespace-nowrap text-warn"
		title={`${dep.update?.behind} commit(s) behind`}
	>
		↑ {dep.update?.behind}
	</span>
{:else if dep.update}
	<span
		class="rounded-sm bg-ok/15 px-1.5 py-px font-mono text-[10px] font-bold whitespace-nowrap text-ok"
	>
		current
	</span>
{:else if dep.state === "missing"}
	<span
		class="rounded-sm bg-warn/15 px-1.5 py-px font-mono text-[10px] font-bold whitespace-nowrap text-warn"
		title="declared but not in the module cache"
	>
		missing
	</span>
{/if}
