<script lang="ts">
	import { Input, Textarea, ErrorState, LoadingSkeleton } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { nearestParamName } from '../param-validation';
	import type { PublishModalBinding } from '../PublishModal.svelte';

	/**
	 * Sharing & redirect configuration: OG title, OG description, and
	 * redirect URL (with a live `{{param}}` syntax validator + preview
	 * substitution against each binding's default).
	 *
	 * GETs the canvas on open to seed the fields, blur-commits each
	 * field individually via PATCH. Stale-guard generations drop late
	 * completions across canvas swaps and close→reopen.
	 *
	 * Extracted from PublishModal in TASK-237 under PLAN-232 Phase D.
	 */
	interface Props {
		canvasId: string;
		open: boolean;
		published: boolean;
		bindings?: PublishModalBinding[];
	}

	let { canvasId, open, published, bindings = [] }: Props = $props();

	// --- Sharing & redirect (TASK-95) ---
	// OG title / description / redirect URL are first-class shareable
	// metadata — the schema and PATCH endpoint already accept them, but
	// before TASK-95 there was no UI to edit them. Loaded lazily when
	// the modal opens for a published canvas. Edits persist on blur via
	// the existing PATCH so blur-to-commit stays the rule for these
	// metadata fields, in line with the param-flags rows.
	interface SharingState {
		ogTitle: string;
		ogDescription: string;
		redirectUrl: string;
	}
	let sharing = $state<SharingState>({ ogTitle: '', ogDescription: '', redirectUrl: '' });
	let sharingLoaded = $state(false);
	/** Surfaces inline-with-retry when the GET fails (5xx, network),
	 *  rather than leaving the inputs silently locked. (TASK-136) */
	let sharingError = $state(false);
	// In-flight guard so the open-tracking $effect re-running (e.g.
	// when `published` flips) doesn't kick off a second concurrent GET
	// that could land after the user has started typing and overwrite
	// their input. Codex round 2 P2.
	let sharingPending = $state(false);
	// Monotonic counter incremented every time the modal opens for a
	// fresh canvas. Stale loadSharing() completions (modal closed, or
	// reopened on a different canvas) are dropped by comparing against
	// the generation captured at request start. Codex round 3 P2.
	let sharingGen = 0;

	$effect(() => {
		if (open && published && !sharingLoaded && !sharingPending) {
			void loadSharing();
		}
		if (!open) {
			sharingLoaded = false;
			sharingError = false;
			sharingPending = false;
			sharingGen++;
			sharing = { ogTitle: '', ogDescription: '', redirectUrl: '' };
		}
	});

	// Reset sharing state if the parent passes a different canvasId
	// while the modal stays open. Same generation bump so any in-flight
	// load drops.
	$effect(() => {
		void canvasId;
		sharingLoaded = false;
		sharingPending = false;
		sharingGen++;
		sharing = { ogTitle: '', ogDescription: '', redirectUrl: '' };
	});

	async function loadSharing(): Promise<void> {
		// Snapshot the canvasId + generation at request start; if either
		// has changed by the time the response lands, the modal has
		// closed or moved to a different canvas — drop the result so we
		// don't commit stale metadata that the user could then save back
		// on blur. Codex round 3 P2.
		const requestCanvasId = canvasId;
		const requestGen = sharingGen;
		sharingPending = true;
		sharingError = false;
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
			// On non-OK we still flip `sharingLoaded` (in finally) so
			// inputs unlock and the user can manually type — but we ALSO
			// surface an inline ErrorState with retry so the failure
			// isn't silently swallowed (TASK-136). The user can choose
			// to type fresh values OR retry.
			if (requestCanvasId === canvasId && requestGen === sharingGen && !res.ok) {
				sharingError = true;
			}
		} catch {
			// Network rejections take the same retryable path as a
			// non-OK response; the inputs still unlock so manual entry
			// is also possible.
			if (requestCanvasId === canvasId && requestGen === sharingGen) {
				sharingError = true;
			}
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

	function retryLoadSharing(): void {
		sharingError = false;
		// Clear `sharingLoaded` so the inputs lock again while the retry
		// is in flight, mirroring first-open behavior.
		sharingLoaded = false;
		void loadSharing();
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

	/** Representative sample value per source type — used when a
	 *  binding's default is an empty string, so the redirect-URL
	 *  preview substitutes something concrete instead of a blank.
	 *  (Duplicated from EmbedSnippets; will consolidate once both
	 *  surfaces consume from the same upstream shape.) */
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

	/** `{{name}}` references in the current redirectUrl that don't
	 *  match any of this canvas's bound parameters, paired with the
	 *  closest known name (TASK-106) when one exists within the
	 *  shared validator's typo threshold. */
	interface RedirectUnknownParam {
		name: string;
		suggestion: string | null;
	}
	let redirectUnknownParams = $derived.by<RedirectUnknownParam[]>(() => {
		const url = sharing.redirectUrl;
		if (!url) return [];
		const validNames = bindings.map((b) => b.name);
		const validSet = new Set(validNames);
		const unknown = extractPlaceholders(url).filter((k) => !validSet.has(k));
		return unknown.map((name) => ({
			name,
			suggestion: nearestParamName(name, validNames)?.name ?? null
		}));
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
	 *  default (or sample) value. Returns null when no redirect URL or
	 *  no `{{...}}` placeholders are present. */
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
</script>

<section class="sharing-section" data-testid="sharing-section">
	<h3 class="sharing-title">Sharing &amp; redirect</h3>
	<p class="sharing-hint">
		Customize what social-media unfurls show, and where humans land after clicking the share URL.
		Leave blank to use the canvas name / no redirect.
	</p>

	{#if sharingError}
		<!--
			GET /api/canvas/[id] failed (5xx, network). Surface the
			error inline with retry instead of leaving the inputs
			locked silently. Inputs unlock anyway via the finally
			block so the user can also choose to type values
			directly. (TASK-136)
		-->
		<div class="sharing-error" data-testid="sharing-error">
			<ErrorState
				title="Couldn't load sharing settings"
				message="The current OG title, description, and redirect URL didn't load. You can retry the fetch, or type values directly into the inputs below."
				onRetry={retryLoadSharing}
			/>
		</div>
	{:else if !sharingLoaded}
		<!--
			Loading skeleton stack while loadSharing is in flight.
			Three lines mirrors the eventual three input + label
			rows so the section's height stays roughly stable
			instead of jumping when the inputs render.
		-->
		<div
			class="sharing-skeleton"
			data-testid="sharing-skeleton"
			aria-label="Loading sharing settings"
		>
			<LoadingSkeleton lines={3} />
		</div>
	{/if}

	<!--
		Inputs stay disabled until `loadSharing()` resolves.
		Codex round 1 P2: without the gate, a user typing into a
		blank field before the GET completes would have their input
		overwritten when the response arrived, then their blur would
		save the (stale) server value.
	-->
	<div class="field">
		<label for="publish-og-title">OG title</label>
		<Input
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
		<Textarea
			id="publish-og-description"
			data-testid="og-description-input"
			rows={2}
			placeholder={sharingLoaded
				? 'One- or two-sentence summary that appears under the title'
				: 'Loading…'}
			disabled={!sharingLoaded}
			value={sharing.ogDescription}
			oninput={(e) => (sharing = { ...sharing, ogDescription: e.currentTarget.value })}
			onblur={(e) => persistSharingField('ogDescription', e.currentTarget.value)}
		/>
	</div>

	<div class="field">
		<label for="publish-redirect-url">Redirect URL</label>
		<Input
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
			Visitors see a "Continue to {'{host}'}" button pointing here. Bots see the OG card. Use
			<code>{'{{valueName}}'}</code> to substitute dynamic values into the destination.
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
					⚠️ {redirectUnknownParams.length === 1 ? 'Unknown value:' : 'Unknown values:'}
					{#each redirectUnknownParams as p, i (p.name)}<!--
						Render each unknown placeholder + its optional "did
						you mean X?" suggestion inline. Suggestions use the
						shared param-validation Levenshtein helper so the
						typo threshold matches the conditional-rule editor's
						(TASK-106).
					--><code
							>{`{{${p.name}}}`}</code
						>{#if p.suggestion}
							<span class="redirect-warning-suggest"
								>(did you mean <code>{p.suggestion}</code>?)</span
							>{/if}{i < redirectUnknownParams.length - 1 ? ', ' : ''}{/each}.
					{bindings.length === 0
						? 'This canvas has no dynamic values yet.'
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

<style>
	.sharing-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.sharing-title {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.sharing-hint {
		margin: 0 0 0.85rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.sharing-error {
		margin: 0 0 var(--spacing-3);
	}

	.sharing-skeleton {
		margin: 0 0 var(--spacing-3);
		display: flex;
		flex-direction: column;
		gap: var(--spacing-2);
	}

	/*
	 * Shared field chrome — matches PublishModal's `.field` /
	 * `.help` rules verbatim so the inputs render identically when
	 * mounted alongside the slug field and copy-url rows.
	 */
	.field {
		margin-bottom: 1rem;
	}

	.field label {
		display: block;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text);
		margin-bottom: 0.3rem;
	}

	.help {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: var(--color-text-subtle);
		line-height: 1.4;
	}

	.help :global(code) {
		background: var(--color-surface-muted);
		padding: 0 0.25rem;
		border-radius: 3px;
	}

	.redirect-warning {
		margin: 0.4rem 0 0;
		padding: 0.4rem 0.55rem;
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: 4px;
		font-size: 0.75rem;
		color: var(--color-danger-hover);
		line-height: 1.45;
	}

	.redirect-warning code {
		font-size: 0.72rem;
		background: var(--color-danger-border);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		color: var(--color-danger-hover);
	}

	.redirect-warning-suggest {
		margin-left: 0.25rem;
		font-size: 0.7rem;
		color: var(--color-danger-hover);
		opacity: 0.85;
	}

	.redirect-ok {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: var(--color-success-text);
	}

	.redirect-preview {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: var(--color-text-muted);
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.redirect-preview code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.72rem;
		background: var(--color-surface-muted);
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		color: var(--color-text);
		word-break: break-all;
	}

	.redirect-preview-label {
		font-weight: 600;
		color: var(--color-text-muted);
	}
</style>
