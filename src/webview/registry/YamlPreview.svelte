<script lang="ts">
/**
 * The `buf.yaml` edit an action would make, shown before it is made.
 *
 * `buf dep` has no `add` subcommand, so adding a dependency means the
 * extension writes this file itself — a file the reader hand-maintains and
 * commits. Showing the exact line first is what keeps that from being a
 * surprise.
 */
import type { YamlLine } from "./model";

let { lines }: { lines: readonly YamlLine[] } = $props();
</script>

<div class="overflow-x-auto rounded border border-line bg-editor px-3 py-2">
	<pre class="m-0 font-mono text-[11.5px] leading-relaxed"><code
			>{#each lines as line, index (index)}<span
					class={line.added ? "block bg-ok/15 text-ok" : "block"}
					>{line.text}</span
				>{/each}</code
		></pre>
</div>
