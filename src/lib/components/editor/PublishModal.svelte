<script lang="ts">
	import { Modal } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';

	export interface PublishModalBinding {
		/** Parameter name as it appears in the URL. */
		name: string;
		/** Default value applied when the URL omits this parameter. */
		default: string;
		/** Human-readable source property (e.g. "Text Content"). */
		sourceLabel: string;
	}

	interface Props {
		open: boolean;
		canvasId: string;
		slug: string;
		published: boolean;
		/** All unique parameter bindings present on the canvas, used to render
		 * the "Using this template" documentation section when published. */
		bindings?: PublishModalBinding[];
		onClose: () => void;
		/** Called after a successful publish or unpublish, with the new state. */
		onPublishedChange: (published: boolean) => void;
		/**
		 * Optional hook invoked before a publish request is sent. Use this to flush
		 * any pending editor changes so the published canvas reflects the latest
		 * state, not a stale autosave snapshot. Return false to abort the publish.
		 */
		onBeforePublish?: () => Promise<boolean>;
	}

	let {
		open,
		canvasId,
		slug,
		published,
		bindings = [],
		onClose,
		onPublishedChange,
		onBeforePublish
	}: Props = $props();

	let busy = $state(false);

	// Build URLs from the current origin so the copy values match the user's deployment.
	let origin = $derived(typeof window !== 'undefined' ? window.location.origin : '');
	let shareUrl = $derived(`${origin}/c/${slug}`);
	let imageUrl = $derived(`${origin}/c/${slug}/image.png`);

	/** Representative sample value per source type — used when a binding's
	 * default is an empty string, so the "example URL with all params filled
	 * in" gives authors something concrete to show API callers. */
	function sampleFor(sourceLabel: string): string {
		switch (sourceLabel) {
			case 'Text Content':
				return 'Hello';
			case 'Image Source':
				return 'https://example.com/pic.png';
			case 'Fill Color':
				return '#ff0000';
			default:
				return 'value';
		}
	}

	function buildQueryString(): string {
		if (bindings.length === 0) return '';
		const parts: string[] = [];
		for (const b of bindings) {
			if (!b.name) continue;
			const value = b.default || sampleFor(b.sourceLabel);
			parts.push(`${encodeURIComponent(b.name)}=${encodeURIComponent(value)}`);
		}
		return parts.length ? `?${parts.join('&')}` : '';
	}

	let exampleImageUrl = $derived(`${imageUrl}${buildQueryString()}`);
	let exampleShareUrl = $derived(`${shareUrl}${buildQueryString()}`);

	// Shell-safe cURL: single-quote the URL (and escape any single quotes
	// inside it). Public GET, no auth needed, so this is the whole story.
	function curlFor(url: string): string {
		const escaped = url.replace(/'/g, `'\\''`);
		return `curl -o canvas.png '${escaped}'`;
	}

	async function togglePublished(next: boolean) {
		if (busy) return;
		busy = true;
		try {
			// Flush any pending editor changes before publishing so consumers of the
			// share URL never see a stale render. We skip this on unpublish because
			// the canvas will be inaccessible anyway.
			if (next && onBeforePublish) {
				const flushed = await onBeforePublish();
				if (!flushed) {
					toast.error('Could not save pending changes — publish cancelled.');
					return;
				}
			}

			const res = await fetch(`/api/canvas/${canvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ published: next })
			});
			if (!res.ok) {
				toast.error(next ? 'Failed to publish canvas' : 'Failed to unpublish canvas');
				return;
			}
			onPublishedChange(next);
			toast.success(next ? 'Canvas published' : 'Canvas unpublished');
		} catch {
			toast.error(next ? 'Failed to publish canvas' : 'Failed to unpublish canvas');
		} finally {
			busy = false;
		}
	}

	async function copy(value: string, label: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied to clipboard`);
		} catch {
			toast.error(`Couldn't copy ${label.toLowerCase()}. Select the text and copy manually.`);
		}
	}
</script>

<Modal
	{open}
	title={published ? 'Share your canvas' : 'Publish this canvas'}
	width="34rem"
	{onClose}
>
	{#if !published}
		<p class="intro">
			Publishing makes this canvas available at a public URL. You can unpublish any time.
		</p>
		<div class="actions">
			<button
				type="button"
				class="btn btn-primary"
				disabled={busy}
				onclick={() => togglePublished(true)}
			>
				{busy ? 'Publishing…' : 'Publish canvas'}
			</button>
		</div>
	{:else}
		<p class="intro">
			Your canvas is live. Share the page URL, or use the image URL directly in an
			<code>og:image</code> tag or API call.
		</p>

		<div class="field">
			<label for="publish-share-url">Share page URL</label>
			<div class="copy-row">
				<input id="publish-share-url" type="text" readonly value={shareUrl} />
				<button type="button" class="btn btn-copy" onclick={() => copy(shareUrl, 'Share URL')}>
					Copy
				</button>
			</div>
			<p class="help">
				Humans see an OG preview + redirect; bots/crawlers get <code>og:image</code> meta tags.
			</p>
		</div>

		<div class="field">
			<label for="publish-image-url">Image URL</label>
			<div class="copy-row">
				<input id="publish-image-url" type="text" readonly value={imageUrl} />
				<button type="button" class="btn btn-copy" onclick={() => copy(imageUrl, 'Image URL')}>
					Copy
				</button>
			</div>
			<p class="help">
				Returns the rendered PNG directly. Append your dynamic parameters as query strings, e.g.
				<code>?title=Hello</code>.
			</p>
		</div>

		<section class="docs-section">
			<h3 class="docs-title">Using this template</h3>

			{#if bindings.length === 0}
				<p class="docs-empty">
					This canvas has no dynamic parameters. Bind properties in the editor (⚡ Dynamic
					Parameters in the property panel) to make the shared URL change based on query string
					values.
				</p>
			{:else}
				<p class="docs-hint">
					{bindings.length === 1 ? 'This canvas accepts' : 'This canvas accepts'}
					{bindings.length}
					{bindings.length === 1 ? 'parameter' : 'parameters'}. Omit any of them to fall back to the
					binding's default.
				</p>

				<div class="docs-table">
					<div class="docs-row docs-row-header">
						<span>Parameter</span>
						<span>Source</span>
						<span>Default</span>
					</div>
					{#each bindings as b (b.name)}
						<div class="docs-row">
							<code class="docs-param-name">{b.name}</code>
							<span class="docs-param-source">{b.sourceLabel}</span>
							<code class="docs-param-default">{b.default || '—'}</code>
						</div>
					{/each}
				</div>

				<div class="field">
					<label for="publish-example-image">Example image URL</label>
					<div class="copy-row">
						<input id="publish-example-image" type="text" readonly value={exampleImageUrl} />
						<button
							type="button"
							class="btn btn-copy"
							onclick={() => copy(exampleImageUrl, 'Example URL')}
						>
							Copy
						</button>
					</div>
				</div>

				<div class="field">
					<label for="publish-curl">Copy as cURL</label>
					<div class="copy-row">
						<input id="publish-curl" type="text" readonly value={curlFor(exampleImageUrl)} />
						<button
							type="button"
							class="btn btn-copy"
							onclick={() => copy(curlFor(exampleImageUrl), 'cURL command')}
						>
							Copy
						</button>
					</div>
					<p class="help">
						Downloads the rendered PNG to <code>canvas.png</code>. No auth required — public
						endpoint.
					</p>
				</div>

				<div class="field">
					<label for="publish-example-share">Example share URL</label>
					<div class="copy-row">
						<input id="publish-example-share" type="text" readonly value={exampleShareUrl} />
						<button
							type="button"
							class="btn btn-copy"
							onclick={() => copy(exampleShareUrl, 'Example share URL')}
						>
							Copy
						</button>
					</div>
				</div>
			{/if}
		</section>

		<div class="unpublish">
			<button
				type="button"
				class="btn btn-secondary"
				disabled={busy}
				onclick={() => togglePublished(false)}
			>
				{busy ? 'Unpublishing…' : 'Unpublish'}
			</button>
		</div>
	{/if}
</Modal>

<style>
	.intro {
		margin: 0 0 1rem;
		color: #444;
		line-height: 1.5;
	}

	.intro code {
		font-size: 0.85em;
		background: #f1f5f9;
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}

	.field {
		margin-bottom: 1rem;
	}

	.field label {
		display: block;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #111;
		margin-bottom: 0.3rem;
	}

	.copy-row {
		display: flex;
		gap: 0.4rem;
	}

	.copy-row input {
		flex: 1;
		padding: 0.45rem 0.6rem;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.8125rem;
		background: #f9fafb;
		color: #111;
	}

	.help {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: #6b7280;
		line-height: 1.4;
	}

	.help code {
		background: #f1f5f9;
		padding: 0 0.25rem;
		border-radius: 3px;
	}

	.actions {
		display: flex;
		justify-content: flex-start;
		margin-top: 0.5rem;
	}

	.unpublish {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid #eee;
	}

	.btn {
		padding: 0.45rem 0.9rem;
		border-radius: 5px;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 2px;
	}

	.btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.btn-primary:hover:not(:disabled) {
		background: #1d4ed8;
	}

	.btn-secondary {
		background: #fff;
		color: #374151;
		border-color: #d1d5db;
	}

	.btn-secondary:hover:not(:disabled) {
		background: #f3f4f6;
	}

	.btn-copy {
		background: #111;
		color: #fff;
	}

	.btn-copy:hover {
		background: #333;
	}

	.docs-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid #eee;
	}

	.docs-title {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: #111;
	}

	.docs-hint,
	.docs-empty {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
		color: #4b5563;
		line-height: 1.5;
	}

	.docs-empty {
		background: #f9fafb;
		border: 1px dashed #d1d5db;
		border-radius: 5px;
		padding: 0.625rem 0.75rem;
	}

	.docs-table {
		margin-bottom: 1rem;
		border: 1px solid #e5e7eb;
		border-radius: 5px;
		overflow: hidden;
		font-size: 0.8125rem;
	}

	.docs-row {
		display: grid;
		grid-template-columns: 1.1fr 1fr 1fr;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid #f1f5f9;
		align-items: center;
	}

	.docs-row:last-child {
		border-bottom: none;
	}

	.docs-row-header {
		background: #f8fafc;
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #64748b;
		font-weight: 600;
	}

	.docs-param-name,
	.docs-param-default {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.75rem;
		background: #f1f5f9;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		overflow-x: auto;
		white-space: nowrap;
	}

	.docs-param-source {
		color: #4b5563;
	}
</style>
