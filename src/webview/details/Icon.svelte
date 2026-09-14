<script lang="ts">
/**
 * One inline glyph.
 *
 * Codicons are a font the host loads for its own chrome. A webview does not
 * inherit it and the CSP forbids fetching one, so every glyph is a path.
 * All of them draw in `currentColor` so the caller's text token decides the
 * colour and no glyph carries a hardcoded one.
 */
import type { IconName } from "./icons";

let {
	name,
	size = 14,
	label,
}: { name: IconName; size?: number; label?: string } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 16 16"
	fill="none"
	aria-hidden={label ? undefined : "true"}
	aria-label={label}
	role={label ? "img" : undefined}
	class="inline-block shrink-0 align-[-0.125em]"
>
	{#if name === "error"}
		<circle cx="8" cy="8" r="6.3" fill="currentColor" />
		<path
			d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"
			stroke="var(--color-surface)"
			stroke-width="1.5"
			stroke-linecap="round"
		/>
	{:else if name === "warning"}
		<path d="M8 1.7l6.6 11.6H1.4L8 1.7z" fill="currentColor" />
		<path
			d="M8 6v3.3"
			stroke="var(--color-surface)"
			stroke-width="1.4"
			stroke-linecap="round"
		/>
		<circle cx="8" cy="11.4" r=".85" fill="var(--color-surface)" />
	{:else if name === "info"}
		<circle cx="8" cy="8" r="6.3" fill="currentColor" />
		<path
			d="M8 7.2v3.6"
			stroke="var(--color-surface)"
			stroke-width="1.5"
			stroke-linecap="round"
		/>
		<circle cx="8" cy="5.1" r=".85" fill="var(--color-surface)" />
	{:else if name === "link-external"}
		<path
			d="M9 2h5v5h-1.5V4.56L7.1 9.96 6.04 8.9l5.4-5.4H9V2z"
			fill="currentColor"
		/>
		<path
			d="M3 4h4v1.5H4.5v6h6V9H12v4H3V4z"
			fill="currentColor"
		/>
	{:else if name === "file"}
		<path
			d="M9.3 1.5H4a1 1 0 00-1 1v11a1 1 0 001 1h8a1 1 0 001-1V5.2L9.3 1.5zm-.1 1.9l2.4 2.4H9.2V3.4z"
			fill="currentColor"
		/>
	{:else if name === "chevron"}
		<path d="M6 4l4 4-4 4V4z" fill="currentColor" />
	{:else if name === "symbol-class"}
		<path
			d="M2.5 2.5h11v11h-11v-11zm1.4 1.4v8.2h8.2V3.9H3.9z"
			fill="currentColor"
		/>
		<path d="M5.4 5.4h5.2v1.4H5.4zM5.4 8h5.2v1.4H5.4z" fill="currentColor" />
	{:else if name === "symbol-interface"}
		<path
			d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.6a4.4 4.4 0 110 8.8 4.4 4.4 0 010-8.8z"
			fill="currentColor"
		/>
		<circle cx="8" cy="8" r="1.7" fill="currentColor" />
	{:else if name === "symbol-method"}
		<path
			d="M8 1.6l5.2 3v6.8l-5.2 3-5.2-3V4.6l5.2-3zm0 1.85L4.4 5.53v4.94L8 12.55l3.6-2.08V5.53L8 3.45z"
			fill="currentColor"
		/>
	{:else if name === "symbol-field"}
		<path
			d="M3 4.5h10V6H3zM3 7.25h10v1.5H3zM3 10h6.5v1.5H3z"
			fill="currentColor"
		/>
	{:else if name === "symbol-enum"}
		<path d="M8 1.8l5.5 3.1v6.2L8 14.2 2.5 11.1V4.9L8 1.8z" fill="currentColor" />
		<circle cx="8" cy="8" r="2.1" fill="var(--color-surface)" />
	{/if}
</svg>
