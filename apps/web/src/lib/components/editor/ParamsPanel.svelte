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
	 *     `updateDefault`) so the editor's preview reflects the change
	 *     immediately, identical to the per-property bind editor (TASK-104).
	 *     Persistence is manual — the user hits Save when ready (BT-160).
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
	import { Modal, EmptyState } from '$lib/components/ui';
	import { Sliders } from '@lucide/svelte';
	import { editorState, markDirty } from './state.svelte.ts';
	import type { FabricObject } from 'fabric';
	import ParamSchemaEditor from './publish/ParamSchemaEditor.svelte';
	import type { PublishModalBinding } from './PublishModal.svelte';

	/** Param schema row as returned by GET /api/canvas/[id]/params and
	 *  accepted by the PATCH /api/canvas/[id] body's `params: [...]`.
	 *  Re-exported as a type from the editor-page state owner; the
	 *  shape lives here so callers don't need to import from
	 *  +page.svelte. */
	export interface SchemaRow {
		name: string;
		type: string;
		required: boolean;
	}

	interface Props {
		open: boolean;
		canvasId: string;
		published: boolean;
		/** Page-level paramRows source (PLAN-232 Phase C / TASK-245).
		 *  Loading + persistence both live at the editor-page layer; the
		 *  panel just renders the data and delegates writes via
		 *  `onPersistFlag` / `onRetryLoad`. */
		paramRows: SchemaRow[];
		paramRowsLoaded: boolean;
		paramRowsError: boolean;
		onPersistFlag: (name: string, patch: Partial<SchemaRow>) => void;
		onRetryLoad: () => void;
		onClose: () => void;
	}
	let {
		open,
		published,
		paramRows,
		paramRowsLoaded,
		paramRowsError,
		onPersistFlag,
		onRetryLoad,
		onClose
	}: Props = $props();

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
		if (!open) {
			// Reset the panel mode so the next open lands on the
			// default Test-values view. Without this a user who flipped
			// to Schema and closed the panel would re-open on the
			// placeholder with the params table hidden. Codex round 1
			// P2 of TASK-243.
			mode = 'test';
		}
	});

	// paramRows fetching + persistence moved up to editor-page state in
	// TASK-245 (PLAN-232 Phase C exit criteria — "paramRows has one
	// owner"). The panel reads them via props and routes writes through
	// `onPersistFlag` + `onRetryLoad`.

	/** Update the binding default for `name` across every layer that
	 *  references it. We can't use a single setProp call because the
	 *  param name is shared — multiple layers may have bindings on
	 *  different properties (e.g. a Title text layer bound on `text`
	 *  and a Header badge layer bound on `label`, both referencing the
	 *  same `?title=` URL param). Walking the canvas keeps both in
	 *  lockstep so the renderer sees a consistent default everywhere.
	 *
	 *  Mutates the binding objects in place via `obj.set(...)` so the
	 *  same propertiesToInclude / serialize / undo machinery PropertyPanel
	 *  uses kicks in (markDirty flips the Save button into the 'dirty'
	 *  state — saves are manual per BT-160). */
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

	/** Shape-adapter — <ParamSchemaEditor> consumes the
	 *  PublishModalBinding type ({ name, default, sourceLabel }) inherited
	 *  from when it lived under PublishModal. ParamsPanel's
	 *  `derivedParams` carries richer source metadata (multiple layers
	 *  per param + formatter); we collapse to the first source's
	 *  property label so the editor's title="from {sourceLabel}" hover
	 *  still gives the user something useful. Editing UX is identical
	 *  to the inline cells the Test-values mode used to render. */
	let schemaEditorBindings = $derived<PublishModalBinding[]>(
		derivedParams.map((p) => ({
			name: p.name,
			default: p.default,
			sourceLabel: p.sources[0] ? labelForProperty(p.sources[0].property) : 'Dynamic value'
		}))
	);

	/** Two-mode panel (PLAN-232 Phase C / TASK-243).
	 *
	 *  - `test`: the current behavior — defaults are editable, plus
	 *    Type/Required cells inline for power-users who don't want to
	 *    flip modes. This is the entry-point mode so existing flows
	 *    keep working.
	 *  - `schema`: dedicated home for the schema editor. TASK-244 mounts
	 *    <ParamSchemaEditor> here and removes the duplicate from
	 *    PublishModal.
	 *
	 *  The mode is component-local — closing and reopening resets to
	 *  'test'. Persistence would be nice but isn't worth the
	 *  cross-session-restore complexity for a v1 segmented control.
	 */
	type ParamsPanelMode = 'test' | 'schema';
	let mode = $state<ParamsPanelMode>('test');

	/** ARIA tablist keyboard nav. Standard WAI pattern: arrow keys
	 *  cycle (with wrap), Home/End jump to ends. Mirrors the embed
	 *  drawer's onTabKeydown so the two surfaces feel identical. */
	const MODES: { id: ParamsPanelMode; label: string }[] = [
		{ id: 'test', label: 'Test values' },
		{ id: 'schema', label: 'Schema' }
	];

	function onModeKeydown(event: KeyboardEvent, currentId: ParamsPanelMode) {
		const idx = MODES.findIndex((m) => m.id === currentId);
		if (idx === -1) return;
		let nextIdx: number | null = null;
		if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + MODES.length) % MODES.length;
		else if (event.key === 'ArrowRight') nextIdx = (idx + 1) % MODES.length;
		else if (event.key === 'Home') nextIdx = 0;
		else if (event.key === 'End') nextIdx = MODES.length - 1;
		if (nextIdx === null) return;
		event.preventDefault();
		const nextMode = MODES[nextIdx];
		mode = nextMode.id;
		queueMicrotask(() => {
			const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
			const tablist = root?.closest('[role="tablist"]');
			const btn = tablist?.querySelector<HTMLButtonElement>(
				`[data-testid="params-mode-${nextMode.id}"]`
			);
			btn?.focus();
		});
	}
</script>

<Modal {open} {onClose} title="Dynamic values" width="48rem">
	<div class="params-intro">
		<p>
			Dynamic values this canvas accepts. The <strong>Test values</strong> tab is for editing
			defaults and seeing which layers reference each value. The <strong>Schema</strong> tab edits Type
			+ Required — they apply once the canvas is published and gate strict-mode renders.
		</p>
		{#if !published}
			<p class="params-unpublished-note">
				Type and Required (Schema tab) become editable once the canvas is published. Defaults are
				editable now.
			</p>
		{/if}
	</div>

	<!--
		Test / Schema mode toggle (PLAN-232 Phase C / TASK-243). Drives
		a tabpanel split so the "what does this canvas accept" surface
		hosts both the test-driving controls (Test values) and the
		dedicated schema editor (Schema, populated in TASK-244).
	-->
	<div
		class="params-modes"
		role="tablist"
		aria-label="Params panel mode"
		aria-orientation="horizontal"
	>
		{#each MODES as m (m.id)}
			<button
				type="button"
				role="tab"
				class="params-mode"
				class:active={mode === m.id}
				aria-selected={mode === m.id}
				aria-controls="params-mode-panel"
				tabindex={mode === m.id ? 0 : -1}
				data-testid="params-mode-{m.id}"
				onclick={() => (mode = m.id)}
				onkeydown={(e) => onModeKeydown(e, m.id)}
			>
				{m.label}
			</button>
		{/each}
	</div>

	<div id="params-mode-panel" role="tabpanel" data-testid="params-mode-panel-{mode}">
		{#if mode === 'test'}
			<!--
				Test-values mode shows Name + Default + Sources. The
				ErrorState / loading-skeleton for the schema fetch
				lives in the Schema tab (where the failure actually
				matters); Test mode is purely client-side so it has
				nothing to load.
			-->
			{#if derivedParams.length === 0}
				<div class="params-empty" data-testid="params-empty">
					<EmptyState
						icon={Sliders}
						title="No dynamic values yet"
						description="Make a property dynamic from the property panel — each dynamic property becomes a URL value the viewer can override via the share URL."
					/>
				</div>
			{:else}
				<!--
					Test mode (TASK-244): Name + Default + Sources. Type
					and Required moved to the Schema tab — having them
					inline duplicated the schema editor's controls + caused
					the cross-surface aria-label collision that broke the
					params-validation e2e. Schema editing now has one
					home; Test mode is focused on driving the live preview.
				-->
				<div class="params-table" role="table" aria-label="What this canvas accepts">
					<div class="params-row params-row-header" role="row">
						<span role="columnheader">Name</span>
						<span role="columnheader">Default</span>
						<span role="columnheader">Sources</span>
					</div>
					{#each derivedParams as p (p.name)}
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
								<input
									class="params-input"
									type="text"
									value={p.default}
									placeholder="(empty)"
									aria-label="Default for {p.name}"
									oninput={(e) => updateDefault(p.name, e.currentTarget.value)}
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
		{:else}
			<!--
				Schema mode (TASK-244). Hosts <ParamSchemaEditor> — the
				same component PublishModal used to render. Schema rows
				only exist server-side for PUBLISHED canvases
				(syncCanvasParams runs on the publish PATCH; unpublished
				canvases never roundtrip). Pass `paramRowsLoaded=true`
				on unpublished so the editor renders its empty-state
				with disabled controls instead of an indefinite loading
				skeleton — the editor's own `disabled={!row}` check
				keeps the Type/Required cells un-editable until a row
				lands. Codex round 1 P2 of TASK-244.
			-->
			<ParamSchemaEditor
				bindings={schemaEditorBindings}
				{paramRows}
				paramRowsLoaded={!published || paramRowsLoaded}
				{paramRowsError}
				onPersist={onPersistFlag}
				onRetry={onRetryLoad}
			/>
		{/if}
	</div>
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

	/* Test / Schema mode toggle (TASK-243). Visual treatment matches
	   the embed drawer's tablist so the two surfaces feel identical. */
	.params-modes {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
		margin: 0 0 1rem;
		border-bottom: 1px solid var(--color-border);
	}

	.params-mode {
		padding: 0.4rem 0.75rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-text-subtle);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.params-mode:hover {
		color: var(--color-text);
	}

	.params-mode.active {
		color: var(--color-text);
		border-bottom-color: var(--color-text);
		font-weight: 600;
	}

	.params-mode:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: -2px;
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

	/* .params-skeleton + .params-error were specific to the in-panel
	   schema fetch state. After TASK-245 the fetch lives at editor-page
	   state and the corresponding loading/error UX is part of
	   <ParamSchemaEditor> in the Schema tab. */

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
		grid-template-columns: minmax(120px, 1.4fr) minmax(140px, 1.6fr) minmax(140px, 1.6fr);
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

	/* .params-cell-checkbox (Required checkbox) moved out with the
	   schema editor in TASK-244 — Test mode no longer renders it. */

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
