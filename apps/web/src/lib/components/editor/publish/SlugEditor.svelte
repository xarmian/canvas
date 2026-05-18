<script lang="ts">
	import { untrack } from 'svelte';
	import { Input } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';

	/**
	 * Slug rename editor (extracted from PublishModal in TASK-235 under
	 * PLAN-232 Phase D). Owns the entire 200-line state machine that used
	 * to live inline:
	 *
	 * - Local draft + format validation (no roundtrip on typos)
	 * - 409 collision handling with one-click "Use {{suggestion}}"
	 * - AbortController to serialize PATCHes when the user submits twice
	 * - Generation counters to drop late completions across canvas swaps
	 * - Separate UI-session counter so close→quick-reopen doesn't surface
	 *   stale errors from the previous session
	 * - Optimistic concurrency via If-Match + ETag, with one bounded
	 *   refetch+retry on 412
	 *
	 * All the "Codex round N P{1,2,3}" comments are preserved — every one
	 * documents a regression that's been caught and fixed, so they're
	 * still load-bearing reading for anyone touching this file.
	 *
	 * The component takes its own `open` prop so the close handler can
	 * reset state. Children of <Modal> stay mounted on close (the
	 * underlying <dialog> just hides them), so resetting on the open
	 * transition is the only way to clear UI state cleanly.
	 *
	 * The ETag previously got opportunistically pre-populated by
	 * PublishModal's `loadSharing` on first open. Post-extract the
	 * SlugEditor lazy-fetches on first commit (the same fallback path
	 * that was already tested via `slug rename: lazy-fetches version
	 * when canvasVersion not yet captured`). The cost is one extra GET
	 * per first rename per open; the upside is a self-contained
	 * component with no shared state.
	 */
	interface Props {
		canvasId: string;
		slug: string;
		open: boolean;
		onSlugChange?: (newSlug: string) => void;
	}

	let { canvasId, slug, open, onSlugChange }: Props = $props();

	// --- Slug rename (TASK-98) ---
	// Local draft so the user can type freely (with live format
	// validation) without committing on every keystroke. Reset
	// whenever the parent's `slug` prop changes (after a successful
	// rename, the parent calls onSlugChange and re-passes the new
	// slug as the prop).
	// `untrack` silences svelte-check's state_referenced_locally warning
	// — the $effect below is what keeps `slugDraft` in step with the
	// `slug` prop.
	let slugDraft = $state(untrack(() => slug));
	let slugBusy = $state(false);
	let slugSuggestion = $state<string | null>(null);
	let slugServerError = $state<string | null>(null);
	// Generation counter — bumped on canvasId change and on any prop-
	// driven slug reset. A late commit's writes (toast, error, busy
	// flip, slugDraft update) only land if this generation hasn't
	// rolled, so a stale completion from canvas A can't disable the
	// input on B or repopulate an error after the modal was closed.
	// Codex round 2 P2.
	let slugRenameGen = 0;
	// Separate UI-session generation. Bumps on close (and canvas
	// change) so a late completion that lands after a close →
	// quick-reopen doesn't write stale failure UI into the new
	// session. We keep `slugRenameGen` un-bumped on close so the
	// success path can still call `onSlugChange` for a server-
	// committed rename. Codex round 12 P2.
	let slugUiSessionGen = 0;
	// Records the last slug value the server rejected (409 collision or
	// 400 validation), so a subsequent blur-driven commit with the same
	// value is a no-op rather than clearing the visible error/suggestion
	// before the user can interact with them. Cleared on edit. Codex
	// round 3 P3.
	let slugLastFailed = $state<string | null>(null);
	// AbortController for the currently-in-flight slug PATCH. A newer
	// commit aborts the older one so the server doesn't process them
	// out of order (Codex round 5 P2).
	let slugInFlightController: AbortController | null = null;
	// Optimistic-concurrency version captured from the most recent
	// canvas read. Sent as `If-Match` on slug-rename PATCH so the
	// server returns 412 if another write landed first — closes the
	// server-side ordering race even if AbortController didn't reach
	// the server in time (Codex round 6). Pulled from the canvas
	// response's ETag header; updated from every successful PATCH
	// response.
	let canvasVersion = $state<string | null>(null);

	function readEtag(headers: Headers): string | null {
		const raw = headers.get('etag');
		if (!raw) return null;
		const stripped = raw.startsWith('W/') ? raw.slice(2) : raw;
		return stripped.replace(/^"|"$/g, '');
	}

	$effect(() => {
		// Reset the draft whenever the canonical slug changes (parent
		// pushed a new value after rename, or modal reopened on a
		// different canvas). Preserve any in-progress edit the user
		// has typed — a late `onSlugChange` from the previous session
		// would otherwise silently overwrite their new draft (Codex
		// round 13 P2). The dirty check is read via untrack so this
		// effect only re-fires on `slug` changes, not every keystroke.
		const userHasDraft = untrack(() => slugDraft.trim() !== '' && slugDraft !== slug);
		if (!userHasDraft) {
			slugDraft = slug;
		}
		slugSuggestion = null;
		slugServerError = null;
		slugBusy = false;
		slugLastFailed = null;
		slugRenameGen++;
		slugUiSessionGen++;
	});

	$effect(() => {
		// Reset slug-rename UI state on close. Do NOT bump
		// slugRenameGen here — the parent still needs onSlugChange
		// to fire so the editor's local canvasSlug mirror gets the
		// new value if the user submitted just before closing.
		// (Codex round 3 P2: close-bumping the generation dropped
		// the server-committed rename on the floor.) The
		// generation-bump is reserved for prop-driven changes
		// (canvas swap) and new-commit-starts.
		if (!open) {
			// `untrack` reads — we only want this effect to re-fire on
			// the `open` transition, not on every state write.
			untrack(() => {
				slugDraft = slug;
				slugServerError = null;
				slugSuggestion = null;
				slugBusy = false;
				slugLastFailed = null;
				canvasVersion = null;
				// Bump the UI session so any late completion's failure
				// branches (which gate on `isLiveAndOpen`) drop their
				// state writes. The render-gen stays untouched so the
				// success path's `onSlugChange` still fires for a
				// server-committed rename. Codex round 12 P2.
				slugUiSessionGen++;
			});
			// Don't abort on close — the user may have submitted right
			// before closing and expects the rename to land. The
			// successful completion's `isLive()` check will still call
			// `onSlugChange` since close doesn't bump the generation.
		}
	});

	/** Same format contract as `validateSlug` in $lib/server/slug.ts.
	 *  Kept inline (rather than imported) to avoid pulling the server
	 *  module into the client bundle — the regex is stable and a
	 *  format mismatch is a minor UX annoyance, not a security
	 *  concern (the server still re-validates on PATCH). */
	const SLUG_FORMAT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
	const SLUG_MAX_LENGTH = 80;

	let slugFormatError = $derived.by(() => {
		const v = slugDraft.trim();
		if (v.length === 0) return 'Slug cannot be empty.';
		if (v.length > SLUG_MAX_LENGTH)
			return `Slug cannot be longer than ${SLUG_MAX_LENGTH} characters.`;
		if (!SLUG_FORMAT_RE.test(v)) {
			return 'Use lowercase letters, numbers, and hyphens only (no leading/trailing/consecutive hyphens).';
		}
		return null;
	});

	let slugDirty = $derived(slugDraft.trim() !== slug);

	async function commitSlugRename(): Promise<void> {
		const candidate = slugDraft.trim();
		if (slugBusy) return;
		if (!slugDirty) return;
		if (slugFormatError) return; // local validation already shown
		// Don't re-submit the slug we just got rejected: a blur-driven
		// commit on an unchanged candidate would clear the visible
		// 409 error/suggestion before the user could interact with
		// it (Codex round 3 P3 — Tab from input to suggestion button).
		if (candidate === slugLastFailed) return;
		// Snapshot canvasId + generation at request start. The editor
		// route reuses this component across canvas-id navigations, and
		// the modal can close mid-flight — both produce stale completions
		// whose writes must not land. The generation counter also makes
		// the `finally`'s slugBusy reset safe: a stale completion no
		// longer leaves the input disabled on a different canvas.
		// Codex round 1 P2 + round 2 P2.
		//
		// Bump the generation BEFORE capturing it so a newer rename in
		// the same canvas invalidates an earlier in-flight one. Without
		// this bump, a close→reopen→submit-different-slug sequence
		// could share a generation with the still-pending earlier
		// request — request A's late success would call onSlugChange
		// and bump gen, dropping request B. Codex round 4 P2.
		//
		// IMPORTANT (Codex round 9 P1): the generation/controller setup
		// happens BEFORE any lazy fetch. Otherwise a slow lazy-fetch
		// could be preempted by a newer commit that completes its
		// PATCH first, then resume after the await and overwrite the
		// canonical state with the stale candidate.
		slugRenameGen++;
		// Abort any in-flight rename so the server doesn't process two
		// concurrent PATCHes for the same canvas in arrival order
		// (which can be different from submission order). The aborted
		// request's catch branch checks isLive() and bails — server
		// already won't commit since the connection's gone.
		// Codex round 5 P2.
		slugInFlightController?.abort();
		const controller = new AbortController();
		slugInFlightController = controller;
		const requestCanvasId = canvasId;
		const requestGen = slugRenameGen;
		const requestUiSession = slugUiSessionGen;
		const isLive = () => requestCanvasId === canvasId && requestGen === slugRenameGen;
		// `isLiveAndOpen` gates UI writes (errors / suggestions /
		// busy state) so a late completion after the modal closed
		// doesn't repopulate stale UI state for the next open.
		// Compares against the UI session that was active when the
		// request started — close (or canvas swap) bumps that
		// session, so a close → quick-reopen leaves a stale request
		// looking at a different session and its UI writes drop.
		// The success path's `onSlugChange` still uses `isLive()`
		// (no UI-session check) so a server-committed rename
		// always propagates to the editor mirror, even if the user
		// closed the modal mid-flight. Codex round 11 P2 + round 12 P2.
		const isLiveAndOpen = () => isLive() && open && requestUiSession === slugUiSessionGen;
		slugBusy = true;
		slugServerError = null;
		slugSuggestion = null;

		// Optimistic concurrency: every slug rename ships with an
		// `If-Match` header. SlugEditor lazy-fetches the version on
		// first commit; failure to obtain a version surfaces inline so
		// the user can edit + retry (Codex round 8 P2).
		let ifMatchVersion = canvasVersion;
		try {
			if (!ifMatchVersion) {
				ifMatchVersion = await fetchCanvasVersion(requestCanvasId, controller);
				// `isLive()` after the await: a newer commit may have
				// invalidated us, or the canvas may have changed.
				if (!isLive()) return;
				if (ifMatchVersion === null) {
					// Don't set slugLastFailed for transient version-fetch
					// failures — the user should be able to immediately
					// retry the same candidate without editing first
					// (Codex round 9 P2). Skip the UI write entirely if
					// the modal closed before this resolved (round 11 P2).
					if (isLiveAndOpen()) {
						slugServerError = "Couldn't read canvas version. Please try again.";
					}
					return;
				}
				canvasVersion = ifMatchVersion;
			}
			let res = await sendSlugPatch(requestCanvasId, candidate, ifMatchVersion, controller);
			// Optimistic-concurrency retry (TASK-98 / Codex round 6):
			// on 412 the server's seen a write since our last read.
			// Refetch to get the fresh version and retry once. The
			// refetch is bounded (one attempt) so a persistent
			// concurrent-edit storm surfaces an error instead of
			// looping forever.
			if (res.status === 412 && isLive()) {
				const refreshed = await fetchCanvasVersion(requestCanvasId, controller);
				if (!isLive()) return;
				if (refreshed === null) {
					// Transient — same retry-on-edit policy applies
					// (Codex round 9 P2): don't mark the candidate
					// as failed, the user should be able to retry
					// the same value.
					if (isLiveAndOpen()) slugServerError = "Couldn't refresh canvas state. Please try again.";
				} else {
					canvasVersion = refreshed;
					res = await sendSlugPatch(requestCanvasId, candidate, refreshed, controller);
				}
			}
			if (!isLive()) return;
			if (res.ok) {
				const etag = readEtag(res.headers);
				const data = (await res.json()) as { slug: string };
				// onSlugChange should fire only if THIS request is still
				// the live one — same canvas AND same generation. A
				// newer commit-start would have bumped the generation,
				// so calling onSlugChange here would clobber the newer
				// rename's value. Codex round 5 P3.
				if (!isLive()) return;
				onSlugChange?.(data.slug);
				if (etag) canvasVersion = etag;
				// Modal-only UI writes — guarded by `open` so a late
				// success after close doesn't flash a "renamed" toast
				// or reset state the close-handler already cleared.
				// (The onSlugChange call above is what's actually
				// user-visible since the editor mirror updates; the
				// in-modal slugDraft/toast just keep the open modal
				// in sync.) Codex round 11 P2.
				if (isLiveAndOpen()) {
					slugDraft = data.slug;
					slugLastFailed = null;
					toast.success('Slug renamed');
				}
			} else if (res.status === 409) {
				const body = (await res.json()) as { message: string; suggestion?: string };
				if (!isLiveAndOpen()) return;
				slugServerError = body.message;
				slugSuggestion = body.suggestion ?? null;
				slugLastFailed = candidate;
			} else if (res.status === 400) {
				const body = (await res.json()) as { message: string };
				if (!isLiveAndOpen()) return;
				slugServerError = body.message;
				slugLastFailed = candidate;
			} else if (res.status === 412) {
				// Second 412 after a refetch+retry — concurrent
				// contention, not a problem with the slug value
				// itself. Don't mark `slugLastFailed` so the user
				// can press Enter again and retry the same value
				// once contention subsides (Codex round 10 P2).
				if (!isLiveAndOpen()) return;
				slugServerError = 'Canvas is being updated by another tab or device. Please try again.';
			} else {
				if (!isLiveAndOpen()) return;
				slugServerError = `Couldn't rename slug (${res.status}).`;
				slugLastFailed = candidate;
			}
		} catch (err) {
			// AbortError is the expected outcome when a newer commit
			// supersedes this one — silently drop. Real network errors
			// surface via slugServerError, but only if we're still
			// live AND open (otherwise the newer commit owns the UI,
			// or the modal closed and a stale error would resurface
			// on reopen). Network errors don't mark slugLastFailed —
			// they're transient, so the user should be able to retry
			// the same candidate without editing first
			// (Codex round 9 P2).
			if ((err as { name?: string })?.name === 'AbortError') return;
			if (!isLiveAndOpen()) return;
			slugServerError = "Couldn't reach the server. Please try again.";
		} finally {
			// Always release the busy flag if THIS request's generation
			// is still live — even if we returned early via !isLive().
			// Without this, a stale-completion path that drops on
			// generation mismatch would leave slugBusy=true on the
			// new canvas (the new canvas has its own generation now,
			// and its commitSlugRename guard short-circuits on busy).
			if (isLive()) {
				slugBusy = false;
				slugInFlightController = null;
			}
		}
	}

	/** Issue a slug-rename PATCH with the given If-Match version. Pulled
	 *  out of `commitSlugRename` so the 412 retry path can re-issue
	 *  with a fresh version. */
	async function sendSlugPatch(
		id: string,
		candidate: string,
		ifMatchVersion: string | null,
		controller: AbortController
	): Promise<Response> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (ifMatchVersion) headers['If-Match'] = `"${ifMatchVersion}"`;
		return fetch(`/api/canvas/${id}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ slug: candidate }),
			signal: controller.signal
		});
	}

	/** Refetch the canvas just to get the current ETag for a 412 retry
	 *  or the initial If-Match. Returns null if the GET itself failed —
	 *  the caller surfaces a generic error in that case. */
	async function fetchCanvasVersion(
		id: string,
		controller: AbortController
	): Promise<string | null> {
		try {
			const res = await fetch(`/api/canvas/${id}`, { signal: controller.signal });
			if (!res.ok) return null;
			return readEtag(res.headers);
		} catch {
			return null;
		}
	}

	function applySlugSuggestion(): void {
		if (slugSuggestion) {
			slugDraft = slugSuggestion;
			slugSuggestion = null;
			slugServerError = null;
			void commitSlugRename();
		}
	}
</script>

<div class="field">
	<label for="publish-slug">Slug</label>
	<!--
		Slug rename (TASK-98). Format-validated locally so a typo
		is caught without a roundtrip; collisions surface as a
		server 409 with an inline "Use {{suggestion}}" button so
		the user can accept the alternative with one click.
		No 308 from the old slug — pre-launch latitude (PLAN-81).
	-->
	<div class="copy-row">
		<Input
			id="publish-slug"
			type="text"
			data-testid="slug-input"
			value={slugDraft}
			disabled={slugBusy}
			invalid={(slugDirty && slugFormatError !== null) || slugServerError !== null}
			oninput={(e) => {
				slugDraft = e.currentTarget.value;
				slugServerError = null;
				slugSuggestion = null;
				// Clear the "this slug failed" flag whenever the
				// user edits — they're attempting a new value, so
				// blur-commit should run again.
				slugLastFailed = null;
			}}
			onblur={() => void commitSlugRename()}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					void commitSlugRename();
				}
			}}
		/>
	</div>
	{#if slugDirty && slugFormatError}
		<p class="slug-error" data-testid="slug-format-error">{slugFormatError}</p>
	{:else if slugServerError}
		<p class="slug-error" data-testid="slug-server-error" role="alert">
			{slugServerError}
			{#if slugSuggestion}
				<!--
					`onmousedown preventDefault` keeps the input
					from blurring when the user clicks this button.
					Without it, blur fires first → commitSlugRename
					runs on the still-colliding draft → clears
					slugSuggestion → the button is now hidden, so
					the click never lands and nothing happens.
					Codex round 2 P3.
				-->
				<button
					type="button"
					class="slug-suggestion-btn"
					data-testid="slug-suggestion-apply"
					onmousedown={(e) => e.preventDefault()}
					onclick={applySlugSuggestion}
					disabled={slugBusy}
				>
					Use “{slugSuggestion}”
				</button>
			{/if}
		</p>
	{:else}
		<p class="help">
			The user-typed half of <code>/c/{`{slug}`}</code>. Lowercase letters, numbers, hyphens. No
			back-compat redirect from the old slug — old URLs 404 immediately.
		</p>
	{/if}
</div>

<style>
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

	.copy-row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
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

	.slug-error {
		margin: 0.4rem 0 0;
		padding: 0.4rem 0.55rem;
		background: var(--color-danger-surface);
		border: 1px solid var(--color-danger-border);
		border-radius: 4px;
		font-size: 0.75rem;
		color: var(--color-danger-hover);
		line-height: 1.45;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
	}

	.slug-suggestion-btn {
		font-size: 0.7rem;
		padding: 0.15rem 0.45rem;
		border-radius: 4px;
		background: var(--color-bg);
		border: 1px solid var(--color-danger-border);
		color: var(--color-danger-hover);
		cursor: pointer;
	}

	.slug-suggestion-btn:hover:not(:disabled) {
		background: var(--color-danger-border);
	}

	.slug-suggestion-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/*
	 * TASK-146: previously the chip rendered no visible focus ring on
	 * keyboard nav — a click-to-fix surface that keyboard users
	 * couldn't see they were aiming at. Outline matches the Button
	 * primitive's focus token so the indicator reads consistent
	 * across modal surfaces.
	 */
	.slug-suggestion-btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}
</style>
