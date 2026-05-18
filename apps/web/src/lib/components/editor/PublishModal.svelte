<script lang="ts">
	import { Modal, Button } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import CopyUrlRow from './publish/CopyUrlRow.svelte';
	import ParamSchemaEditor from './publish/ParamSchemaEditor.svelte';
	import SharingFields from './publish/SharingFields.svelte';
	import SlugEditor from './publish/SlugEditor.svelte';
	import SocialValidator from './publish/SocialValidator.svelte';
	import { buildQueryString, curlFor } from '$lib/embed/snippets';

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
		/** Current user-typed test values from the editor's params panel,
		 * keyed by param name. When provided, snippet generators prefer
		 * `liveValues[name]` over the binding's default — so the
		 * copy-paste snippets reflect what the user is previewing in the
		 * editor right now, not just the canonical defaults. Reactivity
		 * contract: the parent passes its $state-backed `testParams`
		 * object directly, so edits in the params panel flow into the
		 * modal's derived snippet text on the next microtask without
		 * needing to close/reopen the modal. Empty-string values are
		 * treated as "use the binding default" to match the public
		 * renderer's omit-to-default semantics. */
		liveValues?: Record<string, string>;
		/** Set when the editor couldn't fully persist pending edits before
		 * opening the modal — the bindings snapshot may not match what
		 * /c/[slug]/image.png currently renders. We still render the docs
		 * section because the Unpublish button lives here, but show an
		 * inline warning so the user isn't misled. */
		bindingsStale?: boolean;
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
		liveValues = {},
		bindingsStale = false,
		onClose,
		onPublishedChange,
		onBeforePublish,
		onSlugChange
	}: Props = $props();

	let busy = $state(false);

	// --- Per-param schema flags (TASK-52) ---
	// Loaded lazily when the modal opens for a published canvas. Edits are
	// persisted via PATCH /api/canvas/[id] with { params: [...] } so we
	// don't need a separate roundtrip per row.
	interface ParamRow {
		name: string;
		type: string;
		required: boolean;
	}
	let paramRows = $state<ParamRow[]>([]);
	let paramRowsLoaded = $state(false);
	/** Set when the GET /params fetch returns non-OK or rejects. Drives
	 *  the inline ErrorState in the docs section so the failure isn't
	 *  silently swallowed (TASK-136). */
	let paramRowsError = $state(false);
	/** Monotonic generation counter for loadParamSchema requests. Bumped
	 *  at request start; the stale-guard checks the captured token so
	 *  a late completion from canvas A (or a closed modal) can't write
	 *  schema rows / errors over canvas B's live state. Mirrors the
	 *  pattern used by loadSharing (Codex round 1 of TASK-136 P2). */
	let paramRowsGen = 0;
	/** In-flight gate: while a /params request is pending, the $effect
	 *  must NOT kick off a second one. Without this, a re-render
	 *  triggered by a sibling state change (sharingLoaded /
	 *  versionToken / sharingPending) while `paramRowsLoaded` is still
	 *  false would re-enter loadParamSchema, and a slow late completion
	 *  could stale out the earlier successful response and then fail —
	 *  surfacing an error banner over freshly-loaded rows. Mirrors
	 *  ParamsPanel's `schemaPending` (Codex round 2 of TASK-136 P2). */
	let paramRowsPending = $state(false);

	// Sharing & redirect (TASK-95) extracted to <SharingFields> in
	// TASK-237. The component owns its own GET / blur-commit /
	// placeholder validator lifecycle keyed on `open`, `published`,
	// and `canvasId`.

	$effect(() => {
		if (open && published && !paramRowsLoaded && !paramRowsPending) {
			void loadParamSchema();
		}
		if (!open) {
			// Reset paramRows so reopening for a different canvas
			// refetches. Sharing + slug state lives in their own
			// components and resets itself when `open` flips.
			paramRowsLoaded = false;
			paramRowsError = false;
			paramRows = [];
			paramRowsGen++;
			paramRowsPending = false;
		}
	});

	// versionToken + loadVersionToken + the EmbedSnippets mount + the
	// paramSchemas derived all moved out with <EmbedSnippets> when it
	// relocated to <EmbedDrawer> (TASK-240). The drawer owns its own
	// versionToken + paramRows fetches keyed on its open state — until
	// TASK-245 deduplicates the two GETs.

	async function loadParamSchema(): Promise<void> {
		paramRowsError = false;
		paramRowsPending = true;
		// Snapshot canvasId + bump-and-capture the generation token so a
		// stale completion can't write rows / errors onto a newer
		// in-flight request or a different canvas (Codex round 1 P2).
		const requestCanvasId = canvasId;
		const requestGen = ++paramRowsGen;
		const isStale = () => requestCanvasId !== canvasId || requestGen !== paramRowsGen;
		try {
			const res = await fetch(`/api/canvas/${canvasId}/params`);
			if (isStale()) return;
			if (!res.ok) {
				// Surface a retryable error in the docs section instead of
				// the previous silent fail. The bindings table still
				// renders below so the user can still inspect the params.
				paramRowsError = true;
				return;
			}
			const rows = (await res.json()) as ParamRow[];
			if (isStale()) return;
			paramRows = rows;
			paramRowsLoaded = true;
		} catch {
			// Stale-guarded so a rejected request from a previous
			// canvas / session can't paint a false error banner over
			// freshly-loaded rows.
			if (!isStale()) {
				paramRowsError = true;
			}
		} finally {
			// Only the LATEST request may clear the pending flag — a
			// stale completion that lost the race must remain a no-op
			// so the still-in-flight newer request keeps the effect's
			// !paramRowsPending gate armed.
			if (requestGen === paramRowsGen) {
				paramRowsPending = false;
			}
		}
	}

	function retryLoadParamSchema(): void {
		paramRowsError = false;
		void loadParamSchema();
	}

	// --- Slug rename (TASK-98) extracted to <SlugEditor> in TASK-235.
	//     The entire state machine + ETag / If-Match handling now lives
	//     in that component; PublishModal just forwards `slug`,
	//     `canvasId`, `open`, and the `onSlugChange` callback.

	async function persistParamFlags(name: string, patch: Partial<ParamRow>): Promise<void> {
		// Optimistic in-memory update first so the UI feels responsive,
		// then PATCH the canvas with a single-row params array.
		paramRows = paramRows.map((r) => (r.name === name ? { ...r, ...patch } : r));
		try {
			await fetch(`/api/canvas/${canvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ params: [{ name, ...patch }] })
			});
		} catch {
			// User-facing copy: "params accepted" matches the vocabulary
			// vocab doc (TASK-103) — internal code/comments still use
			// "schema" since that's the API/DB term.
			toast.error(`Couldn't save the params-accepted setting for ${name}.`);
		}
	}

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

	/** Resolve the example value for a binding, preferring (in order):
	 *   1. The user's live test value from the editor params panel
	 *      (`liveValues[name]`), if non-empty.
	 *   2. The binding's declared default (`b.default`), if non-empty.
	 *   3. A representative `sampleFor()` placeholder based on the
	 *      source property.
	 *
	 * Empty strings at tier 1 and 2 fall through to the next tier — this
	 * matches the public renderer, which treats an empty value the same
	 * as omitting the param (binding default applies). Reading
	 * `liveValues[b.name]` inside this function is what wires the modal's
	 * derived snippet text to the parent's `$state`-backed
	 * `testParams` proxy: edits in the params panel re-trigger the
	 * deriveds without needing to close/reopen the modal. */
	function resolveExampleValue(b: PublishModalBinding): string {
		const live = liveValues[b.name];
		if (live) return live;
		if (b.default) return b.default;
		return sampleFor(b.sourceLabel);
	}

	/** Resolved name→value map driving every snippet. The modal owns
	 * this translation (bindings + liveValues → flat params) so the
	 * pure `$lib/embed/snippets` module can stay testable without
	 * caring about Svelte 5 prop shapes. */
	let resolvedParams = $derived.by(() => {
		const out: Record<string, string> = {};
		for (const b of bindings) {
			if (!b.name) continue;
			out[b.name] = resolveExampleValue(b);
		}
		return out;
	});

	let exampleQuery = $derived(buildQueryString(resolvedParams));
	let exampleImageUrl = $derived(`${imageUrl}${exampleQuery}`);
	let exampleShareUrl = $derived(`${shareUrl}${exampleQuery}`);

	/** Input bundle passed to every snippet generator in
	 * `$lib/embed/snippets`. Re-deriving this keeps the per-snippet
	 * deriveds below trivial. */
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

		<section class="docs-section">
			<h3 class="docs-title">Using this template</h3>

			<ParamSchemaEditor
				{bindings}
				{paramRows}
				{paramRowsLoaded}
				{paramRowsError}
				{bindingsStale}
				onPersist={persistParamFlags}
				onRetry={retryLoadParamSchema}
			/>

			{#if bindings.length > 0}
				<CopyUrlRow
					id="publish-example-image"
					label="Example image URL"
					url={exampleImageUrl}
					copyLabel="Example URL"
				/>

				<CopyUrlRow
					id="publish-curl"
					label="Copy as cURL"
					url={curlFor(exampleImageUrl)}
					copyLabel="cURL command"
				>
					{#snippet helpHtml()}
						Downloads the rendered PNG to <code>canvas.png</code>. No auth required — public
						endpoint.
					{/snippet}
				</CopyUrlRow>

				<CopyUrlRow
					id="publish-example-share"
					label="Example share URL"
					url={exampleShareUrl}
					copyLabel="Example share URL"
				/>
			{/if}
		</section>

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
	 * + .docs-title wrappers stay here because the modal still owns
	 * the "Using this template" section heading and the example-URL
	 * <CopyUrlRow>s alongside the editor.
	 */
	.docs-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.docs-title {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text);
	}
</style>
