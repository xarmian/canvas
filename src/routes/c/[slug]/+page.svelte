<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<!-- OG Meta Tags (TASK-97) -->
	<title>{data.ogTitle}</title>
	<meta property="og:title" content={data.ogTitle} />
	<meta property="og:description" content={data.ogDescription} />
	<meta property="og:image" content={data.imageUrl} />
	<meta property="og:image:width" content={String(data.canvas.width)} />
	<meta property="og:image:height" content={String(data.canvas.height)} />
	<!-- og:image:type: required by some crawlers (LinkedIn, older Slack)
	     to skip the binary-sniff step. The share page always emits a
	     PNG image URL — JPEG/WebP/AVIF are alternate render formats
	     consumers can request explicitly via the file extension, but
	     the social-card path is hard-coded to PNG. -->
	<meta property="og:image:type" content="image/png" />
	{#if data.imageUrl.startsWith('https://')}
		<!-- og:image:secure_url is the same value when the public app
		     URL is https. Crawlers prefer this on https pages and
		     omitting it can cause inline-card downgrades. We emit it
		     conditionally so localhost dev (http) doesn't put a bogus
		     https URL in the head. -->
		<meta property="og:image:secure_url" content={data.imageUrl} />
	{/if}
	<meta property="og:url" content={data.canonicalShareUrl} />
	<meta property="og:type" content="website" />

	<!-- Twitter Card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={data.ogTitle} />
	<meta name="twitter:description" content={data.ogDescription} />
	<meta name="twitter:image" content={data.imageUrl} />

	<meta name="description" content={data.ogDescription} />
</svelte:head>

<!-- Landing page for human visitors when no redirect is configured -->
<div class="landing">
	<div class="card">
		<img src={data.imageUrl} alt={data.ogTitle} class="preview" />
		<h1>{data.ogTitle}</h1>
		<p>{data.ogDescription}</p>
		<p class="meta">
			{data.canvas.width} × {data.canvas.height} · Created with
			<a href="/">Canvas</a>
		</p>
	</div>
</div>

<style>
	.landing {
		display: flex;
		justify-content: center;
		align-items: center;
		min-height: 100vh;
		background: #f5f5f5;
		padding: 2rem;
	}

	.card {
		background: white;
		border-radius: 12px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1);
		max-width: 640px;
		width: 100%;
		overflow: hidden;
		text-align: center;
	}

	.preview {
		width: 100%;
		height: auto;
		display: block;
	}

	h1 {
		margin: 1.5rem 1.5rem 0.5rem;
		font-size: 1.5rem;
	}

	p {
		margin: 0 1.5rem 1rem;
		color: #6b7280;
	}

	.meta {
		font-size: 0.875rem;
		padding-bottom: 1.5rem;
	}

	a {
		color: #2563eb;
	}
</style>
