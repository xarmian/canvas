<script lang="ts">
	/**
	 * SVG-based preview of a starter template.
	 *
	 * Renders the template's templateJson.objects as scaled SVG rects + text
	 * inside a viewBox sized to the canvas dimensions. SVG (vs. PNG) keeps
	 * the gallery zero-asset — every preview is generated from the same
	 * data the editor loads, so they stay in lockstep when we tune defaults.
	 *
	 * Why this is a separate component (not inline in the gallery page):
	 * future tasks (canvas duplication, dashboard reorganization) can
	 * reuse it to show a thumbnail of any canvas's templateJson without
	 * round-tripping through the renderer.
	 *
	 * Trade-off: SVG <text> doesn't perfectly match Skia/Fabric word
	 * wrapping at small sizes — but a thumbnail's job is "looks like the
	 * thing", not "pixel-identical to the render." The full render is one
	 * click away in the editor.
	 */
	import type { TemplateDefinition } from '$lib/templates/gallery';

	let { template, ariaLabel }: { template: TemplateDefinition; ariaLabel?: string } = $props();

	let { width, height, backgroundValue, templateJson } = $derived(template.canvas);
</script>

<svg
	viewBox="0 0 {width} {height}"
	preserveAspectRatio="xMidYMid meet"
	role="img"
	aria-label={ariaLabel ?? `${template.name} preview`}
	xmlns="http://www.w3.org/2000/svg"
>
	<rect x="0" y="0" {width} {height} fill={backgroundValue} />
	{#each templateJson.objects as obj, i (i)}
		{#if obj.type === 'Rect'}
			<rect
				x={obj.left}
				y={obj.top}
				width={obj.width}
				height={obj.height}
				fill={obj.fill}
				rx={obj.rx ?? 0}
				ry={obj.ry ?? 0}
			/>
		{:else if obj.type === 'Textbox'}
			<!--
				Render the textbox as a single <text> baseline-anchored to the
				top of its bounding box. Fabric's Textbox wraps within `width`
				at the given `fontSize`; SVG <text> doesn't auto-wrap, so for
				preview fidelity we just render the first line. Most templates
				keep their headlines short enough that the preview matches.
			-->
			<text
				x={obj.textAlign === 'center'
					? obj.left + obj.width / 2
					: obj.textAlign === 'right'
						? obj.left + obj.width
						: obj.left}
				y={obj.top + obj.fontSize}
				font-family={obj.fontFamily}
				font-size={obj.fontSize}
				font-weight={obj.fontWeight ?? 400}
				fill={obj.fill}
				text-anchor={obj.textAlign === 'center'
					? 'middle'
					: obj.textAlign === 'right'
						? 'end'
						: 'start'}
			>
				{obj.text}
			</text>
		{/if}
	{/each}
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: 100%;
		background: #fff;
	}
</style>
