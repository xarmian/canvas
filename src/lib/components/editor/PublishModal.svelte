<script lang="ts">
	import { untrack } from 'svelte';
	import { Modal, Button, Input, Textarea, ErrorState, LoadingSkeleton } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { nearestParamName } from './param-validation';

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
	/** Same role as `paramRowsError` for the sharing-config fetch
	 *  (GET /api/canvas/[id]). Surfaces the failure inline with a retry
	 *  rather than silently leaving the inputs disabled (TASK-136). */
	let sharingError = $state(false);
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
			// both generation counters so any in-flight `loadSharing` /
			// `loadParamSchema` from this session is treated as stale on
			// completion.
			paramRowsLoaded = false;
			paramRowsError = false;
			paramRows = [];
			paramRowsGen++;
			versionToken = null;
			sharingLoaded = false;
			sharingError = false;
			sharingPending = false;
			sharingGen++;
			sharing = { ogTitle: '', ogDescription: '', redirectUrl: '' };
			// Reset slug-rename UI state on close. Do NOT bump
			// slugRenameGen here — the parent still needs onSlugChange
			// to fire so the editor's local canvasSlug mirror gets the
			// new value if the user submitted just before closing.
			// (Codex round 3 P2: close-bumping the generation dropped
			// the server-committed rename on the floor.) The
			// generation-bump is reserved for prop-driven changes
			// (canvas swap) and new-commit-starts.
			slugDraft = slug;
			slugServerError = null;
			slugSuggestion = null;
			slugBusy = false;
			slugLastFailed = null;
			canvasVersion = null;
			// Bump the UI session so any late completion's failure
			// branches (which gate on `isLiveAndOpenUi`) drop their
			// state writes. The render-gen stays untouched so the
			// success path's `onSlugChange` still fires for a
			// server-committed rename. Codex round 12 P2.
			slugUiSessionGen++;
			// Don't abort on close — the user may have submitted right
			// before closing and expects the rename to land. The
			// successful completion's `isLive()` check will still call
			// `onSlugChange` since close doesn't bump the generation.
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
		paramRowsError = false;
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
		}
	}

	function retryLoadParamSchema(): void {
		paramRowsError = false;
		void loadParamSchema();
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
		sharingError = false;
		try {
			const res = await fetch(`/api/canvas/${canvasId}`);
			if (requestCanvasId !== canvasId || requestGen !== sharingGen) return;
			if (res.ok) {
				// Capture the ETag for optimistic-concurrency PATCHes
				// (slug rename). Strip the standard `W/`/quote wrapping
				// so the value can be re-emitted as `If-Match: "<v>"`.
				const etag = readEtag(res.headers);
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
				if (etag) canvasVersion = etag;
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
	 *  match any of this canvas's bound parameters, paired with the
	 *  closest known name (TASK-106) when one exists within the
	 *  shared validator's typo threshold. Used to surface a red
	 *  warning AND a "did you mean X?" chip per offender. Recomputes
	 *  whenever the redirect URL or the bindings change. */
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
	// Generation counter — bumped on close, on canvasId change, and on
	// any prop-driven slug reset. A late commit's writes (toast, error,
	// busy flip, slugDraft update) only land if this generation hasn't
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
	// updatedAt's millisecond timestamp; updated from every successful
	// fetch / PATCH response.
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
		// round 13 P2). The dirty check (`!slugDirty`) is read via
		// untrack so this effect only re-fires on `slug` changes, not
		// every keystroke.
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
		// `If-Match` header. The version is captured by `loadSharing`
		// on modal open, but if that GET hasn't completed yet (or
		// failed transiently — Codex round 8 P2), we lazy-fetch
		// before submitting so a fast typist's first commit still
		// gets concurrency protection. Failure to obtain a version
		// surfaces inline; the user can edit + retry.
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

	/** Refetch the canvas just to get the current ETag for a 412 retry.
	 *  Returns null if the GET itself failed — the caller surfaces a
	 *  generic error in that case. */
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
		// og:url tracks `og:image`'s parameterization: when the user
		// toggles "Include example params" we emit the parameterized
		// share URL too, so a parameterized og:image variant doesn't
		// canonicalize back to the unparameterized page (Codex round 1
		// P2). Mirrors the share route's behavior of preserving the
		// non-reserved query params in og:url.
		const ogUrl = includeParams ? `${shareUrl}${buildQueryString()}` : shareUrl;
		const lines = [
			`<meta property="og:image" content="${snippetImageUrl}" />`,
			`<meta property="og:image:width" content="1200" />`,
			`<meta property="og:image:height" content="630" />`,
			`<meta property="og:image:type" content="image/png" />`
		];
		if (snippetImageUrl.startsWith('https://')) {
			lines.push(`<meta property="og:image:secure_url" content="${snippetImageUrl}" />`);
		}
		lines.push(`<meta property="og:url" content="${ogUrl}" />`);
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
			<Button variant="primary" loading={busy} onclick={() => togglePublished(true)}>
				{busy ? 'Publishing…' : 'Publish canvas'}
			</Button>
		</div>
	{:else}
		<p class="intro">
			Your canvas is live. Share the page URL, or use the image URL directly in an
			<code>og:image</code> tag or API call.
		</p>

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

		<div class="field">
			<label for="publish-share-url">Share page URL</label>
			<div class="copy-row">
				<Input id="publish-share-url" type="text" readonly value={shareUrl} class="url-input" />
				<Button variant="copy" onclick={() => copy(shareUrl, 'Share URL')}>Copy</Button>
			</div>
			<p class="help">
				Humans see an OG preview + redirect; bots/crawlers get <code>og:image</code> meta tags.
			</p>
		</div>

		<div class="field">
			<label for="publish-image-url">Image URL</label>
			<div class="copy-row">
				<Input id="publish-image-url" type="text" readonly value={imageUrl} class="url-input" />
				<Button variant="copy" onclick={() => copy(imageUrl, 'Image URL')}>Copy</Button>
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

			{#if sharingError}
				<!--
					GET /api/canvas/[id] failed (5xx, network). Surface
					the error inline with retry instead of leaving the
					inputs locked silently. Inputs unlock anyway via the
					finally block so the user can also choose to type
					values directly. (TASK-136)
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
				blank field before the GET completes would have their
				input overwritten when the response arrived, then their
				blur would save the (stale) server value.
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
				<Textarea
					readonly
					value={activeSnippet}
					rows={activeTab === 'og' ? 3 : 2}
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

			{#if paramRowsError}
				<!--
					GET /api/canvas/[id]/params failed. The bindings table
					still renders below (those come from the in-memory
					Fabric canvas), but Type / Required cells stay
					disabled until the schema reaches the editor — so
					surface the error inline with retry instead of
					silently leaving them stuck. (TASK-136)
				-->
				<div class="docs-error" data-testid="docs-schema-error">
					<ErrorState
						title="Couldn't load Type / Required"
						message="The server-side parameter schema didn't reach the editor. Bindings still show below; Type and Required can't be edited until the schema loads."
						onRetry={retryLoadParamSchema}
					/>
				</div>
			{:else if bindings.length > 0 && !paramRowsLoaded}
				<!--
					Skeleton fills the table area so it doesn't look
					broken while the GET is in flight.
				-->
				<div
					class="docs-skeleton"
					data-testid="docs-skeleton"
					aria-label="Loading parameter schema"
				>
					<LoadingSkeleton lines={3} />
				</div>
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
						<Input
							id="publish-example-image"
							type="text"
							readonly
							value={exampleImageUrl}
							class="url-input"
						/>
						<Button variant="copy" onclick={() => copy(exampleImageUrl, 'Example URL')}>
							Copy
						</Button>
					</div>
				</div>

				<div class="field">
					<label for="publish-curl">Copy as cURL</label>
					<div class="copy-row">
						<Input
							id="publish-curl"
							type="text"
							readonly
							value={curlFor(exampleImageUrl)}
							class="url-input"
						/>
						<Button variant="copy" onclick={() => copy(curlFor(exampleImageUrl), 'cURL command')}>
							Copy
						</Button>
					</div>
					<p class="help">
						Downloads the rendered PNG to <code>canvas.png</code>. No auth required — public
						endpoint.
					</p>
				</div>

				<div class="field">
					<label for="publish-example-share">Example share URL</label>
					<div class="copy-row">
						<Input
							id="publish-example-share"
							type="text"
							readonly
							value={exampleShareUrl}
							class="url-input"
						/>
						<Button variant="copy" onclick={() => copy(exampleShareUrl, 'Example share URL')}>
							Copy
						</Button>
					</div>
				</div>
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

	/*
	 * Read-only URL displays inside `.copy-row` use the Input primitive
	 * but want a monospace + slightly muted treatment so the URL/cURL
	 * value is visually distinct from a normal editable text field.
	 * `:global` reaches through the primitive's scoped CSS — every Input
	 * with `class="url-input"` in this modal opts into this treatment.
	 */
	.copy-row :global(.url-input) {
		flex: 1;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.8125rem;
		background: var(--color-surface-muted);
	}

	.help {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: var(--color-text-subtle);
		line-height: 1.4;
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

	.help code {
		background: var(--color-surface-muted);
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
		border-top: 1px solid var(--color-border);
	}

	/*
	 * `.btn-link` and `.btn.btn-secondary` remain for the few <a> elements
	 * that act as buttons (embed "Open in new tab", validator anchors).
	 * The Button primitive renders <button>, not <a>; href-bearing
	 * variants would need a primitive change (Button polymorphism). Until
	 * then, anchors keep their inline styles. Tracked for follow-up after
	 * TASK-110 — anchor styling will inherit token vars in the same pass.
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

	.btn-secondary {
		background: var(--color-bg);
		color: var(--color-text-muted);
		border-color: var(--color-border-strong);
	}

	.btn-secondary:hover {
		background: var(--color-surface-muted);
	}

	.btn-link {
		background: none;
		color: var(--color-primary);
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

	.sharing-error,
	.docs-error {
		margin: 0 0 var(--spacing-3);
	}

	.sharing-skeleton,
	.docs-skeleton {
		margin: 0 0 var(--spacing-3);
		display: flex;
		flex-direction: column;
		gap: var(--spacing-2);
	}

	/*
	 * Sharing-section inputs/textareas now come from the Input/Textarea
	 * primitives, which already provide identical padding, border,
	 * radius, font, and background. The previous element-selector
	 * overrides have been removed.
	 */

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
	 * The embed snippet textarea now uses the Textarea primitive with
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

	.validator-section {
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px solid var(--color-border);
	}

	.validator-title {
		margin: 0 0 0.4rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.validator-hint {
		margin: 0 0 0.6rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
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
		border-top: 1px solid var(--color-border);
	}

	.docs-title {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text);
	}

	.docs-hint,
	.docs-empty {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.docs-empty {
		background: var(--color-surface-muted);
		border: 1px dashed var(--color-border-strong);
		border-radius: 5px;
		padding: 0.625rem 0.75rem;
	}

	.docs-warning {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 5px;
		font-size: 0.75rem;
		color: var(--color-warning-text);
		line-height: 1.45;
	}

	.docs-table {
		margin-bottom: 1rem;
		border: 1px solid var(--color-border);
		border-radius: 5px;
		overflow: hidden;
		font-size: 0.8125rem;
	}

	.docs-row {
		display: grid;
		grid-template-columns: 1fr 1fr 0.9fr 0.8fr;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid var(--color-surface-muted);
		align-items: center;
	}

	.docs-type-select {
		font-size: 0.75rem;
		padding: 0.15rem 0.3rem;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		background: var(--color-bg);
	}

	.docs-required-cell {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		color: var(--color-text-muted);
	}

	.docs-required-cell input[type='checkbox'] {
		margin: 0;
	}

	.docs-row:last-child {
		border-bottom: none;
	}

	.docs-row-header {
		background: var(--color-surface);
		font-size: 0.6875rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-text-subtle);
		font-weight: 600;
	}

	.docs-param-name,
	.docs-param-default {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.75rem;
		background: var(--color-surface-muted);
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		overflow-x: auto;
		white-space: nowrap;
	}
</style>
