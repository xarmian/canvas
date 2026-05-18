<script lang="ts">
	import { Textarea, Button } from '$lib/components/ui';
	import { copyToClipboard } from '$lib/share-clipboard';
	import {
		buildQueryString,
		curlSnippet as buildCurlSnippet,
		htmlSnippet as buildHtmlSnippet,
		markdownSnippet as buildMarkdownSnippet,
		ogSnippet as buildOgSnippet,
		python as buildPythonSnippet,
		tsSimple as buildTsSimpleSnippet,
		tsTyped as buildTsTypedSnippet,
		urlSnippet as buildUrlSnippet,
		type ParamSchema,
		type SnippetInput
	} from '$lib/embed/snippets';
	import type { PublishModalBinding } from '../PublishModal.svelte';

	/**
	 * Embed-snippet generator. Owns the 7-tab tablist (HTML / Markdown /
	 * OG / URL / cURL / TypeScript / Python), the TS flavor sub-toggle,
	 * the textarea, the Copy / Open-in-new-tab actions, and the
	 * version-token help text.
	 *
	 * Pure display given its props — no fetches. The parent computes
	 * `paramSchemas` from its own `paramRows` state (per the TASK-236
	 * coupling note) so the schema derivation isn't duplicated; the
	 * `versionToken` is also fetched in the parent (for now — Phase B
	 * moves both to editor-page state along with the drawer surface).
	 *
	 * The shareUrl / imageUrl are derived from `slug` + the current
	 * window origin so the snippets match the user's deployment without
	 * the parent having to pass two more URL props through.
	 *
	 * Extracted from PublishModal in TASK-235 under PLAN-232 Phase D.
	 */
	interface Props {
		slug: string;
		bindings?: PublishModalBinding[];
		liveValues?: Record<string, string>;
		paramSchemas: ParamSchema[];
		versionToken: string | null;
	}

	let { slug, bindings = [], liveValues = {}, paramSchemas, versionToken }: Props = $props();

	/** Tab state for the embed-snippet section. TS/Python tabs added in
	 * TASK-211 (PLAN-206). Order in this union doubles as the visual
	 * order in the tab strip below, so any reorder here should update
	 * EMBED_TABS too. */
	type EmbedTab = 'html' | 'markdown' | 'og' | 'url' | 'curl' | 'typescript' | 'python';
	let activeTab = $state<EmbedTab>('html');
	/** Sub-flavor inside the TypeScript tab — `simple` shows an
	 * untyped `Record<string, string>` snippet, `typed` generates
	 * `type Params = {...}` from the canvas schema. State persists
	 * across activeTab switches within a single mount. */
	type TsFlavor = 'simple' | 'typed';
	let tsFlavor = $state<TsFlavor>('simple');
	/** Whether to include example query parameter values in the snippets. */
	let includeParams = $state(false);

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
	 * `liveValues[b.name]` inside this function is what wires the
	 * derived snippet text to the editor's `$state`-backed `testParams`
	 * proxy: edits in the params panel re-trigger the deriveds without
	 * needing to close/reopen the modal. */
	function resolveExampleValue(b: PublishModalBinding): string {
		const live = liveValues[b.name];
		if (live) return live;
		if (b.default) return b.default;
		return sampleFor(b.sourceLabel);
	}

	/** Resolved name→value map driving every snippet. */
	let resolvedParams = $derived.by(() => {
		const out: Record<string, string> = {};
		for (const b of bindings) {
			if (!b.name) continue;
			out[b.name] = resolveExampleValue(b);
		}
		return out;
	});

	let exampleQuery = $derived(buildQueryString(resolvedParams));

	/** Input bundle passed to every snippet generator in
	 * `$lib/embed/snippets`. Re-deriving this keeps the per-snippet
	 * deriveds below trivial. */
	let snippetInput = $derived<SnippetInput>({
		imageUrl,
		shareUrl,
		slug,
		query: exampleQuery,
		// Unencoded params drive the TS/Python `params = { ... }`
		// literals (TASK-209 / TASK-210). Existing HTML / Markdown /
		// OG / URL / cURL generators ignore this field.
		params: resolvedParams,
		// Per-param type info drives `tsTyped`'s `type Params = {...}`
		// declaration and Python's per-key coercion. Empty array when
		// the schema hasn't loaded yet (modal opens before the params
		// fetch resolves); both generators degrade gracefully to
		// all-strings in that case.
		paramSchemas,
		versionToken,
		includeParams
	});

	let htmlSnippet = $derived(buildHtmlSnippet(snippetInput));
	let markdownSnippet = $derived(buildMarkdownSnippet(snippetInput));
	let ogSnippet = $derived(buildOgSnippet(snippetInput));
	let urlSnippet = $derived(buildUrlSnippet(snippetInput));
	let curlSnippet = $derived(buildCurlSnippet(snippetInput));
	let tsSimpleSnippet = $derived(buildTsSimpleSnippet(snippetInput));
	let tsTypedSnippet = $derived(buildTsTypedSnippet(snippetInput));
	let pythonSnippet = $derived(buildPythonSnippet(snippetInput));
	/** TypeScript tab content depends on the sub-flavor toggle.
	 * Switching `tsFlavor` flips the snippet without remounting the
	 * textarea, so the user's selection survives across re-renders. */
	let typescriptSnippet = $derived(tsFlavor === 'typed' ? tsTypedSnippet : tsSimpleSnippet);
	/** Convenience alias for the "Open in new tab" link — same composed
	 * URL the URL/cURL/HTML snippets use. */
	let snippetImageUrl = $derived(urlSnippet);

	let activeSnippet = $derived(
		activeTab === 'html'
			? htmlSnippet
			: activeTab === 'markdown'
				? markdownSnippet
				: activeTab === 'og'
					? ogSnippet
					: activeTab === 'curl'
						? curlSnippet
						: activeTab === 'typescript'
							? typescriptSnippet
							: activeTab === 'python'
								? pythonSnippet
								: urlSnippet
	);

	/** Per-tab row-count for the snippet textarea. TS/Python are
	 * multi-line scripts; the existing single-line snippets fit in 2
	 * rows; OG meta is ~5 short lines. */
	let snippetRows = $derived(
		activeTab === 'typescript' ? 14 : activeTab === 'python' ? 12 : activeTab === 'og' ? 5 : 2
	);

	/** Canonical embed-tab list. Drives both the visual tab strip and
	 * the keyboard-nav cycle (ArrowLeft / ArrowRight wrap; Home / End
	 * jump to ends). Order matters — it's the visual order and the
	 * tab-cycle order. */
	const EMBED_TABS: { id: EmbedTab; label: string }[] = [
		{ id: 'html', label: 'HTML' },
		{ id: 'markdown', label: 'Markdown' },
		{ id: 'og', label: 'OG meta' },
		{ id: 'url', label: 'URL' },
		{ id: 'curl', label: 'cURL' },
		{ id: 'typescript', label: 'TypeScript' },
		{ id: 'python', label: 'Python' }
	];

	/** ARIA tablist keyboard nav. Standard WAI-ARIA pattern:
	 * Arrow keys cycle (with wrap), Home/End jump to ends. Activate-
	 * on-focus rather than activate-on-Enter so the snippet preview
	 * updates as the user arrows through — matches
	 * `aria-orientation="horizontal"` semantics. Focus shifts to the
	 * activated button so subsequent Tab navigation continues from
	 * the right place. */
	function onTabKeydown(event: KeyboardEvent, currentId: EmbedTab) {
		const idx = EMBED_TABS.findIndex((t) => t.id === currentId);
		if (idx === -1) return;
		let nextIdx: number | null = null;
		if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + EMBED_TABS.length) % EMBED_TABS.length;
		else if (event.key === 'ArrowRight') nextIdx = (idx + 1) % EMBED_TABS.length;
		else if (event.key === 'Home') nextIdx = 0;
		else if (event.key === 'End') nextIdx = EMBED_TABS.length - 1;
		if (nextIdx === null) return;
		event.preventDefault();
		const nextTab = EMBED_TABS[nextIdx];
		activeTab = nextTab.id;
		queueMicrotask(() => {
			const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
			const tablist = root?.closest('[role="tablist"]');
			const btn = tablist?.querySelector<HTMLButtonElement>(
				`[data-testid="embed-tab-${nextTab.id}"]`
			);
			btn?.focus();
		});
	}

	async function copy(value: string, label: string) {
		await copyToClipboard(value, { success: `${label} copied to clipboard` });
	}
</script>

<section class="embed-section" data-testid="embed-section">
	<header class="embed-header">
		<h3 class="embed-title">Embed</h3>
		{#if bindings.length > 0}
			<label class="embed-toggle">
				<input type="checkbox" bind:checked={includeParams} />
				<span>Include example values</span>
			</label>
		{/if}
	</header>

	<div class="embed-tabs" role="tablist" aria-label="Embed format" aria-orientation="horizontal">
		{#each EMBED_TABS as tab (tab.id)}
			<button
				type="button"
				role="tab"
				class="embed-tab"
				class:active={activeTab === tab.id}
				aria-selected={activeTab === tab.id}
				aria-controls="embed-snippet-panel"
				tabindex={activeTab === tab.id ? 0 : -1}
				data-testid="embed-tab-{tab.id}"
				onclick={() => (activeTab = tab.id)}
				onkeydown={(e) => onTabKeydown(e, tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</div>

	{#if activeTab === 'typescript'}
		<!--
			Sub-toggle inside the TypeScript tab — chooses between the
			untyped Record<string,string> flavor and the schema-driven
			`type Params = {...}` flavor. Rendered as a two-button
			segmented control (TASK-211); a checkbox would conflate
			"both vs neither" with "either-or" semantics.
		-->
		<div
			class="ts-flavor"
			role="group"
			aria-label="TypeScript snippet flavor"
			data-testid="ts-flavor"
		>
			<button
				type="button"
				class="ts-flavor-btn"
				class:active={tsFlavor === 'simple'}
				aria-pressed={tsFlavor === 'simple'}
				data-testid="ts-flavor-simple"
				onclick={() => (tsFlavor = 'simple')}
			>
				Simple
			</button>
			<button
				type="button"
				class="ts-flavor-btn"
				class:active={tsFlavor === 'typed'}
				aria-pressed={tsFlavor === 'typed'}
				data-testid="ts-flavor-typed"
				onclick={() => (tsFlavor = 'typed')}
			>
				Typed
			</button>
		</div>
	{/if}

	<div class="embed-snippet" id="embed-snippet-panel" role="tabpanel">
		<Textarea
			readonly
			value={activeSnippet}
			rows={snippetRows}
			data-testid="embed-snippet"
			aria-label="Embed snippet"
			class="snippet-textarea"
		/>
		<div class="embed-actions">
			<Button
				variant="copy"
				data-testid="embed-copy"
				onclick={() => copy(activeSnippet, 'Snippet')}
			>
				Copy
			</Button>
			<a href={snippetImageUrl} target="_blank" rel="noopener noreferrer" class="btn btn-link">
				Open in new tab
			</a>
		</div>
	</div>

	{#if !versionToken}
		<p class="embed-help">
			Snippets use the short-window cache. Once the
			<code>_v</code> token loads, future snippets opt into 1-year immutable caching.
		</p>
	{:else}
		<p class="embed-help">
			Snippets use the <code>_v</code> content-versioned URL — CDNs cache it for 1 year and any canvas
			edit produces a fresh token.
		</p>
	{/if}
</section>

<style>
	.embed-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.embed-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}

	.embed-title {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.embed-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}

	.embed-tabs {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
		border-bottom: 1px solid var(--color-border);
	}

	.embed-tab {
		padding: 0.4rem 0.75rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-text-subtle);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.embed-tab:hover {
		color: var(--color-text);
	}

	.embed-tab.active {
		color: var(--color-text);
		border-bottom-color: var(--color-text);
		font-weight: 600;
	}

	/*
	 * TASK-146: keyboard nav across the embed tablist had no visible
	 * focus state — the active-tab underline doesn't double as a
	 * focus indicator because it only shows on the active tab, not
	 * the focused-but-unselected one. Outline-offset: -2px so the
	 * ring sits inside the border-bottom track rather than blowing
	 * out the row layout.
	 */
	.embed-tab:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
	}

	/*
	 * TASK-211: TypeScript sub-flavor toggle. Two-button segmented
	 * control rendered below the main tab strip when the TS tab is
	 * active. Visual treatment matches the tab strip so the eye reads
	 * it as a secondary axis of selection (flavor) rather than a
	 * separate control surface.
	 */
	.ts-flavor {
		display: inline-flex;
		gap: 0;
		margin: 0.4rem 0 0.6rem;
		border: 1px solid var(--color-border);
		border-radius: 4px;
		overflow: hidden;
	}

	.ts-flavor-btn {
		background: transparent;
		border: 0;
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
		color: var(--color-text-subtle);
		cursor: pointer;
	}

	.ts-flavor-btn + .ts-flavor-btn {
		border-left: 1px solid var(--color-border);
	}

	.ts-flavor-btn.active {
		background: var(--color-surface-muted);
		color: var(--color-text);
		font-weight: 600;
	}

	.ts-flavor-btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
	}

	/*
	 * The embed snippet textarea uses the Textarea primitive with
	 * `class="snippet-textarea"`. Reach through scoped CSS via :global
	 * to apply the monospace + slightly muted treatment that signals
	 * "this is a code snippet" rather than a free-form text field.
	 */
	.embed-snippet :global(.snippet-textarea) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		background: var(--color-surface);
		color: var(--color-text);
	}

	.embed-actions {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.4rem;
		align-items: center;
	}

	.embed-help {
		margin: 0.6rem 0 0;
		font-size: 0.75rem;
		color: var(--color-text-subtle);
	}

	.embed-help code {
		background: var(--color-surface-muted);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.75rem;
	}

	/*
	 * `.btn.btn-link` for the "Open in new tab" anchor. The Button
	 * primitive renders <button>, not <a>; href-bearing variants would
	 * need a Button polymorphism change. Until then, the anchor keeps
	 * its inline styles. Tracked for follow-up after TASK-110.
	 */
	.btn {
		padding: 0.45rem 0.9rem;
		border-radius: 5px;
		font-size: 0.8125rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.btn-link {
		background: none;
		color: var(--color-primary);
		text-decoration: none;
		padding: 0.5rem 0.75rem;
		font-size: 0.85rem;
	}
</style>
