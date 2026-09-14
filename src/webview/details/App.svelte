<script lang="ts">
/**
 * Stateful shell for the Details panel.
 *
 * State lives here rather than in `main.ts` because runes are a compiler
 * feature: only `.svelte` files go through the Svelte compiler, so a
 * `$state()` written in a plain `.ts` module survives bundling as a call to
 * an undefined global and throws the moment the panel loads.
 */
import type { Loc, SymbolDetail } from "../../shared/protocol";
import {
	announceReady,
	loadState,
	onHostMessage,
	post,
	saveState,
} from "../shared/bridge";
import Details from "./Details.svelte";

/** What survives the panel being hidden and its DOM torn down. */
interface PanelState {
	readonly collapsed: Record<string, boolean>;
}

let detail = $state<SymbolDetail | null>(null);
let collapsed = $state<Record<string, boolean>>(
	loadState<PanelState>()?.collapsed ?? {},
);

$effect(() => {
	const unsubscribe = onHostMessage((message) => {
		if (message.type === "details/update") {
			detail = message.detail;
		}
	});
	// The host holds the payload; asking is what starts the first render.
	announceReady();
	return unsubscribe;
});

function toggleSection(id: string): void {
	collapsed = { ...collapsed, [id]: collapsed[id] !== true };
	saveState({ collapsed } satisfies PanelState);
}
</script>

<Details
	{detail}
	{collapsed}
	onToggleSection={toggleSection}
	onReveal={(loc: Loc) => post({ type: "reveal", loc })}
	onOpenUrl={(url: string) => post({ type: "openExternal", url })}
/>
