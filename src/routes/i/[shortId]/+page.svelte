<script lang="ts">
	import RenderLanding from '$lib/components/share/RenderLanding.svelte';

	let { data } = $props();
</script>

<!--
	Public landing page for `/i/{shortId}` — the baked render permalink.
	Markup, OG meta, and interstitial CTA come from the shared
	`<RenderLanding>` component so the UX is identical to `/c/{slug}`.
	The image URL points at `/i/{shortId}/image.{ext}` (TASK-171); the
	page server only carries the OG / display metadata.
-->
<RenderLanding
	imageUrl={data.imageUrl}
	imageMimeType={data.imageMimeType}
	canonicalShareUrl={data.canonicalShareUrl}
	ogTitle={data.ogTitle}
	ogDescription={data.ogDescription}
	width={data.width}
	height={data.height}
	redirectUrl={data.redirectUrl}
/>
