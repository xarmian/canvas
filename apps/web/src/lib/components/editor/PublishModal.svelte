<script lang="ts">
	import { Modal, Button, Input, Textarea, ErrorState, LoadingSkeleton } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';
	import { copyToClipboard } from '$lib/share-clipboard';
	import { nearestParamName } from './param-validation';
	import CopyUrlRow from './publish/CopyUrlRow.svelte';
	import SlugEditor from './publish/SlugEditor.svelte';
	import SocialValidator from './publish/SocialValidator.svelte';
	import {
		buildQueryString,
		curlFor,
		curlSnippet as buildCurlSnippet,
		htmlSnippet as buildHtmlSnippet,
		markdownSnippet as buildMarkdownSnippet,
		ogSnippet as buildOgSnippet,
		python as buildPythonSnippet,
		tsSimple as buildTsSimpleSnippet,
		tsTyped as buildTsTypedSnippet,
		urlSnippet as buildUrlSnippet,
		type ParamSchema,
		type ParamType,
		type SnippetInput
	} from '$lib/embed/snippets';

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
		if (open && published && !paramRowsLoaded && !paramRowsPending) {
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
			paramRowsPending = false;
			versionToken = null;
			sharingLoaded = false;
			sharingError = false;
			sharingPending = false;
			sharingGen++;
			sharing = { ogTitle: '', ogDescription: '', redirectUrl: '' };
			// Slug-rename state is owned by <SlugEditor> and resets
			// itself when `open` flips. Sharing/paramRows/version-token
			// resets stay here until those subsystems also extract
			// (TASK-236, TASK-237, TASK-238).
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

	/** Tab state for the embed-snippet section. TS/Python tabs added in
	 * TASK-211 (PLAN-206). Order in this union doubles as the visual
	 * order in the tab strip below, so any reorder here should update
	 * EMBED_TABS too. */
	type EmbedTab = 'html' | 'markdown' | 'og' | 'url' | 'curl' | 'typescript' | 'python';
	let activeTab = $state<EmbedTab>('html');
	/** Sub-flavor inside the TypeScript tab — `simple` shows an
	 * untyped `Record<string, string>` snippet, `typed` generates
	 * `type Params = {...}` from the canvas schema. State lives on
	 * the modal so the user's choice persists across activeTab
	 * switches within a single open. */
	type TsFlavor = 'simple' | 'typed';
	let tsFlavor = $state<TsFlavor>('simple');
	/** Whether to include example query parameter values in the snippets. */
	let includeParams = $state(false);

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
				// (The ETag that this GET also returns used to be
				// captured here to pre-populate <SlugEditor>'s If-Match
				// state. After the TASK-235 extract SlugEditor owns its
				// own version lifecycle; it lazy-fetches on first
				// commit instead. One extra GET per first rename per
				// open is the tradeoff.)
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

	// --- Slug rename (TASK-98) extracted to <SlugEditor> in TASK-235.
	//     The entire state machine + ETag / If-Match handling now lives
	//     in that component; PublishModal just forwards `slug`,
	//     `canvasId`, `open`, and the `onSlugChange` callback.

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
	/** Recognised `canvas_params.type` vocabulary, mirroring the
	 * narrow union in `$lib/embed/snippets`. Unknown values from the
	 * API fall back to `text` so the typed-TS snippet stays
	 * runnable rather than emitting `: unknown` for a field whose
	 * type the modal happens not to know about (TASK-211). */
	const KNOWN_PARAM_TYPES: readonly ParamType[] = ['text', 'number', 'boolean', 'url', 'date'];
	function toParamType(raw: string): ParamType {
		return (KNOWN_PARAM_TYPES as readonly string[]).includes(raw) ? (raw as ParamType) : 'text';
	}
	let paramSchemas = $derived<ParamSchema[]>(
		paramRows.map((r) => ({ name: r.name, type: toParamType(r.type) }))
	);

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
		// declaration and Python's per-key coercion. Undefined when
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
	/** Convenience alias for the "Open in new tab" link in the embed
	 * section template — same composed URL the URL/cURL/HTML snippets
	 * use, just exposed under a name the markup already references. */
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
	 * rows; OG meta is ~5 short lines. Sized to show the whole
	 * snippet without scrolling for typical canvases (2-3 params). */
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
	 * Arrow keys cycle (with wrap), Home/End jump to ends. We
	 * activate-on-focus rather than activate-on-Enter so the snippet
	 * preview updates as the user arrows through — matches
	 * `aria-orientation="horizontal"` semantics and the AddImageModal
	 * tabs we mirror. Focus shifts to the activated button so
	 * subsequent Tab navigation continues from the right place. */
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
		// Move focus to the newly-active tab. Queried inside the same
		// click handler — the button exists already (each tab renders
		// regardless of activeTab); we just need to find it by its
		// stable data-testid.
		queueMicrotask(() => {
			const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
			const tablist = root?.closest('[role="tablist"]');
			const btn = tablist?.querySelector<HTMLButtonElement>(
				`[data-testid="embed-tab-${nextTab.id}"]`
			);
			btn?.focus();
		});
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
		// Delegates to the canonical helper so clipboard logic, fallback
		// path, and toast wording stay consistent across the editor
		// toolbar, this modal, and the dashboard card menu (TASK-132).
		await copyToClipboard(value, { success: `${label} copied to clipboard` });
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

			<div
				class="embed-tabs"
				role="tablist"
				aria-label="Embed format"
				aria-orientation="horizontal"
			>
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

		<SocialValidator {shareUrl} />

		<section class="docs-section">
			<h3 class="docs-title">Using this template</h3>

			{#if bindingsStale}
				<p class="docs-warning">
					⚠️ This canvas has unsaved edits. The dynamic values below may not yet be live on the
					public URL. Save the canvas, then reopen this dialog for the authoritative docs.
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
						message="The saved type/required settings didn't reach the editor. The dynamic values still show below; Type and Required can't be edited until they load."
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
					aria-label="Loading saved type and required"
				>
					<LoadingSkeleton lines={3} />
				</div>
			{/if}

			{#if bindings.length === 0}
				<p class="docs-empty">
					This canvas has no dynamic values yet. Make properties dynamic in the editor (⚡ Dynamic
					values in the property panel) to make the shared URL change based on query string values.
				</p>
			{:else}
				<p class="docs-hint">
					This canvas accepts {bindings.length}
					{bindings.length === 1 ? 'dynamic value' : 'dynamic values'}. Omit any to use its default
					value.
				</p>

				<div class="docs-table">
					<div class="docs-row docs-row-header">
						<span>Name</span>
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
	 * `.btn-link` remains for the embed "Open in new tab" anchor. The
	 * Button primitive renders <button>, not <a>; href-bearing variants
	 * would need a primitive change (Button polymorphism). Until then,
	 * anchors keep their inline styles. Tracked for follow-up after
	 * TASK-110 — anchor styling will inherit token vars in the same pass.
	 * (The `.btn-secondary` variant moved out with <SocialValidator> in
	 * TASK-233.)
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
	 * TASK-146: keyboard nav across the embed tablist had no visible
	 * focus state — the active-tab underline doesn't double as a
	 * focus indicator because it only shows on the active tab, not
	 * the focused-but-unselected one. Matches the AddImageModal tab
	 * pattern (outline-offset: -2px so the ring sits inside the
	 * border-bottom track rather than blowing out the row layout).
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
