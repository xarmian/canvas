<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		/** Number of placeholder rows to render. When `lines` is set, each
		 *  row is a fixed-height bar with a slightly random width so the
		 *  skeleton reads like text rather than a flat block. Mutually
		 *  exclusive with `aspectRatio` — if both are set, `aspectRatio`
		 *  wins (the call is asking for a single image-shaped skeleton). */
		lines?: number;
		/** CSS `aspect-ratio` value (e.g. `'16 / 9'`, `'1 / 1'`). When set,
		 *  renders a single block sized by aspect ratio — useful for image,
		 *  card, or video skeletons. */
		aspectRatio?: string;
		/** Explicit width override. Defaults to `100%` so the skeleton fills
		 *  its container. Accepts any CSS length. */
		width?: string;
		/** Explicit height override. Ignored when `lines` or `aspectRatio`
		 *  is set (those compute their own height). */
		height?: string;
		class?: HTMLAttributes<HTMLDivElement>['class'];
	}

	let { lines, aspectRatio, width = '100%', height, class: className, ...rest }: Props = $props();

	// Pre-compute random-but-stable widths per line so the skeleton looks
	// like text instead of a uniform block. Uses a seeded sequence rather
	// than Math.random() so SSR + hydration produce the same widths
	// (avoiding a hydration-mismatch warning if the component renders on
	// the server). The seed is derived from the line index alone, which
	// is stable across renders.
	function lineWidth(index: number, total: number): string {
		// Last line is short to mimic an end-of-paragraph cap; other lines
		// vary 80–100% of full width using a deterministic hash.
		if (index === total - 1) return '60%';
		const pseudo = ((index + 1) * 2654435761) % 100; // Knuth-style hash
		const pct = 80 + (pseudo % 21); // 80..100
		return `${pct}%`;
	}
</script>

{#if aspectRatio}
	<div
		{...rest}
		class={['skeleton', 'skeleton-block', className]}
		style="width: {width}; aspect-ratio: {aspectRatio};"
		role="status"
		aria-busy="true"
		aria-label="Loading"
	></div>
{:else if lines && lines > 0}
	<div
		{...rest}
		class={['skeleton-lines', className]}
		style="width: {width};"
		role="status"
		aria-busy="true"
		aria-label="Loading"
	>
		{#each Array.from({ length: lines }), i (i)}
			<span class="skeleton skeleton-line" style="width: {lineWidth(i, lines)};" aria-hidden="true"
			></span>
		{/each}
	</div>
{:else}
	<div
		{...rest}
		class={['skeleton', 'skeleton-block', className]}
		style="width: {width}; height: {height ?? '1rem'};"
		role="status"
		aria-busy="true"
		aria-label="Loading"
	></div>
{/if}

<style>
	.skeleton {
		display: block;
		background: linear-gradient(90deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%);
		background-size: 200% 100%;
		animation: shimmer 1.4s ease-in-out infinite;
		border-radius: 4px;
	}

	.skeleton-block {
		min-height: 0.75rem;
	}

	.skeleton-lines {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.skeleton-line {
		height: 0.75rem;
		display: block;
		background: linear-gradient(90deg, #e5e7eb 0%, #f3f4f6 50%, #e5e7eb 100%);
		background-size: 200% 100%;
		animation: shimmer 1.4s ease-in-out infinite;
		border-radius: 3px;
	}

	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}

	/* Respect prefers-reduced-motion: hold the shimmer static. The
	 * solid-color base still reads as "this content is loading"; the
	 * aria-busy attribute keeps assistive tech informed regardless. */
	@media (prefers-reduced-motion: reduce) {
		.skeleton,
		.skeleton-line {
			animation: none;
			background: #e5e7eb;
		}
	}
</style>
