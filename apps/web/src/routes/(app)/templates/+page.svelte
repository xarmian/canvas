<script lang="ts">
	/**
	 * Template gallery — solves the blank-canvas problem.
	 *
	 * Each card shows an SVG preview of the template's templateJson and a
	 * "Use this template" button that POSTs the template's full canvas
	 * payload to /api/canvas, then navigates to the editor. Templates are
	 * static JSON (see $lib/templates/gallery), so no extra API roundtrip
	 * is needed to fetch them.
	 *
	 * Why no per-card preview render via /c/[slug]: the templates aren't
	 * persisted as canvases — they only become canvases when a user picks
	 * one. Generating a preview without a backing canvas would either
	 * require a "render-from-blob" endpoint (extra surface area, security
	 * questions) or pre-baking PNGs (extra build step). The SVG mockup is
	 * good enough at thumbnail scale and stays in lockstep with the JSON.
	 */
	import { goto } from '$app/navigation';
	import { toast } from '$lib/stores/toast.svelte';
	import TemplatePreview from '$lib/components/templates/TemplatePreview.svelte';
	import type { TemplateDefinition } from '$lib/templates/gallery';
	import { Button, EmptyState } from '$lib/components/ui';
	import { LayoutTemplate } from '@lucide/svelte';

	let { data } = $props();

	// Track per-card click state so a user double-clicking the same card
	// doesn't create two canvases — keyed by template id, not by a single
	// global flag, so the user can still browse other cards while one is
	// in-flight (which is rare but possible if the network is slow).
	let creatingId = $state<string | null>(null);

	async function useTemplate(template: TemplateDefinition) {
		if (creatingId !== null) return;
		creatingId = template.id;
		try {
			const res = await fetch('/api/canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(template.canvas)
			});
			if (!res.ok) {
				toast.error(`Could not create "${template.name}". Try again.`);
				return;
			}
			const created = (await res.json()) as { id: string };
			await goto(`/canvas/${created.id}/edit`);
		} catch {
			toast.error(`Could not create "${template.name}". Check your connection and try again.`);
		} finally {
			creatingId = null;
		}
	}
</script>

<svelte:head>
	<title>Templates | Canvas</title>
</svelte:head>

<div class="page">
	<header class="header">
		<div>
			<h1>Templates</h1>
			<p class="lede">
				Pick a starter, customize it in the editor, then publish. Every template has dynamic values
				you can change — try editing the values in the published URL to see dynamic generation in
				action.
			</p>
		</div>
		<a href="/dashboard" class="btn btn-secondary">Back to dashboard</a>
	</header>

	{#if data.templates.length === 0}
		<!--
			Empty state — the templates collection ships with the build,
			so this only fires if the gallery export is empty (e.g. a
			refactor unintentionally clears it). EmptyState gives that
			a designed surface instead of a blank grid.
		-->
		<div class="empty-wrapper">
			<EmptyState
				icon={LayoutTemplate}
				title="No templates available"
				description="Templates will appear here as they're added to the gallery. In the meantime you can start a blank canvas."
			/>
		</div>
	{:else}
		<div class="grid">
			{#each data.templates as template (template.id)}
				<article class="card" data-testid="template-card" data-template-id={template.id}>
					<div class="preview">
						<TemplatePreview {template} />
					</div>
					<div class="body">
						<h2 class="name">{template.name}</h2>
						<p class="meta">
							{template.canvas.width} &times; {template.canvas.height} ·
							<span class="category">{template.category}</span>
						</p>
						<p class="description">{template.description}</p>
						<!--
							Per-card creation indicator: Button's `loading` prop
							supplies the spinner + aria-busy. Other cards' buttons
							are still `disabled` (via the `creatingId !== null`
							check) so a slow network can't queue duplicate POSTs,
							but only the in-flight card shows the spinner.
						-->
						<Button
							variant="primary"
							onclick={() => useTemplate(template)}
							disabled={creatingId !== null && creatingId !== template.id}
							loading={creatingId === template.id}
							data-testid="template-use"
						>
							{creatingId === template.id ? 'Creating…' : 'Use this template'}
						</Button>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem 1rem;
	}

	.header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 2rem;
		margin-bottom: 2rem;
	}

	.header h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 0.5rem;
	}

	.lede {
		margin: 0;
		max-width: 640px;
		color: #475569;
		line-height: 1.55;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1.25rem;
	}

	@media (max-width: 900px) {
		.grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (max-width: 550px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	.card {
		display: flex;
		flex-direction: column;
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		background: #fff;
		overflow: hidden;
	}

	.preview {
		aspect-ratio: 1.6;
		background: #f8fafc;
		border-bottom: 1px solid #e5e7eb;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.body {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.name {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #0f172a;
	}

	/*
	 * BT-159: was `#94a3b8` (slate-400), which gave ~2.85:1 contrast
	 * against the white card background — fails WCAG AA's 4.5:1 floor
	 * for body text. axe-core flagged this on every template card
	 * (20 nodes). Switched to `--color-text-subtle` (#6b7280, slate-
	 * 500) which lands at ~4.83:1 — clears the AA floor while keeping
	 * the meta line visually subordinate to the card's `.name`
	 * heading.
	 */
	.meta {
		margin: 0;
		font-size: 0.8rem;
		color: var(--color-text-subtle);
	}

	.category {
		text-transform: capitalize;
	}

	.description {
		margin: 0 0 0.5rem;
		font-size: 0.875rem;
		color: #475569;
		line-height: 1.45;
	}

	/*
	 * "Back to dashboard" stays an anchor so it navigates without JS.
	 * The remaining .btn / .btn-secondary rules size the link to match
	 * the canonical Button primitive's md size.
	 */
	.btn {
		display: inline-flex;
		justify-content: center;
		align-items: center;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		text-decoration: none;
		border: 1px solid transparent;
	}

	.btn-secondary {
		background: var(--color-bg);
		color: var(--color-text);
		border-color: var(--color-border-strong);
	}

	.btn-secondary:hover {
		background: var(--color-surface-muted);
	}

	.empty-wrapper {
		display: flex;
		justify-content: center;
		padding: var(--spacing-8) var(--spacing-4);
	}
</style>
