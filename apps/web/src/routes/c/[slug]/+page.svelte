<script lang="ts">
	import RenderLanding from '$lib/components/share/RenderLanding.svelte';

	let { data } = $props();
</script>

<!--
	Public landing page for `/c/{slug}` — the live, template-resolved
	render. The interstitial markup, OG meta, and Continue-to CTA live
	in `<RenderLanding>` so `/i/{shortId}` (baked render, TASK-170) can
	share the same UX. Behavior between the two surfaces is identical
	by design — IDEA-161 Q7 picks one v1 model so crawler fixtures
	apply to both.
-->
<RenderLanding
	imageUrl={data.imageUrl}
	canonicalShareUrl={data.canonicalShareUrl}
	ogTitle={data.ogTitle}
	ogDescription={data.ogDescription}
	width={data.canvas.width}
	height={data.canvas.height}
	redirectUrl={data.redirectUrl}
/>
