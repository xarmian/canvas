<script lang="ts">
	/**
	 * Params schema panel (TASK-105) — surfaces the unified per-canvas
	 * parameter schema *inside* the editor so authors don't have to
	 * publish, open the publish modal, edit types/required, and republish
	 * just to fix a wrong type.
	 *
	 * Two data sources, merged on `name`:
	 *  1. In-memory `paramBindings` walked off `editorState.fabricCanvas`
	 *     gives us the live default + formatter + which layers reference
	 *     the param. Edits to the default flow back into Fabric (see
	 *     `updateDefault`) so the editor's preview + autosave reflect the
	 *     change immediately, identical to the per-property bind editor
	 *     (TASK-104).
	 *  2. The DB-backed `canvas_params` table (loaded via
	 *     `GET /api/canvas/[id]/params`) gives us the user-managed
	 *     `type` + `required` flags. Those rows only exist for
	 *     PUBLISHED canvases — `syncCanvasParams` runs on PATCH and
	 *     unpublished canvases never PATCH templateJson via the publish
	 *     route. So when the canvas is unpublished, type/required are
	 *     read-only "text / not required" placeholders; the user sees
	 *     the column but the controls explain why they're disabled. The
	 *     publish modal still owns those fields after first publish — we
	 *     just no longer force a roundtrip through it.
	 *
	 * The component itself is presentational; the parent (edit/+page) owns
	 * the open/close lifecycle. We rely on `editorState.editGeneration`
	 * for reactive recomputation as the user edits bindings — same trick
	 * the property panel uses.
	 */
	import { Modal, LoadingSkeleton, EmptyState, ErrorState } from '$lib/components/ui';
	import { Sliders } from '@lucide/svelte';
	import { editorState, markDirty } from './state.svelte.ts';
	import type { FabricObject } from 'fabric';
	import { toast } from '$lib/stores/toast.svelte';

	interface Props {
		open: boolean;
		canvasId: string;
		published: boolean;
		onClose: () => void;
	}
	let { open, canvasId, published, onClose }: Props = $props();

	/** Param schema row as returned by GET /api/canvas/[id]/params and
	 *  accepted by the PATCH /api/canvas/[id] body's `params: [...]`. */
	interface SchemaRow {
		name: string;
		type: string;
		required: boolean;
	}
	let schemaRows = $state<SchemaRow[]>([]);
	let schemaLoaded = $state(false);
	/** Set when the GET /params fetch returns non-OK or the network call
	 *  itself rejects. Drives the inline ErrorState retry surface so the
	 *  failure isn't silently swallowed (TASK-136). */
	let schemaError = $state(false);
	/** Tracks an in-flight GET so a parent re-render doesn't fire a
	 *  second load while the first is still landing. Without this, the
	 *  second response could overwrite the first's freshly-edited rows
	 *  if it took longer to return. */
	let schemaPending = $state(false);
	/** Monotonic generation token — incremented at every loadSchema()
	 *  start and stored in `schemaPendingGen`. The finally block only
	 *  clears `schemaPending` when its captured generation still matches
	 *  the current one; a stale completion that lost the race is
	 *  treated as if it never happened. Without this, canvas A's late
	 *  finally would clear `schemaPending=false` while canvas B's
	 *  newer request was still in flight, letting the $effect kick off
	 *  a duplicate B fetch whose response would clobber any optimistic
	 *  type/required edit the user had made between requests.
	 *  Codex round 3 P2. */
	let schemaPendingGen = 0;
	/** The canvasId the cached `schemaRows` belong to. Compared against
	 *  the current `canvasId` prop on every $effect run so a parent-
	 *  level canvas switch (the editor route reuses this component
	 *  across navigations) refetches instead of silently rendering
	 *  stale rows for canvas A while the user is editing canvas B.
	 *  Codex round 1 P1. */
	let schemaCanvasId = $state<string | null>(null);

	/** Per-binding metadata derived from the live Fabric canvas — used to
	 *  surface which layers reference each param and to expose the
	 *  binding's current default + formatter. First-seen default wins
	 *  across layers (matches `collectBoundParams` / `deriveCanvasParams`
	 *  shape so the editor + server agree on which default the renderer
	 *  will see). */
	interface DerivedParam {
		name: string;
		default: string;
		formatter?: string;
		sources: { layerLabel: string; property: string }[];
	}

	/** Property-key → human label, mirrored from PropertyPanel's
	 *  ALL_BINDABLE_META for display in the Sources column. Kept inline
	 *  rather than imported because the property panel's map is private
	 *  and importing would force the panel to export a side-effect-y
	 *  table. The cost of duplication is one row per supported property. */
	const PROPERTY_LABELS: Record<string, string> = {
		text: 'Text Content',
		fontSize: 'Font Size',
		fill: 'Fill Color',
		src: 'Image Source',
		label: 'Badge Label',
		iconImage: 'Badge Icon',
		fg: 'Badge Foreground',
		opacity: 'Opacity',
		visible: 'Visibility',
		left: 'Position X',
		top: 'Position Y',
		width: 'Width',
		height: 'Height'
	};

	function labelForProperty(prop: string): string {
		// Sentinel for params surfaced via a conditionalStyles rule rather
		// than a property binding — kept as a constant so the source
		// column can render a different style for it.
		if (prop === '__conditional__') return 'Conditional rule';
		return PROPERTY_LABELS[prop] ?? prop;
	}

	function labelForLayer(obj: FabricObject): string {
		const t = obj.type?.toLowerCase() ?? '';
		if (t === 'i-text' || t === 'itext' || t === 'textbox' || t === 'text') {
			const text = (obj.get('text') as string) ?? '';
			return text.length > 20 ? text.slice(0, 20) + '…' : text || 'Text';
		}
		if (t === 'image' || t === 'fabricimage') return 'Image';
		if (t === 'rect') return 'Rectangle';
		if (t === 'badge') {
			const label = (obj.get('label') as string) ?? '';
			return label ? `Badge: ${label}` : 'Badge';
		}
		return obj.type ?? 'Layer';
	}

	let derivedParams = $derived.by<DerivedParam[]>(() => {
		// editGeneration is the same reactive dependency the property
		// panel uses — rebuild whenever Fabric mutates an object in place
		// (binding default edits, conditional rule edits, etc.).
		void editorState.editGeneration;
		const canvas = editorState.fabricCanvas;
		if (!canvas) return [];
		// Plain object as a dedup index. Avoid `new Map()` to keep the
		// `svelte/prefer-svelte-reactivity` lint rule satisfied — the
		// derivation doesn't need reactive Map semantics; the whole
		// derived array is recomputed on editGeneration ticks.
		const byName: Record<string, DerivedParam> = Object.create(null);
		const order: string[] = [];
		const ensure = (name: string, init?: { default?: string; formatter?: string }) => {
			if (!byName[name]) {
				byName[name] = {
					name,
					default: init?.default ?? '',
					formatter: init?.formatter,
					sources: []
				};
				order.push(name);
			}
		};
		for (const obj of canvas.getObjects()) {
			const layerLabel = labelForLayer(obj);
			const augmented = obj as FabricObject & {
				paramBindings?: Record<string, { param: string; default: string; format?: string }>;
				conditionalStyles?: Array<{ when?: { param?: string } }>;
			};
			const bindings = augmented.paramBindings;
			if (bindings) {
				for (const [property, b] of Object.entries(bindings)) {
					const name = b.param;
					if (!name) continue;
					ensure(name, { default: b.default ?? '', formatter: b.format });
					byName[name].sources.push({ layerLabel, property });
				}
			}
			// Conditional rules can reference params that aren't bound to
			// any property — the server's deriveCanvasParams treats them
			// as real schema rows, so the editor must surface them too or
			// the user can't set type/required for a conditional-only
			// param. Codex round 1 P2. Source label distinguishes them
			// from binding-driven sources.
			const rules = augmented.conditionalStyles;
			if (rules) {
				for (const rule of rules) {
					const name = rule.when?.param;
					if (!name) continue;
					ensure(name);
					byName[name].sources.push({
						layerLabel,
						property: '__conditional__'
					});
				}
			}
		}
		return order.map((n) => byName[n]);
	});

	$effect(() => {
		// Only fetch the schema rows for published canvases — `syncCanvasParams`
		// only runs when templateJson is PATCH'd through the publish path,
		// so unpublished canvases have no rows on the server side to fetch.
		// Refetch when the canvasId itself changes (parent reuses this
		// component across canvas-id navigations) — without that check
		// canvas A's schemaRows would briefly show on canvas B until the
		// next close+reopen. Codex round 1 P1.
		const stale = schemaCanvasId !== null && schemaCanvasId !== canvasId;
		if (open && published && (stale || (!schemaLoaded && !schemaPending))) {
			void loadSchema();
		}
		if (!open) {
			schemaLoaded = false;
			schemaError = false;
			schemaRows = [];
			schemaCanvasId = null;
			// Bump the generation so any in-flight load is treated as
			// stale on completion (its finally block won't touch
			// schemaPending or schemaLoaded). Then clear schemaPending
			// directly so the next open isn't blocked by the !pending
			// gate. Codex round 2 P2 + round 3 P2.
			schemaPendingGen++;
			schemaPending = false;
		}
	});

	/** Reset and re-run loadSchema, used by the inline ErrorState retry
	 *  button. Clears the loaded flag so the $effect's gate re-arms,
	 *  and clears the error flag so the loading skeleton replaces the
	 *  error surface immediately rather than overlapping. */
	function retryLoadSchema(): void {
		schemaLoaded = false;
		schemaError = false;
		void loadSchema();
	}

	async function loadSchema(): Promise<void> {
		schemaPending = true;
		schemaError = false;
		// Bump + capture the generation token so a stale completion can't
		// clear the pending flag for a newer in-flight request, and so
		// a stale response can't overwrite freshly-loaded rows. Codex
		// round 3 P2.
		const requestGen = ++schemaPendingGen;
		// Snapshot the canvasId at request start. By the time the response
		// lands the parent may have switched canvases — assigning A's
		// schemaRows on canvas B's open modal would be a stale-write bug.
		const requestCanvasId = canvasId;
		const isStale = () => requestGen !== schemaPendingGen || requestCanvasId !== canvasId;
		try {
			const res = await fetch(`/api/canvas/${canvasId}/params`);
			if (isStale()) return;
			if (res.ok) {
				const rows = (await res.json()) as SchemaRow[];
				if (isStale()) return;
				schemaRows = rows;
				schemaCanvasId = requestCanvasId;
			} else {
				// Surface non-OK responses (5xx, 4xx) via the visible
				// ErrorState retry surface (TASK-136). The previous
				// behavior was a silent fail with the type/required
				// cells stuck in their default-disabled state. Stale-
				// guarded so a late completion from a prior canvas /
				// session can't paint a false error on the current
				// panel (Codex round 1 P2).
				schemaError = true;
			}
		} catch {
			// Network rejections take the same retryable path. Same
			// stale guard applies — a stale rejection must not paint
			// an error on a newer in-flight request (Codex round 1).
			if (!isStale()) {
				schemaError = true;
			}
		} finally {
			// Only the LATEST request's generation may clear `schemaPending`
			// or flip `schemaLoaded` — a stale completion that lost the
			// race must remain a no-op so the still-in-flight newer
			// request keeps the effect's guard armed. Codex round 3 P2.
			if (requestGen === schemaPendingGen) {
				schemaPending = false;
				if (requestCanvasId === canvasId) {
					schemaLoaded = true;
				}
			}
		}
	}

	/** Per-row PATCH for type / required, mirroring PublishModal's
	 *  persistParamFlags. Optimistic in-memory update first so the cell
	 *  feels responsive; the request is one-shot (single-row params
	 *  array) so simultaneous edits across rows don't collide. */
	async function persistFlag(name: string, patch: Partial<SchemaRow>): Promise<void> {
		schemaRows = schemaRows.map((r) => (r.name === name ? { ...r, ...patch } : r));
		try {
			const res = await fetch(`/api/canvas/${canvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ params: [{ name, ...patch }] })
			});
			if (!res.ok) {
				toast.error(`Couldn't save params for ${name}.`);
			}
		} catch {
			toast.error(`Couldn't save params for ${name}.`);
		}
	}

	/** Update the binding default for `name` across every layer that
	 *  references it. We can't use a single setProp call because the
	 *  param name is shared — multiple layers may have bindings on
	 *  different properties (e.g. a Title text layer bound on `text`
	 *  and a Header badge layer bound on `label`, both referencing the
	 *  same `?title=` URL param). Walking the canvas keeps both in
	 *  lockstep so the renderer sees a consistent default everywhere.
	 *
	 *  Mutates the binding objects in place via `obj.set(...)` so the
	 *  same propertiesToInclude / autosave / undo machinery PropertyPanel
	 *  uses kicks in (markDirty triggers the autosave debouncer). */
	function updateDefault(name: string, newDefault: string): void {
		const canvas = editorState.fabricCanvas;
		if (!canvas) return;
		let updatedAny = false;
		for (const obj of canvas.getObjects()) {
			const bindings = (
				obj as FabricObject & {
					paramBindings?: Record<string, { param: string; default: string; format?: string }>;
				}
			).paramBindings;
			if (!bindings) continue;
			const next: Record<string, { param: string; default: string; format?: string }> = {};
			let modified = false;
			for (const [property, b] of Object.entries(bindings)) {
				if (b.param === name) {
					next[property] = { ...b, default: newDefault };
					modified = true;
				} else {
					next[property] = b;
				}
			}
			if (modified) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(obj as any).set('paramBindings', next);
				updatedAny = true;
			}
		}
		if (updatedAny) {
			canvas.renderAll();
			markDirty();
		}
	}

	function findRow(name: string): SchemaRow | undefined {
		return schemaRows.find((r) => r.name === name);
	}
</script>

<Modal {open} {onClose} title="Dynamic values" width="48rem">
	<div class="params-intro">
		<p>
			Dynamic values this canvas accepts. Edit the default to change what renders when a viewer
			omits the value. Type and Required apply once the canvas is published — they show up in the
			API docs and gate strict-mode renders.
		</p>
		{#if !published}
			<p class="params-unpublished-note">
				Type and Required become editable once the canvas is published. Defaults are editable now.
			</p>
		{/if}
	</div>

	{#if published && schemaError}
		<!--
			Server-side schema fetch failed (5xx, network error, etc.).
			ErrorState keeps the user in the modal with a retry instead
			of silently leaving the type/required cells disabled.
			Derived params from the live canvas are still shown below.
		-->
		<div class="params-error" data-testid="params-schema-error">
			<ErrorState
				title="Couldn't load saved type / required"
				message="The saved settings for this canvas didn't load. The dynamic values below still work, but Type and Required can't be edited until they reach the editor."
				onRetry={retryLoadSchema}
			/>
		</div>
	{:else if published && !schemaLoaded}
		<!--
			Loading skeleton matches the params-row grid layout so the
			table chrome doesn't shift when real rows render.
		-->
		<div class="params-skeleton" data-testid="params-skeleton" aria-label="Loading parameters">
			<LoadingSkeleton lines={3} />
		</div>
	{/if}

	{#if derivedParams.length === 0}
		<div class="params-empty" data-testid="params-empty">
			<EmptyState
				icon={Sliders}
				title="No dynamic values yet"
				description="Make a property dynamic from the property panel — each dynamic property becomes a URL value the viewer can override via the share URL."
			/>
		</div>
	{:else}
		<div class="params-table" role="table" aria-label="What this canvas accepts">
			<div class="params-row params-row-header" role="row">
				<span role="columnheader">Name</span>
				<span role="columnheader">Type</span>
				<span role="columnheader">Default</span>
				<span role="columnheader">Required</span>
				<span role="columnheader">Sources</span>
			</div>
			{#each derivedParams as p (p.name)}
				{@const row = findRow(p.name)}
				<div class="params-row" role="row" data-testid="params-row-{p.name}">
					<div class="params-cell params-cell-name" role="cell">
						<code>{p.name}</code>
						{#if p.formatter}
							<span class="params-formatter" title="Formatted before rendering">
								{p.formatter}
							</span>
						{/if}
					</div>

					<div class="params-cell" role="cell">
						<select
							class="params-input"
							value={row?.type ?? 'text'}
							disabled={!published || !row}
							aria-label="Type for {p.name}"
							onchange={(e) => persistFlag(p.name, { type: e.currentTarget.value })}
						>
							<option value="text">text</option>
							<option value="number">number</option>
							<option value="url">url</option>
							<option value="boolean">boolean</option>
							<option value="date">date</option>
						</select>
					</div>

					<div class="params-cell" role="cell">
						<input
							class="params-input"
							type="text"
							value={p.default}
							placeholder="(empty)"
							aria-label="Default for {p.name}"
							oninput={(e) => updateDefault(p.name, e.currentTarget.value)}
						/>
					</div>

					<div class="params-cell params-cell-checkbox" role="cell">
						<input
							type="checkbox"
							checked={row?.required ?? false}
							disabled={!published || !row}
							aria-label="Required {p.name}"
							onchange={(e) => persistFlag(p.name, { required: e.currentTarget.checked })}
						/>
					</div>

					<div class="params-cell params-cell-sources" role="cell">
						{#if p.sources.length === 0}
							<span class="params-sources-empty">none</span>
						{:else}
							<ul class="params-sources">
								{#each p.sources as s, i (i)}
									<li>
										<span class="params-source-layer">{s.layerLabel}</span>
										<span class="params-source-arrow" aria-hidden="true">·</span>
										<span class="params-source-prop">{labelForProperty(s.property)}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</Modal>

<style>
	.params-intro {
		margin-bottom: 1rem;
		font-size: 0.875rem;
		color: var(--color-text-muted);
		line-height: 1.5;
	}

	.params-intro p {
		margin: 0 0 0.5rem;
	}

	.params-unpublished-note {
		padding: 0.5rem 0.75rem;
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 4px;
		color: var(--color-warning-text);
		font-size: 0.8125rem;
	}

	/*
	 * Empty / skeleton / error wrappers — the underlying primitives
	 * already supply the visual; we just give them a comfortable
	 * vertical padding inside the modal body. The skeleton wrapper
	 * mirrors the table area's padding so the loading height feels
	 * close to the eventual real content.
	 */
	.params-empty {
		padding: var(--spacing-4) 0;
	}

	.params-skeleton {
		padding: var(--spacing-3) var(--spacing-2) var(--spacing-4);
	}

	.params-error {
		padding: var(--spacing-2) 0 var(--spacing-4);
	}

	.params-table {
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: var(--color-border);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		overflow: hidden;
	}

	.params-row {
		display: grid;
		grid-template-columns: minmax(120px, 1.4fr) 90px minmax(120px, 1.4fr) 80px minmax(140px, 1.6fr);
		gap: 0;
		background: var(--color-bg);
		align-items: center;
	}

	.params-row-header {
		background: var(--color-surface-muted);
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-subtle);
	}

	.params-row-header span {
		padding: 0.5rem 0.75rem;
	}

	.params-cell {
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
		color: var(--color-text);
		min-width: 0;
	}

	.params-cell-name code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8125rem;
		color: var(--color-text);
		background: var(--color-surface-muted);
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
	}

	.params-formatter {
		display: inline-block;
		margin-left: 0.5rem;
		padding: 0.0625rem 0.375rem;
		font-size: 0.6875rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: var(--color-primary-surface);
		color: var(--color-primary-hover);
		border-radius: 999px;
	}

	.params-input {
		width: 100%;
		min-width: 0;
		padding: 0.25rem 0.5rem;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		font-family: inherit;
		font-size: 0.8125rem;
		background: var(--color-bg);
	}

	.params-input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
	}

	.params-input:disabled {
		background: var(--color-surface-muted);
		color: var(--color-text-subtle);
		cursor: not-allowed;
	}

	.params-cell-checkbox {
		display: flex;
		justify-content: center;
	}

	.params-cell-checkbox input[type='checkbox'] {
		width: 16px;
		height: 16px;
		cursor: pointer;
	}

	.params-cell-checkbox input[type='checkbox']:disabled {
		cursor: not-allowed;
	}

	.params-cell-sources {
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.params-sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.params-sources li {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	.params-source-layer {
		font-weight: 500;
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.params-source-arrow {
		color: var(--color-text-subtle);
	}

	.params-source-prop {
		color: var(--color-text-subtle);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.params-sources-empty {
		color: var(--color-text-subtle);
		font-style: italic;
	}
</style>
