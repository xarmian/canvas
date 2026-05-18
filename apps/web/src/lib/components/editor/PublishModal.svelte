<script lang="ts">
	import { Modal, Button } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import CopyUrlRow from './publish/CopyUrlRow.svelte';
	import SharingFields from './publish/SharingFields.svelte';
	import SlugEditor from './publish/SlugEditor.svelte';
	import SocialValidator from './publish/SocialValidator.svelte';

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
		/** Parameter bindings on the canvas. Used by <SharingFields>'s
		 *  redirect-URL placeholder validator (the "did you mean X?"
		 *  suggestion list reads the binding names). After TASK-244,
		 *  the docs-section that used the rich `liveValues`/`bindingsStale`
		 *  shape moved out — <EmbedDrawer> reads its own reactive
		 *  bindings/liveValues from editor-page state. */
		bindings?: PublishModalBinding[];
		onClose: () => void;
		/** Called after a successful publish or unpublish, with the new state. */
		onPublishedChange: (published: boolean) => void;
		/**
		 * Optional hook invoked before a publish request is sent. Use this to flush
		 * any pending editor changes so the published canvas reflects the latest
		 * state. Return false to abort the publish.
		 */
		onBeforePublish?: () => Promise<boolean>;
		/**
		 * Called after a successful slug rename (TASK-98) so the parent
		 * editor can update its local mirror of the slug — that
		 * propagates to share URLs, image URLs, og snippets, etc.
		 */
		onSlugChange?: (newSlug: string) => void;
	}

	let {
		open,
		canvasId,
		slug,
		published,
		bindings = [],
		onClose,
		onPublishedChange,
		onBeforePublish,
		onSlugChange
	}: Props = $props();

	let busy = $state(false);

	// Per-param schema flags + paramRows lifecycle moved into
	// ParamsPanel's Schema tab (TASK-244). PublishModal is now focused
	// purely on the publish + share surface; schema editing has one
	// home (ParamsPanel) and one server flow (its persistFlag → PATCH).
	//
	// versionToken + loadVersionToken + the EmbedSnippets mount moved
	// to <EmbedDrawer> in TASK-240. The drawer owns its own
	// versionToken + paramRows fetches independently — TASK-245
	// consolidates with ParamsPanel's at editor-page state.
	//
	// Sharing & redirect (TASK-95) extracted to <SharingFields> in
	// TASK-237. The component owns its own GET / blur-commit /
	// placeholder validator lifecycle keyed on `open`, `published`,
	// and `canvasId`.
	//
	// Slug rename (TASK-98) extracted to <SlugEditor> in TASK-235. The
	// entire state machine + ETag / If-Match handling lives there;
	// PublishModal just forwards `slug`, `canvasId`, `open`, and the
	// `onSlugChange` callback.

	// Build URLs from the current origin so the copy values match the user's deployment.
	let origin = $derived(typeof window !== 'undefined' ? window.location.origin : '');
	let shareUrl = $derived(`${origin}/c/${slug}`);
	let imageUrl = $derived(`${origin}/c/${slug}/image.png`);

	// sampleFor / resolveExampleValue / resolvedParams / exampleQuery /
	// exampleImageUrl / exampleShareUrl moved out with the docs-section
	// in TASK-244. The drawer's <EmbedSnippets> owns its own copies
	// (already extracted in TASK-236); SharingFields kept its own
	// `sampleFor` (TASK-237) for the redirect placeholder validator.
	// Both can consolidate into a shared module once a third consumer
	// shows up.

	// `paramSchemas` derivation moved to <EmbedDrawer> with <EmbedSnippets>
	// in TASK-240. The modal no longer needs typed-TS schema info because
	// the embed snippet generator no longer lives here.

	// Snippet generation + tablist + EMBED_TABS + onTabKeydown moved
	// into <EmbedSnippets> in TASK-236; <EmbedSnippets> itself then
	// relocated to <EmbedDrawer> in TASK-240. PublishModal no longer
	// hosts any embed-snippet code.

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
			<Button variant="primary" loading={busy} onclick={() => togglePublished(true)}>
				{busy ? 'Publishing…' : 'Publish canvas'}
			</Button>
		</div>
	{:else}
		<p class="intro">
			Your canvas is live. Share the page URL, or use the image URL directly in an
			<code>og:image</code> tag or API call.
		</p>

		<SlugEditor {canvasId} {slug} {open} {onSlugChange} />

		<CopyUrlRow id="publish-share-url" label="Share page URL" url={shareUrl} copyLabel="Share URL">
			{#snippet helpHtml()}
				Humans see an OG preview + redirect; bots/crawlers get <code>og:image</code> meta tags.
			{/snippet}
		</CopyUrlRow>

		<CopyUrlRow id="publish-image-url" label="Image URL" url={imageUrl} copyLabel="Image URL">
			{#snippet helpHtml()}
				Returns the rendered PNG directly. Append dynamic values as query strings, e.g.
				<code>?title=Hello</code>.
			{/snippet}
		</CopyUrlRow>

		<SharingFields {canvasId} {open} {published} {bindings} />

		<SocialValidator {shareUrl} />

		<!--
			The "Using this template" docs section — schema editor +
			example URL rows — moved out of PublishModal in TASK-244.
			Schema editing lives in ParamsPanel's Schema tab; example
			URLs are reconstituted inside <EmbedDrawer>'s snippet
			generator. PublishModal is now the focused "publish + share"
			surface PLAN-232 set out to land on.
		-->

		<div class="unpublish">
			<Button variant="secondary" loading={busy} onclick={() => togglePublished(false)}>
				{busy ? 'Unpublishing…' : 'Unpublish'}
			</Button>
		</div>
	{/if}
</Modal>

<style>
	.intro {
		margin: 0 0 1rem;
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.intro code {
		font-size: 0.85em;
		background: var(--color-surface-muted);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}

	/*
	 * `.field` / `.copy-row` / `.help` / `.url-input` were used by the
	 * slug, share-URL, image-URL, sharing-fields, and example-URL rows
	 * that used to live here directly. Every consumer is now a
	 * sub-component (<SlugEditor>, <CopyUrlRow>, <SharingFields>) that
	 * scopes its own copies of those rules. The modal no longer renders
	 * any raw form rows so these selectors moved with their consumers.
	 */

	.actions {
		display: flex;
		justify-content: flex-start;
		margin-top: 0.5rem;
	}

	.unpublish {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}

	/*
	 * The `.btn-secondary` variant moved out with <SocialValidator>
	 * (TASK-233); `.btn-link` moved out with <EmbedSnippets> (TASK-236).
	 * No anchor-styled buttons remain in this file.
	 */

	/*
	 * The bindings table + its error/skeleton/warning/empty/hint rules
	 * moved into <ParamSchemaEditor> in TASK-238. The .docs-section
	 * + .docs-title wrappers + the example-URL CopyUrlRows moved out
	 * with the docs section itself in TASK-244. The modal's stylesheet
	 * is now just intro chrome + the unpublish footer.
	 */
</style>
