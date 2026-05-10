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
	import { Modal } from '$lib/components/ui';
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
	/** Tracks an in-flight GET so a parent re-render doesn't fire a
	 *  second load while the first is still landing. Without this, the
	 *  second response could overwrite the first's freshly-edited rows
	 *  if it took longer to return. */
	let schemaPending = $state(false);
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
			schemaRows = [];
			schemaCanvasId = null;
			// Also clear the in-flight flag so a navigation that closes
			// the modal mid-fetch doesn't strand `schemaPending=true` —
			// otherwise the next open would skip the load (the effect's
			// guard checks !schemaPending) and the panel would render
			// type/required cells permanently disabled. Codex round 2 P2.
			schemaPending = false;
		}
	});

	async function loadSchema(): Promise<void> {
		schemaPending = true;
		// Snapshot the canvasId at request start. By the time the response
		// lands the parent may have switched canvases — assigning A's
		// schemaRows on canvas B's open modal would be a stale-write bug.
		const requestCanvasId = canvasId;
		try {
			const res = await fetch(`/api/canvas/${canvasId}/params`);
			if (requestCanvasId !== canvasId) return;
			if (res.ok) {
				const rows = (await res.json()) as SchemaRow[];
				if (requestCanvasId !== canvasId) return;
				schemaRows = rows;
				schemaCanvasId = requestCanvasId;
			}
			// Even on a non-OK response we flip schemaLoaded below so the
			// effect doesn't refire in a tight retry loop. The user can
			// close+reopen the modal (which resets schemaLoaded) to retry,
			// matching the rest-of-app pattern (PublishModal sharing).
			// Codex round 1 P2.
		} catch {
			// Best-effort: a transient network failure leaves the type/
			// required cells in their default-disabled state. See above
			// re. retry mechanics.
		} finally {
			// schemaPending is purely a debounce — clear it unconditionally
			// when this request settles so a stale (canvas-switched)
			// completion doesn't leave a future open hanging. The
			// schemaLoaded gate stays canvasId-matched so we never mark
			// "loaded" against the wrong canvas's data.
			schemaPending = false;
			if (requestCanvasId === canvasId) {
				schemaLoaded = true;
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

<Modal {open} {onClose} title="Parameters" width="48rem">
	<div class="params-intro">
		<p>
			All URL parameters used by this canvas. Edit the default to change what renders when a viewer
			omits the parameter. Type and Required apply once the canvas is published — they show up in
			the API docs and gate strict-mode renders.
		</p>
		{#if !published}
			<p class="params-unpublished-note">
				Type and Required become editable once the canvas is published. Defaults and bindings are
				editable now.
			</p>
		{/if}
	</div>

	{#if derivedParams.length === 0}
		<div class="params-empty" data-testid="params-empty">
			<p>No URL parameters yet.</p>
			<p class="params-empty-hint">
				Bind a property in the property panel to add one — every binding becomes a parameter the
				viewer can override via the share URL.
			</p>
		</div>
	{:else}
		<div class="params-table" role="table" aria-label="Canvas parameter schema">
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
							<span class="params-formatter" title="Formatter applied at render">
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
		color: #4b5563;
		line-height: 1.5;
	}

	.params-intro p {
		margin: 0 0 0.5rem;
	}

	.params-unpublished-note {
		padding: 0.5rem 0.75rem;
		background: #fef3c7;
		border: 1px solid #fde68a;
		border-radius: 4px;
		color: #78350f;
		font-size: 0.8125rem;
	}

	.params-empty {
		padding: 1.5rem 1rem;
		background: #f9fafb;
		border: 1px dashed #d1d5db;
		border-radius: 6px;
		text-align: center;
		color: #6b7280;
	}

	.params-empty p {
		margin: 0;
		font-size: 0.875rem;
	}

	.params-empty-hint {
		margin-top: 0.25rem;
		font-size: 0.8125rem;
		color: #9ca3af;
	}

	.params-table {
		display: flex;
		flex-direction: column;
		gap: 1px;
		background: #e5e7eb;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		overflow: hidden;
	}

	.params-row {
		display: grid;
		grid-template-columns: minmax(120px, 1.4fr) 90px minmax(120px, 1.4fr) 80px minmax(140px, 1.6fr);
		gap: 0;
		background: #fff;
		align-items: center;
	}

	.params-row-header {
		background: #f9fafb;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #6b7280;
	}

	.params-row-header span {
		padding: 0.5rem 0.75rem;
	}

	.params-cell {
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
		color: #111827;
		min-width: 0;
	}

	.params-cell-name code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8125rem;
		color: #1f2937;
		background: #f3f4f6;
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
	}

	.params-formatter {
		display: inline-block;
		margin-left: 0.5rem;
		padding: 0.0625rem 0.375rem;
		font-size: 0.6875rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: #dbeafe;
		color: #1e3a8a;
		border-radius: 999px;
	}

	.params-input {
		width: 100%;
		min-width: 0;
		padding: 0.25rem 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-family: inherit;
		font-size: 0.8125rem;
		background: #fff;
	}

	.params-input:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
	}

	.params-input:disabled {
		background: #f3f4f6;
		color: #9ca3af;
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
		color: #4b5563;
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
		color: #111827;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.params-source-arrow {
		color: #9ca3af;
	}

	.params-source-prop {
		color: #6b7280;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.params-sources-empty {
		color: #9ca3af;
		font-style: italic;
	}
</style>
