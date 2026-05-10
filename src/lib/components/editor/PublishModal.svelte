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
		bindingsStale = false,
		onClose,
		onPublishedChange,
		onBeforePublish
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

	// --- Sharing & redirect (TASK-95) ---
	// OG title / description / redirect URL are first-class shareable
	// metadata — the schema and PATCH endpoint already accept them, but
	// before TASK-95 there was no UI to edit them. Loaded lazily when
	// the modal opens for a published canvas. Edits persist on blur via
	// the existing PATCH so we keep the auto-save discipline of the
	// param-flags rows.
	interface SharingState {
		ogTitle: string;
		ogDescription: string;
		redirectUrl: string;
	}
	let sharing = $state<SharingState>({ ogTitle: '', ogDescription: '', redirectUrl: '' });
	let sharingLoaded = $state(false);
	// In-flight guard so the same $effect re-running (e.g. when
	// paramRowsLoaded or versionToken later changes) doesn't kick off
	// a second concurrent GET that could land after the user has
	// started typing and overwrite their input. Codex round 2 P2.
	let sharingPending = $state(false);
	// Monotonic counter incremented every time the modal opens for a
	// fresh canvas. Stale loadSharing() completions (modal closed, or
	// reopened on a different canvas) are dropped by comparing against
	// the generation captured at request start. Codex round 3 P2.
	let sharingGen = 0;

	$effect(() => {
		if (open && published && !paramRowsLoaded) {
			void loadParamSchema();
		}
		if (open && published && versionToken === null) {
			void loadVersionToken();
		}
		if (open && published && !sharingLoaded && !sharingPending) {
			void loadSharing();
		}
		if (!open) {
			// Reset so reopening for a different canvas refetches. Bump
			// the generation so any in-flight `loadSharing` from this
			// session is treated as stale on completion.
			paramRowsLoaded = false;
			paramRows = [];
			versionToken = null;
			sharingLoaded = false;
			sharingPending = false;
			sharingGen++;
			sharing = { ogTitle: '', ogDescription: '', redirectUrl: '' };
		}
	});

	// Reset sharing state if the parent passes a different canvasId
	// while the modal stays open (rare but possible — e.g. dashboard
	// list with a single shared modal instance). Same generation bump
	// so any in-flight load drops.
	$effect(() => {
		// Read canvasId so the effect tracks it; the body intentionally
		// runs whenever it changes.
		void canvasId;
		sharingLoaded = false;
		sharingPending = false;
		sharingGen++;
		sharing = { ogTitle: '', ogDescription: '', redirectUrl: '' };
	});

	/** `_v` token from /api/canvas/[id]/version — when present, embed
	 *  snippets emit immutable-cache URLs. Loads asynchronously; before it
	 *  arrives the snippets fall back to bare URLs (still correct, just
	 *  short-cache). */
	let versionToken = $state<string | null>(null);
	async function loadVersionToken(): Promise<void> {
		try {
			const res = await fetch(`/api/canvas/${canvasId}/version`);
			if (!res.ok) return;
			const data = (await res.json()) as { token: string };
			versionToken = data.token;
		} catch {
			// Best-effort — falling back to short-cache URLs is fine.
		}
	}

	/** Tab state for the embed-snippet section. */
	type EmbedTab = 'html' | 'markdown' | 'og' | 'url' | 'curl';
	let activeTab = $state<EmbedTab>('html');
	/** Whether to include example query parameter values in the snippets. */
	let includeParams = $state(false);

	async function loadParamSchema(): Promise<void> {
		try {
			const res = await fetch(`/api/canvas/${canvasId}/params`);
			if (!res.ok) return;
			const rows = (await res.json()) as ParamRow[];
			paramRows = rows;
			paramRowsLoaded = true;
		} catch {
			// Silent — schema row is best-effort metadata, not critical to
			// the publish flow itself. The user can retry by reopening.
		}
	}

	async function loadSharing(): Promise<void> {
		// Snapshot the canvasId + generation at request start; if either
		// has changed by the time the response lands, the modal has
		// closed or moved to a different canvas — drop the result so we
		// don't commit stale metadata that the user could then save back
		// on blur. Codex round 3 P2.
		const requestCanvasId = canvasId;
		const requestGen = sharingGen;
		sharingPending = true;
		try {
			const res = await fetch(`/api/canvas/${canvasId}`);
			if (requestCanvasId !== canvasId || requestGen !== sharingGen) return;
			if (res.ok) {
				const data = (await res.json()) as {
					ogTitle: string | null;
					ogDescription: string | null;
					redirectUrl: string | null;
				};
				if (requestCanvasId !== canvasId || requestGen !== sharingGen) return;
				sharing = {
					ogTitle: data.ogTitle ?? '',
					ogDescription: data.ogDescription ?? '',
					redirectUrl: data.redirectUrl ?? ''
				};
			}
			// Even on a non-OK / network error, flip the loaded flag so
			// the inputs unlock and the user can edit manually. Codex
			// round 2 P3 — without this, a transient 5xx during open
			// would leave the fields permanently disabled.
		} catch {
			// Swallow network rejections. The `finally` block flips the
			// loaded flag so the user can still type into the inputs.
			// Codex round 3: without an explicit catch, the `void
			// loadSharing()` call site would surface an unhandled
			// promise rejection on transient network failure.
		} finally {
			// Only flip the flags if this request is still the live one;
			// otherwise we'd resurrect a stale "loaded" state for an old
			// canvas mid-typing.
			if (requestCanvasId === canvasId && requestGen === sharingGen) {
				sharingLoaded = true;
				sharingPending = false;
			}
		}
	}

	/**
	 * Persist a single sharing field on blur. Trims the value, sends the
	 * trimmed version (so trailing whitespace doesn't slip into a public
	 * og:title), and treats an empty string as "clear this field" — the
	 * server PATCH stores empty/null which makes the share-page fall
	 * back to the canvas name / a generic description / no redirect.
	 *
	 * Optimistic in-memory update first so the field doesn't snap back
	 * if the request is in flight when the user clicks elsewhere.
	 */
	/** Single-match regex used for "does this URL contain any
	 *  placeholder?" checks. Non-global so .test() doesn't mutate
	 *  `lastIndex` between reactive reruns (a footgun on the global
	 *  variant). The actual extraction uses a *fresh* global regex
	 *  per call so `matchAll` works against an unmodified instance. */
	const PARAM_PLACEHOLDER_PROBE = /\{\{[\w-]+\}\}/;

	/** Extract every `{{name}}` reference from `template` once,
	 *  preserving first-seen order and de-duping. Returns an empty
	 *  array when no placeholders are present. */
	function extractPlaceholders(template: string): string[] {
		const re = /\{\{([\w-]+)\}\}/g;
		const seen: string[] = [];
		for (const match of template.matchAll(re)) {
			const key = match[1];
			if (!seen.includes(key)) seen.push(key);
		}
		return seen;
	}

	/** `{{name}}` references in the current redirectUrl that don't
	 *  match any of this canvas's bound parameters. Used to surface
	 *  a red warning beside the field. Recomputes whenever the
	 *  redirect URL or the bindings change. */
	let redirectUnknownParams = $derived.by(() => {
		const url = sharing.redirectUrl;
		if (!url) return [] as string[];
		const validNames = bindings.map((b) => b.name);
		return extractPlaceholders(url).filter((k) => !validNames.includes(k));
	});

	/** `{{name}}` references that ARE matched by a binding — used to
	 *  render a "looks good" affirmation when the user types a valid
	 *  reference. */
	let redirectKnownParams = $derived.by(() => {
		const url = sharing.redirectUrl;
		if (!url) return [] as string[];
		const validNames = bindings.map((b) => b.name);
		return extractPlaceholders(url).filter((k) => validNames.includes(k));
	});

	/** Live-preview the redirect URL substituted with each binding's
	 *  default (or sample) value. Helps the user see "what URL will
	 *  the human actually land on" without having to publish + click
	 *  through. Returns null when no redirect URL or no `{{...}}`
	 *  placeholders are present (preview adds nothing in that case). */
	let redirectPreview = $derived.by(() => {
		const url = sharing.redirectUrl;
		if (!url) return null;
		if (!PARAM_PLACEHOLDER_PROBE.test(url)) return null;
		const sampleParams: Record<string, string> = {};
		for (const b of bindings) {
			sampleParams[b.name] = b.default || sampleFor(b.sourceLabel);
		}
		// Fresh global regex so .replace() iterates the whole string;
		// any unknown placeholder is preserved verbatim so the preview
		// makes the omission visible (matches the server's behavior of
		// substituting "" only when the URL request supplies the param,
		// not when the placeholder itself is unknown).
		return url.replace(/\{\{([\w-]+)\}\}/g, (_, key) =>
			Object.hasOwn(sampleParams, key) ? sampleParams[key] : `{{${key}}}`
		);
	});

	async function persistSharingField<K extends keyof SharingState>(
		key: K,
		value: SharingState[K]
	): Promise<void> {
		const trimmed = value.trim();
		sharing = { ...sharing, [key]: trimmed };
		try {
			await fetch(`/api/canvas/${canvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ [key]: trimmed })
			});
		} catch {
			toast.error(`Couldn't save ${key}.`);
		}
	}

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
			toast.error(`Couldn't save schema flag for ${name}.`);
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

	/**
	 * Compose the image URL for embed snippets. Includes the `_v` token
	 * when loaded (immutable cache) and the example query string when the
	 * "With params" toggle is on.
	 */
	let snippetImageUrl = $derived.by(() => {
		const query = includeParams ? buildQueryString() : '';
		const versionPart = versionToken ? `${query ? '&' : '?'}_v=${versionToken}` : '';
		return `${imageUrl}${query}${versionPart}`;
	});

	/** HTML <img> snippet — width/height attrs help avoid layout shift on
	 *  the consuming page. */
	let htmlSnippet = $derived(
		`<img src="${snippetImageUrl}" alt="Canvas: ${slug}" width="1200" height="630" />`
	);

	/** Markdown image snippet. Markdown doesn't support width/height, so
	 *  we don't try. */
	let markdownSnippet = $derived(`![Canvas: ${slug}](${snippetImageUrl})`);

	/** OG meta tags (TASK-97). og:image:width and og:image:height help
	 *  OG previews size correctly without each crawler having to pre-
	 *  fetch and inspect the binary. og:image:type lets crawlers skip
	 *  the binary-sniff step (LinkedIn / older Slack are picky about
	 *  this). og:image:secure_url is emitted only when the URL is
	 *  https — localhost dev pages serve over http. og:url uses the
	 *  bare share URL (no `_v` so a copy/paste of the share URL stays
	 *  user-friendly). */
	let ogSnippet = $derived.by(() => {
		const lines = [
			`<meta property="og:image" content="${snippetImageUrl}" />`,
			`<meta property="og:image:width" content="1200" />`,
			`<meta property="og:image:height" content="630" />`,
			`<meta property="og:image:type" content="image/png" />`
		];
		if (snippetImageUrl.startsWith('https://')) {
			lines.push(`<meta property="og:image:secure_url" content="${snippetImageUrl}" />`);
		}
		lines.push(`<meta property="og:url" content="${shareUrl}" />`);
		return lines.join('\n');
	});

	/** Plain URL — the snippet is the URL itself. Useful for pasting into
	 *  Notion / Slack / email where the rich-link unfurler renders the
	 *  image inline. */
	let urlSnippet = $derived(snippetImageUrl);

	/** cURL snippet — ready to drop into a terminal, downloads the PNG. */
	let curlSnippet = $derived(curlFor(snippetImageUrl));

	let activeSnippet = $derived(
		activeTab === 'html'
			? htmlSnippet
			: activeTab === 'markdown'
				? markdownSnippet
				: activeTab === 'og'
					? ogSnippet
					: activeTab === 'curl'
						? curlSnippet
						: urlSnippet
	);

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

		<section class="sharing-section" data-testid="sharing-section">
			<h3 class="sharing-title">Sharing &amp; redirect</h3>
			<p class="sharing-hint">
				Customize what social-media unfurls show, and where humans land after clicking the share
				URL. Leave blank to use the canvas name / no redirect.
			</p>

			<!--
				Inputs stay disabled until `loadSharing()` resolves.
				Codex round 1 P2: without the gate, a user typing into a
				blank field before the GET completes would have their
				input overwritten when the response arrived, then their
				blur would save the (stale) server value.
			-->
			<div class="field">
				<label for="publish-og-title">OG title</label>
				<input
					id="publish-og-title"
					type="text"
					data-testid="og-title-input"
					placeholder={sharingLoaded ? 'Defaults to canvas name' : 'Loading…'}
					disabled={!sharingLoaded}
					value={sharing.ogTitle}
					oninput={(e) => (sharing = { ...sharing, ogTitle: e.currentTarget.value })}
					onblur={(e) => persistSharingField('ogTitle', e.currentTarget.value)}
				/>
				<p class="help">
					Shown as the title in Twitter / Facebook / LinkedIn cards. Supports
					<code>{'{{param}}'}</code> substitution.
				</p>
			</div>

			<div class="field">
				<label for="publish-og-description">OG description</label>
				<textarea
					id="publish-og-description"
					data-testid="og-description-input"
					rows="2"
					placeholder={sharingLoaded
						? 'One- or two-sentence summary that appears under the title'
						: 'Loading…'}
					disabled={!sharingLoaded}
					value={sharing.ogDescription}
					oninput={(e) => (sharing = { ...sharing, ogDescription: e.currentTarget.value })}
					onblur={(e) => persistSharingField('ogDescription', e.currentTarget.value)}
				></textarea>
			</div>

			<div class="field">
				<label for="publish-redirect-url">Redirect URL</label>
				<input
					id="publish-redirect-url"
					type="text"
					data-testid="redirect-url-input"
					placeholder={sharingLoaded
						? `https://your-site.example.com/landing?utm_source={{utm}}`
						: 'Loading…'}
					disabled={!sharingLoaded}
					value={sharing.redirectUrl}
					oninput={(e) => (sharing = { ...sharing, redirectUrl: e.currentTarget.value })}
					onblur={(e) => persistSharingField('redirectUrl', e.currentTarget.value)}
				/>
				<p class="help">
					Humans get a 302 to this URL. Bots see the OG card. Use
					<code>{'{{paramName}}'}</code> to substitute query parameters into the redirect.
				</p>

				<!--
					Live syntax feedback (TASK-96). Shown only while a redirect
					URL is set and bindings are known so we don't pester the
					user with warnings on a blank field or before publish.
					Both branches render below the help text so the layout
					doesn't shift when typing.
				-->
				{#if sharing.redirectUrl}
					{#if redirectUnknownParams.length > 0}
						<p class="redirect-warning" data-testid="redirect-unknown-params" role="alert">
							⚠️ {redirectUnknownParams.length === 1 ? 'Unknown parameter:' : 'Unknown parameters:'}
							{#each redirectUnknownParams as name, i (name)}<code>{`{{${name}}}`}</code>{i <
								redirectUnknownParams.length - 1
									? ', '
									: ''}{/each}.
							{bindings.length === 0
								? 'This canvas has no bound parameters yet.'
								: `Available: ${bindings.map((b) => b.name).join(', ')}.`}
						</p>
					{:else if redirectKnownParams.length > 0}
						<p class="redirect-ok" data-testid="redirect-params-ok">✓ All references are valid.</p>
					{/if}

					{#if redirectPreview}
						<p class="redirect-preview" data-testid="redirect-preview">
							<span class="redirect-preview-label">Preview</span>
							<code>{redirectPreview}</code>
						</p>
					{/if}
				{/if}
			</div>
		</section>

		<section class="embed-section" data-testid="embed-section">
			<header class="embed-header">
				<h3 class="embed-title">Embed</h3>
				{#if bindings.length > 0}
					<label class="embed-toggle">
						<input type="checkbox" bind:checked={includeParams} />
						<span>Include example params</span>
					</label>
				{/if}
			</header>

			<div class="embed-tabs" role="tablist" aria-label="Embed format">
				{#each [{ id: 'html', label: 'HTML' }, { id: 'markdown', label: 'Markdown' }, { id: 'og', label: 'OG meta' }, { id: 'url', label: 'URL' }, { id: 'curl', label: 'cURL' }] as tab (tab.id)}
					<button
						type="button"
						role="tab"
						class="embed-tab"
						class:active={activeTab === tab.id}
						aria-selected={activeTab === tab.id}
						data-testid="embed-tab-{tab.id}"
						onclick={() => (activeTab = tab.id as EmbedTab)}
					>
						{tab.label}
					</button>
				{/each}
			</div>

			<div class="embed-snippet">
				<textarea
					readonly
					value={activeSnippet}
					rows={activeTab === 'og' ? 3 : 2}
					data-testid="embed-snippet"
					aria-label="Embed snippet"
				></textarea>
				<div class="embed-actions">
					<button
						type="button"
						class="btn btn-copy"
						data-testid="embed-copy"
						onclick={() => copy(activeSnippet, 'Snippet')}
					>
						Copy
					</button>
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

		<section class="validator-section" data-testid="validator-section">
			<h3 class="validator-title">Test on social</h3>
			<p class="validator-hint">
				Open the share URL in each platform's preview tool to refresh the cache and confirm the card
				renders. Each link opens in a new tab with the URL pre-filled.
			</p>
			<div class="validator-row">
				<a
					class="btn btn-secondary"
					data-testid="validator-twitter"
					href="https://cards-dev.twitter.com/validator?url={encodeURIComponent(shareUrl)}"
					target="_blank"
					rel="noopener noreferrer"
					title="Force Twitter / X to re-fetch the OG card and show validation issues"
				>
					Twitter Card Validator
				</a>
				<a
					class="btn btn-secondary"
					data-testid="validator-facebook"
					href="https://developers.facebook.com/tools/debug/?q={encodeURIComponent(shareUrl)}"
					target="_blank"
					rel="noopener noreferrer"
					title="Facebook / Meta sharing debugger — also flushes WhatsApp / Instagram caches"
				>
					Facebook Debugger
				</a>
				<a
					class="btn btn-secondary"
					data-testid="validator-linkedin"
					href="https://www.linkedin.com/post-inspector/inspect/{encodeURIComponent(shareUrl)}"
					target="_blank"
					rel="noopener noreferrer"
					title="LinkedIn Post Inspector — re-fetches and shows the rendered card"
				>
					LinkedIn Post Inspector
				</a>
			</div>
		</section>

		<section class="docs-section">
			<h3 class="docs-title">Using this template</h3>

			{#if bindingsStale}
				<p class="docs-warning">
					⚠️ This canvas has unsaved edits. The parameters below may not yet be live on the public
					URL. Save the canvas, then reopen this dialog for the authoritative docs.
				</p>
			{/if}

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
						<span>Default</span>
						<span>Type</span>
						<span>Required</span>
					</div>
					{#each bindings as b (b.name)}
						{@const row = paramRows.find((r) => r.name === b.name)}
						<div class="docs-row">
							<code class="docs-param-name" title={b.sourceLabel}>{b.name}</code>
							<code class="docs-param-default">{b.default || '—'}</code>
							<select
								class="docs-type-select"
								value={row?.type ?? 'text'}
								disabled={!row}
								aria-label="Type for {b.name}"
								onchange={(e) => persistParamFlags(b.name, { type: e.currentTarget.value })}
							>
								<option value="text">text</option>
								<option value="number">number</option>
								<option value="url">url</option>
								<option value="boolean">boolean</option>
								<option value="date">date</option>
							</select>
							<label class="docs-required-cell">
								<input
									type="checkbox"
									checked={row?.required ?? false}
									disabled={!row}
									aria-label="Required {b.name}"
									onchange={(e) => persistParamFlags(b.name, { required: e.currentTarget.checked })}
								/>
								<span>required</span>
							</label>
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

	.btn-link {
		background: none;
		color: #2563eb;
		text-decoration: none;
		padding: 0.5rem 0.75rem;
		font-size: 0.85rem;
	}

	.btn-link:hover {
		text-decoration: underline;
	}

	.sharing-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid #eee;
	}

	.sharing-title {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: #111;
	}

	.sharing-hint {
		margin: 0 0 0.85rem;
		font-size: 0.8125rem;
		color: #4b5563;
		line-height: 1.5;
	}

	.sharing-section .field input[type='text'],
	.sharing-section .field textarea {
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 1px solid #d1d5db;
		border-radius: 5px;
		font-family: inherit;
		font-size: 0.85rem;
		background: #fff;
		color: #111;
	}

	.sharing-section .field textarea {
		resize: vertical;
		min-height: 2.5rem;
		font-family: inherit;
	}

	.redirect-warning {
		margin: 0.4rem 0 0;
		padding: 0.4rem 0.55rem;
		background: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 4px;
		font-size: 0.75rem;
		color: #991b1b;
		line-height: 1.45;
	}

	.redirect-warning code {
		font-size: 0.72rem;
		background: #fee2e2;
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		color: #7f1d1d;
	}

	.redirect-ok {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: #047857;
	}

	.redirect-preview {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: #475569;
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.redirect-preview code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.72rem;
		background: #f1f5f9;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		color: #0f172a;
		word-break: break-all;
	}

	.redirect-preview-label {
		font-weight: 600;
		color: #334155;
	}

	.embed-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid #eee;
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
		color: #111;
	}

	.embed-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.8rem;
		color: #475569;
	}

	.embed-tabs {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
		border-bottom: 1px solid #e5e7eb;
	}

	.embed-tab {
		padding: 0.4rem 0.75rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: #64748b;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.embed-tab:hover {
		color: #0f172a;
	}

	.embed-tab.active {
		color: #0f172a;
		border-bottom-color: #0f172a;
		font-weight: 600;
	}

	.embed-snippet textarea {
		width: 100%;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background: #f8fafc;
		color: #0f172a;
		resize: vertical;
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
		color: #94a3b8;
	}

	.embed-help code {
		background: #f1f5f9;
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.75rem;
	}

	.validator-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid #eee;
	}

	.validator-title {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: #111;
	}

	.validator-hint {
		margin: 0 0 0.6rem;
		font-size: 0.8125rem;
		color: #4b5563;
		line-height: 1.5;
	}

	.validator-row {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.validator-row .btn {
		text-decoration: none;
		display: inline-flex;
		align-items: center;
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

	.docs-warning {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 5px;
		font-size: 0.75rem;
		color: #92400e;
		line-height: 1.45;
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
		grid-template-columns: 1fr 1fr 0.9fr 0.8fr;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid #f1f5f9;
		align-items: center;
	}

	.docs-type-select {
		font-size: 0.75rem;
		padding: 0.15rem 0.3rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		background: #fff;
	}

	.docs-required-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		color: #4b5563;
	}

	.docs-required-cell input[type='checkbox'] {
		margin: 0;
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
</style>
