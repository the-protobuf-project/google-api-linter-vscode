<script lang="ts">
/**
 * One inline glyph, drawn in `currentColor`.
 *
 * The CSP forbids fetching the codicon font, so every glyph is a path and
 * the caller's text token decides its colour.
 */
import type { IconName } from "./model";

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
	{#if name === "registry"}
		<path
			d="M8 1.5c-2 0-3.6.6-3.6 1.4v10.2c0 .8 1.6 1.4 3.6 1.4s3.6-.6 3.6-1.4V2.9c0-.8-1.6-1.4-3.6-1.4zm0 1.1c1.6 0 2.5.4 2.5.6s-.9.6-2.5.6-2.5-.4-2.5-.6.9-.6 2.5-.6z"
			fill="currentColor"
		/>
		<path
			d="M13.5 5.2v7.6c0 1.2-1.4 2-3 2.2v-1.1c1.1-.2 1.9-.6 1.9-1.1V5.2h1.1z"
			fill="currentColor"
			opacity=".55"
		/>
	{:else if name === "package"}
		<path
			d="M8 1.6l5.6 2.9v7L8 14.4 2.4 11.5v-7L8 1.6zm0 1.7L4.3 5.2 8 7.1l3.7-1.9L8 3.3zM3.8 6.5v4.1L7.3 12.4V8.3L3.8 6.5zm4.9 1.8v4.1l3.5-1.8V6.5L8.7 8.3z"
			fill="currentColor"
		/>
	{:else if name === "plug"}
		<path
			d="M5.6 1.5v3.1H4.2v3.2c0 1.7 1.2 3.1 2.8 3.5v3.2h2v-3.2c1.6-.4 2.8-1.8 2.8-3.5V4.6h-1.4V1.5h-1.5v3.1H7.1V1.5H5.6z"
			fill="currentColor"
		/>
	{:else if name === "sync"}
		<path
			d="M2.8 6.4A5.3 5.3 0 0112.6 5M13.2 9.6A5.3 5.3 0 013.4 11"
			stroke="currentColor"
			stroke-width="1.5"
		/>
		<path d="M12.9 1.9v3.5H9.6zM3.1 14.1v-3.5h3.3z" fill="currentColor" />
	{:else if name === "plus"}
		<path
			d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25z"
			fill="currentColor"
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
	{:else if name === "check"}
		<path
			d="M3.5 8.4l3 3 6-6.8"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{:else if name === "search"}
		<circle cx="6.8" cy="6.8" r="4.3" stroke="currentColor" stroke-width="1.4" />
		<path
			d="M10 10l3.4 3.4"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
		/>
	{:else if name === "external-link"}
		<path
			d="M9 2h5v5h-1.5V4.56L7.1 9.96 6.04 8.9l5.4-5.4H9V2z"
			fill="currentColor"
		/>
		<path d="M3 4h4v1.5H4.5v6h6V9H12v4H3V4z" fill="currentColor" />
	{:else if name === "github"}
		<path
			d="M8 1a7 7 0 00-2.2 13.6c.35.07.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.81-.78-1.03-.78-1.03-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.63 1.07 1.65.76 2.05.58.06-.45.25-.76.45-.94-1.56-.18-3.2-.78-3.2-3.47 0-.77.28-1.4.73-1.89-.07-.18-.32-.9.07-1.87 0 0 .6-.19 1.95.72a6.8 6.8 0 013.55 0c1.35-.91 1.94-.72 1.94-.72.39.97.15 1.69.07 1.87.46.49.73 1.12.73 1.89 0 2.7-1.64 3.29-3.2 3.46.25.22.48.65.48 1.31v1.95c0 .19.13.41.49.34A7 7 0 008 1z"
			fill="currentColor"
		/>
	{/if}
</svg>
