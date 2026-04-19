<script lang="ts">
	import { Modal } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';

	interface Props {
		open: boolean;
		canvasId: string;
		slug: string;
		published: boolean;
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

	let { open, canvasId, slug, published, onClose, onPublishedChange, onBeforePublish }: Props =
		$props();

	let busy = $state(false);

	// Build URLs from the current origin so the copy values match the user's deployment.
	let origin = $derived(typeof window !== 'undefined' ? window.location.origin : '');
	let shareUrl = $derived(`${origin}/c/${slug}`);
	let imageUrl = $derived(`${origin}/c/${slug}/image.png`);

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
</style>
