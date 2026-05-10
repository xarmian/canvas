<script lang="ts">
	import type { Component, Snippet } from 'svelte';

	interface Props {
		/** Optional icon component (lucide). Rendered at the top of the
		 *  state surface, sized to match the title. Pass any
		 *  `@lucide/svelte` icon: `<EmptyState icon={Folder} … />`. */
		icon?: Component<{ size?: number | string; class?: string }>;
		/** Headline copy. Required — every empty state has a name. */
		title: string;
		/** One or two sentence description explaining what's empty and
		 *  what the user can do. Required so empty states aren't a bare
		 *  title with no context. */
		description: string;
		/** Optional CTA snippet — typically a `<Button>`. Renders below
		 *  the description with comfortable spacing. */
		cta?: Snippet;
	}

	let { icon: IconComponent, title, description, cta }: Props = $props();
</script>

<div class="empty-state" role="status">
	{#if IconComponent}
		<span class="empty-icon" aria-hidden="true">
			<IconComponent size={32} />
		</span>
	{/if}
	<h3 class="empty-title">{title}</h3>
	<p class="empty-description">{description}</p>
	{#if cta}
		<div class="empty-cta">
			{@render cta()}
		</div>
	{/if}
</div>

<style>
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.5rem;
		padding: 1.5rem 1rem;
		max-width: 28rem;
		margin: 0 auto;
		color: #374151;
	}

	.empty-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 9999px;
		background: #f3f4f6;
		color: #6b7280;
		margin-bottom: 0.25rem;
	}

	.empty-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #111827;
		line-height: 1.3;
	}

	.empty-description {
		margin: 0;
		font-size: 0.875rem;
		color: #6b7280;
		line-height: 1.5;
	}

	.empty-cta {
		margin-top: 0.75rem;
	}
</style>
