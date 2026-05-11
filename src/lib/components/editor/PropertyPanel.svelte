<script lang="ts">
	import type { FabricObject } from 'fabric';
	import { ChevronRight, AlignLeft, AlignCenter, AlignRight, Zap } from '@lucide/svelte';
	import { editorState, markDirty } from './state.svelte.ts';
	import { fontStore } from '$lib/stores/fonts.svelte';
	import { paramRefStatus } from './param-validation';

	// --- Derived properties from the selected object ---
	// editorState.editGeneration is read to force re-derivation when Fabric mutates
	// objects in place (the editorState.selectedObject reference doesn't change).

	function getObjProp<T>(prop: string, fallback: T): T {
		void editorState.editGeneration; // reactive dependency
		return (editorState.selectedObject?.get(prop) as T) ?? fallback;
	}

	let objType = $derived(
		(void editorState.editGeneration, editorState.selectedObject?.type?.toLowerCase() ?? '')
	);
	let isText = $derived(
		objType === 'i-text' || objType === 'itext' || objType === 'textbox' || objType === 'text'
	);
	let isImage = $derived(objType === 'image' || objType === 'fabricimage');
	// Badge primitive (TASK-87). Fabric stores `type` as the registered
	// class identifier — Badge registers itself as 'Badge', which lowercases
	// to 'badge' through the same code path the existing isText/isImage
	// checks use.
	let isBadge = $derived(objType === 'badge');

	// Position (scale-aware: displayed dimensions = intrinsic × scale)
	let posX = $derived(getObjProp<number>('left', 0));
	let posY = $derived(getObjProp<number>('top', 0));
	let scaleX = $derived(getObjProp<number>('scaleX', 1));
	let scaleY = $derived(getObjProp<number>('scaleY', 1));
	let objWidth = $derived(getObjProp<number>('width', 0) * scaleX);
	let objHeight = $derived(getObjProp<number>('height', 0) * scaleY);
	let angle = $derived(getObjProp<number>('angle', 0));
	let opacity = $derived(getObjProp<number>('opacity', 1));
	// Visibility (TASK-104) — surfaced as a checkbox in the Position section
	// so the inline ⚡ Make-dynamic affordance has a concrete row to attach
	// to. Default true matches Fabric's behavior when `visible` is unset.
	let visible = $derived(getObjProp<boolean>('visible', true));

	// Text
	let text = $derived(getObjProp<string>('text', ''));
	let fontFamily = $derived(getObjProp<string>('fontFamily', 'Inter'));
	let fontSize = $derived(getObjProp<number>('fontSize', 24));
	let fontWeight = $derived(getObjProp<number>('fontWeight', 400));
	let fill = $derived(getObjProp<string>('fill', '#000000'));
	let textAlign = $derived(getObjProp<string>('textAlign', 'left'));

	// Image
	let imageSrc = $derived(
		(void editorState.editGeneration,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		isImage ? ((editorState.selectedObject as any)?.getSrc?.() ?? '') : '')
	);
	// Per-layer image fallback (TASK-86). Stored as a custom Fabric property
	// so it's picked up by the same `propertiesToInclude` list as paramBindings
	// / conditionalStyles when the canvas is serialized (history, autosave,
	// duplicate). The renderer uses it when the primary `src` fails to fetch.
	let fallbackSrc = $derived(getObjProp<string>('fallbackSrc', ''));

	// Asset-library link (TASK-116). When the user picks from the library,
	// the editor stamps the asset id on the layer so save-time translation
	// can rewrite `src` → `asset://{id}`. The pill below surfaces this so
	// the user can see they're linked, and the Unlink button detaches.
	let srcAssetId = $derived(getObjProp<string | undefined>('srcAssetId', undefined));

	// Badge primitive (TASK-87). Mirrors the Badge class fields. The pill's
	// background color reuses the standard `fill` property so the existing
	// param-binding / conditional pipelines drive the bg color naturally.
	let badgeLabel = $derived(getObjProp<string>('label', ''));
	let badgeFg = $derived(getObjProp<string>('fg', '#ffffff'));
	let badgePadding = $derived(getObjProp<number>('padding', 10));
	let badgeRadius = $derived(getObjProp<number | undefined>('radius', undefined));
	let badgeIcon = $derived(getObjProp<string>('iconImage', ''));
	let badgeIconPos = $derived(getObjProp<'left' | 'right'>('iconPosition', 'left'));

	// Parameter bindings
	let paramBindings: Record<string, { param: string; default: string; format?: string }> = $derived(
		getObjProp<Record<string, { param: string; default: string; format?: string }>>(
			'paramBindings',
			{}
		)
	);

	/** Canvas-wide set of parameter names known to be bound somewhere
	 *  (TASK-106). Drives the conditional-rule typo validator: a rule
	 *  referencing `gainPct` when the canvas binds `gainPercent`
	 *  silently no-ops at render time, so we surface the typo at design
	 *  time with a suggested correction. Walks every object's
	 *  paramBindings, not just the selected one — a rule on layer A
	 *  legitimately references a param bound on layer B. */
	let canvasParamNames = $derived.by<string[]>(() => {
		void editorState.editGeneration;
		const canvas = editorState.fabricCanvas;
		if (!canvas) return [];
		// Plain object as a dedup index. `new Set()` would trip the
		// `svelte/prefer-svelte-reactivity` lint rule even though the
		// derivation doesn't need reactive Set semantics — the whole
		// array is recomputed on editGeneration ticks.
		const seen: Record<string, true> = Object.create(null);
		const order: string[] = [];
		for (const obj of canvas.getObjects()) {
			const bindings = (
				obj as typeof obj & {
					paramBindings?: Record<string, { param: string; default: string; format?: string }>;
				}
			).paramBindings;
			if (!bindings) continue;
			for (const b of Object.values(bindings)) {
				if (b?.param && !seen[b.param]) {
					seen[b.param] = true;
					order.push(b.param);
				}
			}
		}
		return order;
	});

	// TASK-104: which property's inline bind editor is currently open. Only
	// one editor is expanded at a time so the panel stays compact. `null`
	// means no inline editor is open. Reset on selection change so a stale
	// editor for the previous object doesn't carry over.
	let bindEditingProp = $state<string | null>(null);
	$effect(() => {
		void editorState.selectedObject;
		bindEditingProp = null;
	});
	// Position is collapsed by default because most edits (text content,
	// fill color, image src) happen far more often than pixel-exact X/Y/W/H
	// tweaks — users who want that control expand the section on demand.
	let positionExpanded = $state(false);
	let conditionalsExpanded = $state(false);

	// --- Conditional style rules (TASK-50) ---
	type ConditionalOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains';
	type ConditionalProperty = 'fill' | 'opacity' | 'visible';
	interface ConditionalRule {
		when: { param: string; op: ConditionalOp; value: string };
		then: { property: ConditionalProperty; value: string };
	}
	let conditionalStyles: ConditionalRule[] = $derived(
		getObjProp<ConditionalRule[]>('conditionalStyles', [])
	);

	function setRules(next: ConditionalRule[]) {
		setProp('conditionalStyles', next);
	}

	function addRule() {
		const next = [...conditionalStyles];
		next.push({
			when: { param: '', op: '<', value: '0' },
			then: { property: 'fill', value: 'var(--color-danger)' }
		});
		setRules(next);
	}

	function removeRule(index: number) {
		setRules(conditionalStyles.filter((_, i) => i !== index));
	}

	/** Default `then.value` for each conditional target property. Used when the
	 *  user switches the target property so the input doesn't carry stale data
	 *  (e.g. `'var(--color-danger)'` left over from a fill rule when switching to opacity).
	 */
	const conditionalPropertyDefaults: Record<ConditionalProperty, string> = {
		fill: 'var(--color-danger)',
		opacity: '0.5',
		visible: 'false'
	};

	function updateRule<K extends 'when' | 'then'>(
		index: number,
		section: K,
		field: K extends 'when' ? keyof ConditionalRule['when'] : keyof ConditionalRule['then'],
		value: string
	) {
		const next = conditionalStyles.map((r, i) => {
			if (i !== index) return r;
			// When the user changes the `then.property` dropdown, the existing
			// `then.value` is almost certainly nonsensical for the new target
			// (a hex color isn't a valid opacity, etc.). Reset to a sensible
			// default for the new property so the corresponding input renders
			// with a valid initial value.
			if (
				section === 'then' &&
				field === 'property' &&
				(value === 'fill' || value === 'opacity' || value === 'visible')
			) {
				const nextProperty = value as ConditionalProperty;
				return {
					...r,
					then: {
						property: nextProperty,
						value: conditionalPropertyDefaults[nextProperty]
					}
				} as ConditionalRule;
			}
			return {
				...r,
				[section]: { ...r[section], [field]: value }
			} as ConditionalRule;
		});
		setRules(next);
	}

	// --- Helpers ---

	function setProp(prop: string, value: unknown) {
		if (!editorState.selectedObject || !editorState.fabricCanvas) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		editorState.selectedObject.set(prop as keyof FabricObject, value as any);
		editorState.selectedObject.setCoords();
		editorState.fabricCanvas.renderAll();
		markDirty();
	}

	/** Map of URL fields → their library-link id stamp (TASK-116). When
	 *  the user edits a URL field directly, the corresponding *AssetId
	 *  must be cleared — otherwise the save serializer would rewrite the
	 *  user's manually-edited URL back to `asset://{id}` and silently
	 *  discard the change. The Unlink button is the explicit detach for
	 *  the visible primary `src` link; this auto-clear is the implicit
	 *  detach for the URL-edit path. */
	const ASSET_LINK_STAMPS: Record<string, string> = {
		src: 'srcAssetId',
		fallbackSrc: 'fallbackSrcAssetId',
		iconImage: 'iconImageAssetId'
	};

	/** setProp wrapper for URL fields — sets the URL AND clears the
	 *  matching id stamp so a manual edit detaches the layer from the
	 *  asset library. Use for any input that targets src/fallbackSrc/
	 *  iconImage. */
	function setUrlProp(prop: 'src' | 'fallbackSrc' | 'iconImage', value: unknown) {
		const stamp = ASSET_LINK_STAMPS[prop];
		if (stamp && editorState.selectedObject?.get(stamp) !== undefined) {
			setProp(stamp, undefined);
		}
		setProp(prop, value);
	}

	/** Set width/height accounting for scale — resets scale to 1 and sets intrinsic dimension */
	function setDimension(prop: 'width' | 'height', displayValue: number) {
		if (!editorState.selectedObject || !editorState.fabricCanvas) return;
		const scaleProp = prop === 'width' ? 'scaleX' : 'scaleY';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		editorState.selectedObject.set(prop as any, displayValue);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		editorState.selectedObject.set(scaleProp as any, 1);
		editorState.selectedObject.setCoords();
		editorState.fabricCanvas.renderAll();
		markDirty();
	}

	function setBinding(property: string, field: 'param' | 'default' | 'format', value: string) {
		if (!editorState.selectedObject) return;
		const current = { ...paramBindings };
		if (!current[property]) {
			current[property] = { param: '', default: '' };
		}
		const next = { ...current[property], [field]: value };
		// Persist an empty format as undefined so the renderer's formatter
		// fall-through (parseFormat('') → null) is reached cleanly via the
		// type contract instead of an empty-string round-trip.
		if (field === 'format' && !value) {
			delete (next as { format?: string }).format;
		}
		current[property] = next;
		setProp('paramBindings', current);
	}

	function toggleBinding(property: string) {
		if (!editorState.selectedObject) return;
		const current = { ...paramBindings };
		if (current[property]) {
			delete current[property];
		} else {
			current[property] = { param: property, default: '' };
		}
		setProp('paramBindings', current);
	}

	/** Per-bindable-property metadata, keyed by property name. Drives the
	 *  inline ⚡ button labels, URL-preview samples, and which properties
	 *  expose a string formatter dropdown (TASK-104).
	 *
	 *  `allowFormat` is true only for genuinely text-typed properties whose
	 *  values pass through `applyFormat` in the renderer's `mergeParams`
	 *  pipeline — numeric/boolean props skip the formatter, and URL/color
	 *  string props (`src`, `fill`, `iconImage`, `fg`) technically run
	 *  through it but no formatter in the supported set produces sensible
	 *  output for them, so we hide the dropdown to avoid foot-guns.
	 *
	 *  Sample values are chosen so the binding's URL preview renders a
	 *  realistic example: a number-shaped sample for numeric props so the
	 *  user immediately sees how the URL would look, a hex string for
	 *  colors, and a literal `true` for the boolean. */
	type BindableMeta = { key: string; label: string; sample: string; allowFormat: boolean };
	const ALL_BINDABLE_META: Record<string, BindableMeta> = {
		text: { key: 'text', label: 'Text Content', sample: 'Hello', allowFormat: true },
		fontSize: { key: 'fontSize', label: 'Font Size', sample: '32', allowFormat: false },
		fill: { key: 'fill', label: 'Fill Color', sample: '#ff0000', allowFormat: false },
		src: {
			key: 'src',
			label: 'Image Source',
			sample: 'https://example.com/pic.png',
			allowFormat: false
		},
		// Badge (TASK-87) bindable fields. Background uses the shared `fill`
		// entry above; only the badge-specific properties live here.
		label: { key: 'label', label: 'Badge Label', sample: 'Live', allowFormat: true },
		iconImage: {
			key: 'iconImage',
			label: 'Badge Icon',
			sample: 'https://example.com/icon.png',
			allowFormat: false
		},
		fg: { key: 'fg', label: 'Badge Foreground', sample: '#ffffff', allowFormat: false },
		// Layout / shared. Visibility (TASK-51) accepts lenient boolean
		// coercion at render time (true/1/yes/on vs false/0/no/off/'').
		opacity: { key: 'opacity', label: 'Opacity', sample: '0.5', allowFormat: false },
		visible: { key: 'visible', label: 'Visibility', sample: 'true', allowFormat: false },
		left: { key: 'left', label: 'Position X', sample: '100', allowFormat: false },
		top: { key: 'top', label: 'Position Y', sample: '100', allowFormat: false },
		width: { key: 'width', label: 'Width', sample: '200', allowFormat: false },
		height: { key: 'height', label: 'Height', sample: '200', allowFormat: false }
	};

	function metaFor(propKey: string): BindableMeta {
		return (
			ALL_BINDABLE_META[propKey] ?? {
				key: propKey,
				label: propKey,
				sample: '',
				allowFormat: false
			}
		);
	}

	/** Properties that live inside the collapsed Position section. Used by
	 *  `openBindEditor` so jumping to one of them via the Bound-Parameters
	 *  summary auto-expands the section — without this, the inline editor
	 *  opens but the user can't see it because the parent section is
	 *  collapsed. */
	function isPositionProp(prop: string): boolean {
		return (
			prop === 'left' ||
			prop === 'top' ||
			prop === 'width' ||
			prop === 'height' ||
			prop === 'opacity' ||
			prop === 'visible'
		);
	}

	/** Toggle the inline bind editor for `propKey`. If the property is not
	 *  yet bound, creates a stub binding (`{ param: propKey, default: '' }`)
	 *  via the existing `toggleBinding` helper so the renderer + preview
	 *  pick it up immediately and the user can rename in-place.
	 *
	 *  For `width` / `height` bindings we additionally normalize the
	 *  layer's `scaleX` / `scaleY` to 1 — Fabric stores both intrinsic
	 *  dimensions AND scale, and the renderer's `mergeParams` only
	 *  rewrites the intrinsic value. Without this normalization, a layer
	 *  resized via the corner handles (scaleX≠1) would render at
	 *  `paramValue × scaleX` instead of `paramValue`, surprising the
	 *  user who set a default of "200" and saw a 400px-wide layer. The
	 *  normalization preserves the current displayed size by stamping
	 *  it onto the intrinsic field via `setDimension`, mirroring what
	 *  the manual W/H input already does. */
	function openBindEditor(propKey: string) {
		if (bindEditingProp === propKey) {
			bindEditingProp = null;
			return;
		}
		if (!editorState.selectedObject) return;
		if (!paramBindings[propKey]) {
			if (propKey === 'width') {
				setDimension('width', Math.round(objWidth));
			} else if (propKey === 'height') {
				setDimension('height', Math.round(objHeight));
			}
			toggleBinding(propKey);
		}
		bindEditingProp = propKey;
		if (isPositionProp(propKey)) {
			positionExpanded = true;
		}
	}

	function closeBindEditor() {
		bindEditingProp = null;
	}

	/** Remove a binding entirely. Closes the inline editor if it was open
	 *  on the unbound property — leaving it open would render an empty
	 *  state since the editor reads from `paramBindings[propKey]`. */
	function unbind(propKey: string) {
		if (!paramBindings[propKey]) return;
		const wasEditing = bindEditingProp === propKey;
		toggleBinding(propKey);
		if (wasEditing) bindEditingProp = null;
	}

	let boundCount = $derived(Object.keys(paramBindings).length);

	/** Param names must be URL-safe identifiers. Browsers tolerate more, but
	 * validating here keeps consumers/devs sane and flags typos early. */
	const VALID_PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
	function paramNameWarning(name: string): string {
		if (!name) return 'Give this parameter a name, e.g. "title".';
		if (!VALID_PARAM_NAME.test(name)) {
			return 'Use letters, numbers, underscores, or dashes. Start with a letter.';
		}
		return '';
	}

	function urlExample(
		paramName: string,
		defaultValue: string,
		sample: string
	): { defaultUrl: string; sampleUrl: string } {
		if (!paramName) {
			return { defaultUrl: '?…', sampleUrl: `?…=${encodeURIComponent(sample)}` };
		}
		// Show the user's default verbatim in the "when param is absent" line.
		// The runtime renderer applies defaults via nullish-merge, so an
		// empty-string default really does blank out the bound property —
		// don't substitute a sample for empty here or the preview lies.
		const defaultUrl = `?${paramName}=${encodeURIComponent(defaultValue)}`;
		// Separate "try a value" line gives authors something concrete to copy
		// without misrepresenting runtime behavior.
		const sampleUrl = `?${paramName}=${encodeURIComponent(sample)}`;
		return { defaultUrl, sampleUrl };
	}
</script>

<!--
	TASK-104: ⚡ Make-dynamic affordance.

	`bindBtn` renders a small ⚡ icon at the end of every bindable property
	row. It's hidden by default and only appears on row hover/focus when
	the property is unbound — that keeps the panel visually quiet for the
	common case (designers tweaking values, not wiring URL params). When
	the property IS bound, the button is always-visible and tinted so the
	user can see at a glance which fields drive the published render.

	`bindEditor` renders the actual param-name / default / format editor
	inline below the property row when `bindEditingProp === propKey`. Only
	one editor is open at a time so the panel doesn't grow without bound;
	clicking ⚡ on a different property closes the previous one.
-->
{#snippet bindBtn(propKey: string)}
	{@const bound = paramBindings[propKey]}
	{@const meta = metaFor(propKey)}
	<button
		type="button"
		class="bind-btn"
		class:bind-btn-bound={!!bound}
		class:bind-btn-editing={bindEditingProp === propKey}
		onclick={() => openBindEditor(propKey)}
		aria-label={bound
			? `Edit URL parameter binding for ${meta.label} (currently ?${bound.param || '(unnamed)'})`
			: `Make ${meta.label} dynamic — bind to a URL parameter`}
		aria-expanded={bindEditingProp === propKey}
		title={bound
			? `Bound to ?${bound.param || '(unnamed)'} — click to edit`
			: 'Make dynamic — bind to a URL parameter'}
		data-testid="bind-btn-{propKey}"
	>
		<Zap size={12} strokeWidth={2.25} />
	</button>
{/snippet}

{#snippet bindEditor(propKey: string)}
	{#if bindEditingProp === propKey}
		{@const bound = paramBindings[propKey]}
		{@const meta = metaFor(propKey)}
		{#if bound}
			{@const warning = paramNameWarning(bound.param)}
			{@const urls = urlExample(bound.param, bound.default, meta.sample)}
			<div class="binding-fields bind-editor-card" data-testid="bind-editor-{propKey}">
				<div class="bind-editor-header">
					<span class="bind-editor-title">Binding · {meta.label}</span>
				</div>
				<div class="field-row">
					<label class="field-label small" for="bind-{propKey}-param">Param name</label>
					<input
						id="bind-{propKey}-param"
						type="text"
						class="field-input"
						class:field-input-warning={!!warning}
						value={bound.param}
						oninput={(e) => setBinding(propKey, 'param', e.currentTarget.value)}
						placeholder="e.g. title, price, userName"
						aria-describedby={warning ? `bind-${propKey}-param-warning` : undefined}
					/>
				</div>
				{#if warning}
					<p id="bind-{propKey}-param-warning" class="binding-warning">
						{warning}
					</p>
				{/if}
				<div class="field-row">
					<label class="field-label small" for="bind-{propKey}-default">Default</label>
					<input
						id="bind-{propKey}-default"
						type="text"
						class="field-input"
						value={bound.default}
						oninput={(e) => setBinding(propKey, 'default', e.currentTarget.value)}
						placeholder="used when URL omits this param"
					/>
				</div>
				{#if meta.allowFormat}
					<!-- Formatters apply only to text-typed properties (text content,
						badge label). Numeric / boolean props skip the formatter at
						render time, and color / URL strings have no formatter that
						makes sense for them. -->
					<div class="field-row">
						<label class="field-label small" for="bind-{propKey}-format">Format</label>
						<select
							id="bind-{propKey}-format"
							class="field-select"
							value={bound.format ?? ''}
							onchange={(e) => setBinding(propKey, 'format', e.currentTarget.value)}
						>
							<option value="">No formatting</option>
							<option value="number">Number (1,234)</option>
							<option value="number:2">Number 2dp (1,234.56)</option>
							<option value="currency:USD">Currency USD ($1,234.56)</option>
							<option value="currency:EUR">Currency EUR (€1,234.56)</option>
							<option value="percent">Percent (12%)</option>
							<option value="percent:1">Percent 1dp (12.3%)</option>
							<option value="signed-percent">Signed % (+12% / −12%)</option>
							<option value="signed-percent:1">Signed % 1dp (+12.3%)</option>
							<option value="compact">Compact (1.2k / 3.4M)</option>
							<option value="compact:2">Compact 2dp (1.23k)</option>
							<option value="crypto-price">Crypto price ($1,234.56 / $0.0001230)</option>
							<option value="crypto-price:6">Crypto price 6 sig ($0.00123456)</option>
							<option value="date:short">Date short (Jan 1, 2026)</option>
							<option value="date:long">Date long (January 1, 2026)</option>
							<option value="date:relative">Date relative (2 days ago)</option>
						</select>
					</div>
					<p class="binding-format-hint">
						Pass a number or ISO date as <code>?{bound.param || 'name'}=…</code>; it's formatted
						before rendering.
					</p>
				{/if}
				<p class="binding-url-preview">
					<span class="url-preview-label">With default:</span>
					<code>{urls.defaultUrl}</code>
				</p>
				<p class="binding-url-preview binding-url-sample">
					<span class="url-preview-label">With a value:</span>
					<code>{urls.sampleUrl}</code>
				</p>
				<div class="bind-editor-actions">
					<button
						type="button"
						class="bind-editor-unbind"
						onclick={() => unbind(propKey)}
						data-testid="bind-editor-unbind-{propKey}"
					>
						Unbind
					</button>
					<button type="button" class="bind-editor-done" onclick={closeBindEditor}> Done </button>
				</div>
			</div>
		{/if}
	{/if}
{/snippet}

<aside class="property-panel">
	{#if !editorState.selectedObject}
		<div class="empty-state">
			<p>No selection</p>
			<span class="hint">Click an object on the canvas to edit its properties</span>
		</div>
	{:else}
		<header class="panel-header">
			<h3>Properties</h3>
			<span class="type-badge">{objType}</span>
		</header>

		<div class="sections">
			<!-- Text Section -->
			{#if isText}
				<section class="section" data-testid="property-section-text">
					<h4 class="section-title">Text</h4>

					<div class="field-row field-col bind-row">
						<div class="bind-row-label-line">
							<label class="field-label" for="prop-text">Content</label>
							{@render bindBtn('text')}
						</div>
						<textarea
							id="prop-text"
							class="field-textarea"
							rows="3"
							value={text}
							oninput={(e) => setProp('text', e.currentTarget.value)}
						></textarea>
					</div>
					{@render bindEditor('text')}

					<div class="field-row">
						<label class="field-label" for="prop-font">Font</label>
						<select
							id="prop-font"
							class="field-select"
							value={fontFamily}
							onchange={(e) => setProp('fontFamily', e.currentTarget.value)}
						>
							{#each fontStore.fonts as font (font.family)}
								<option value={font.family}>
									{font.displayName}{font.source === 'user' ? ' (uploaded)' : ''}
								</option>
							{/each}
							<!-- If the canvas references a custom family that hasn't
								loaded yet (e.g. font asset deleted, network blip),
								keep the value in the dropdown so the user can still
								see what's set rather than the picker silently
								snapping to the first option. -->
							{#if fontFamily && !fontStore.fonts.some((f) => f.family === fontFamily)}
								<option value={fontFamily}>{fontFamily} (missing)</option>
							{/if}
						</select>
					</div>

					<div class="field-row bind-row">
						<label class="field-label" for="prop-fontsize">Size</label>
						<input
							id="prop-fontsize"
							type="number"
							class="field-input"
							min="1"
							value={fontSize}
							onchange={(e) => setProp('fontSize', Number(e.currentTarget.value))}
						/>
						{@render bindBtn('fontSize')}
					</div>
					{@render bindEditor('fontSize')}

					<div class="field-row">
						<label class="field-label" for="prop-fontweight">Weight</label>
						<select
							id="prop-fontweight"
							class="field-select"
							value={String(fontWeight)}
							onchange={(e) => setProp('fontWeight', Number(e.currentTarget.value))}
						>
							<option value="400">Normal</option>
							<option value="700">Bold</option>
						</select>
					</div>

					<div class="field-row bind-row">
						<label class="field-label" for="prop-fill">Color</label>
						<input
							id="prop-fill"
							type="color"
							class="field-color"
							value={fill}
							oninput={(e) => setProp('fill', e.currentTarget.value)}
						/>
						{@render bindBtn('fill')}
					</div>
					{@render bindEditor('fill')}

					<div class="field-row">
						<span class="field-label">Align</span>
						<div class="btn-group" role="group" aria-label="Text alignment">
							<button
								class="btn-group-item"
								class:active={textAlign === 'left'}
								onclick={() => setProp('textAlign', 'left')}
								aria-label="Align left"
								title="Align left"
							>
								<AlignLeft size={14} />
							</button>
							<button
								class="btn-group-item"
								class:active={textAlign === 'center'}
								onclick={() => setProp('textAlign', 'center')}
								aria-label="Align center"
								title="Align center"
							>
								<AlignCenter size={14} />
							</button>
							<button
								class="btn-group-item"
								class:active={textAlign === 'right'}
								onclick={() => setProp('textAlign', 'right')}
								aria-label="Align right"
								title="Align right"
							>
								<AlignRight size={14} />
							</button>
						</div>
					</div>
				</section>
			{/if}

			<!-- Image Section -->
			{#if isImage}
				<section class="section" data-testid="property-section-image">
					<h4 class="section-title">Image</h4>

					{#if srcAssetId}
						<!-- Library-link pill (TASK-116). Shown when the layer's
							src came from the asset library; the save serializer
							rewrites src → asset://{id} based on this id stamp.
							Unlink clears the stamp without touching the URL —
							the user keeps the same render but the persisted
							JSON drops back to an absolute URL. -->
						<div class="asset-link-pill" data-testid="asset-link-pill">
							<span class="asset-link-label">Linked to asset library</span>
							<button
								type="button"
								class="asset-link-unlink"
								onclick={() => setProp('srcAssetId', undefined)}
								data-testid="asset-link-unlink"
							>
								Unlink
							</button>
						</div>
					{/if}

					<div class="field-row field-col bind-row">
						<div class="bind-row-label-line">
							<label class="field-label" for="prop-src">Source URL</label>
							{@render bindBtn('src')}
						</div>
						<input id="prop-src" type="text" class="field-input" value={imageSrc} readonly />
					</div>
					{@render bindEditor('src')}

					<!-- Fallback URL (TASK-86). Optional second URL the renderer
						falls back to when the primary `src` fails (404, timeout,
						SSRF block). Editable: a designer types or pastes a URL,
						accepts `asset://{id}` once asset-library refs are wired
						in. Single level only — if both fail, the gray placeholder
						is drawn. -->
					<div class="field-row field-col">
						<label class="field-label" for="prop-fallback-src">Fallback image URL</label>
						<input
							id="prop-fallback-src"
							type="text"
							class="field-input"
							value={fallbackSrc}
							oninput={(e) => setUrlProp('fallbackSrc', e.currentTarget.value || undefined)}
							placeholder="Used when the bound image URL fails to load"
						/>
					</div>
				</section>
			{/if}

			<!-- Badge Section (TASK-87) -->
			{#if isBadge}
				<section class="section" data-testid="property-section-badge">
					<h4 class="section-title">Badge</h4>

					<div class="field-row field-col bind-row">
						<div class="bind-row-label-line">
							<label class="field-label" for="prop-badge-label">Label</label>
							{@render bindBtn('label')}
						</div>
						<input
							id="prop-badge-label"
							type="text"
							class="field-input"
							value={badgeLabel}
							oninput={(e) => setProp('label', e.currentTarget.value)}
							placeholder="e.g. Live, In Range, Sold"
						/>
					</div>
					{@render bindEditor('label')}

					<div class="field-row bind-row">
						<label class="field-label" for="prop-badge-fg">Foreground</label>
						<input
							id="prop-badge-fg"
							type="color"
							class="field-input field-input-color"
							value={badgeFg}
							oninput={(e) => setProp('fg', e.currentTarget.value)}
						/>
						{@render bindBtn('fg')}
					</div>
					{@render bindEditor('fg')}

					<div class="field-row bind-row">
						<label class="field-label" for="prop-badge-bg">Background</label>
						<input
							id="prop-badge-bg"
							type="color"
							class="field-input field-input-color"
							value={fill}
							oninput={(e) => setProp('fill', e.currentTarget.value)}
						/>
						{@render bindBtn('fill')}
					</div>
					{@render bindEditor('fill')}

					<div class="field-row">
						<label class="field-label" for="prop-badge-padding">Padding</label>
						<input
							id="prop-badge-padding"
							type="number"
							class="field-input"
							min="0"
							value={badgePadding}
							onchange={(e) => setProp('padding', Number(e.currentTarget.value))}
						/>
					</div>

					<div class="field-row">
						<label class="field-label" for="prop-badge-radius">Corner radius</label>
						<input
							id="prop-badge-radius"
							type="number"
							class="field-input"
							min="0"
							value={badgeRadius ?? ''}
							placeholder="auto (pill)"
							onchange={(e) => {
								const v = e.currentTarget.value;
								setProp('radius', v === '' ? undefined : Number(v));
							}}
						/>
					</div>

					<div class="field-row field-col bind-row">
						<div class="bind-row-label-line">
							<label class="field-label" for="prop-badge-icon">Icon URL</label>
							{@render bindBtn('iconImage')}
						</div>
						<input
							id="prop-badge-icon"
							type="text"
							class="field-input"
							value={badgeIcon}
							oninput={(e) => setUrlProp('iconImage', e.currentTarget.value)}
							placeholder="Optional icon (URL or asset://)"
						/>
					</div>
					{@render bindEditor('iconImage')}

					<div class="field-row">
						<label class="field-label" for="prop-badge-icon-pos">Icon position</label>
						<select
							id="prop-badge-icon-pos"
							class="field-input"
							value={badgeIconPos}
							onchange={(e) => setProp('iconPosition', e.currentTarget.value)}
						>
							<option value="left">Left</option>
							<option value="right">Right</option>
						</select>
					</div>
				</section>
			{/if}

			<!-- Style section (TASK-104) — fallback fill control for layers
				without their own type-specific section (Rect, unknown shapes).
				Text and Badge expose Color/Background in their own section, so
				skip this for those types to avoid a duplicate field row.
				Image layers don't draw `fill`, so omit too. Without this
				section, starter templates like `crypto-lp-card` (which bind
				`Rect.fill` to a URL param) would have NO inline bind affordance
				on the rect layer's fill, and clicking the corresponding entry
				in the Bound Parameters summary would no-op. -->
			{#if !isText && !isBadge && !isImage}
				<section class="section" data-testid="property-section-style">
					<h4 class="section-title">Style</h4>

					<div class="field-row bind-row">
						<label class="field-label" for="prop-style-fill">Fill</label>
						<input
							id="prop-style-fill"
							type="color"
							class="field-color"
							value={fill}
							oninput={(e) => setProp('fill', e.currentTarget.value)}
						/>
						{@render bindBtn('fill')}
					</div>
					{@render bindEditor('fill')}
				</section>
			{/if}

			<!-- Bound Parameters summary (TASK-104) -->
			<!-- Replaces the old collapsed-by-default Dynamic Parameters list.
				With the inline ⚡ pattern, every bindable property field
				exposes its own binding entry-point — this section is just a
				ledger so the user can see at a glance which params drive
				the canvas and jump to one to edit it. -->
			<section class="section" data-testid="property-section-dynamic">
				<h4 class="section-title section-title-static">
					<span>
						Bound Parameters
						{#if boundCount > 0}
							<span class="bound-count" aria-label="{boundCount} bound">{boundCount}</span>
						{/if}
					</span>
				</h4>

				{#if boundCount === 0}
					<p class="bindings-intro-compact">
						Click the
						<span class="zap-inline" aria-hidden="true">
							<Zap size={11} strokeWidth={2.5} />
						</span>
						next to any property to make it dynamic. After publishing, append
						<code>?name=value</code> to the share URL.
					</p>
				{:else}
					<ul class="bound-summary-list" data-testid="bound-summary-list">
						{#each Object.entries(paramBindings) as [propKey, b] (propKey)}
							{@const meta = metaFor(propKey)}
							<li class="bound-summary-item">
								<button
									type="button"
									class="bound-summary-jump"
									class:bound-summary-jump-active={bindEditingProp === propKey}
									onclick={() => openBindEditor(propKey)}
									title="Edit binding"
									data-testid="bound-summary-jump-{propKey}"
								>
									<Zap size={11} strokeWidth={2.5} />
									<span class="bound-summary-param">?{b.param || '(unnamed)'}</span>
									<span class="bound-summary-arrow" aria-hidden="true">→</span>
									<span class="bound-summary-label">{meta.label}</span>
								</button>
								<button
									type="button"
									class="bound-summary-unbind"
									onclick={() => unbind(propKey)}
									aria-label="Unbind {meta.label}"
									title="Unbind"
								>
									×
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<!-- Conditional Styles (TASK-50) -->
			<!-- Lives between Dynamic Parameters and Position so authors can
				see the param wiring directly above the rules that consume it. -->
			<section class="section" data-testid="property-section-conditionals">
				<button
					class="section-title collapsible"
					onclick={() => (conditionalsExpanded = !conditionalsExpanded)}
					aria-expanded={conditionalsExpanded}
				>
					<span>
						Conditional Styles
						{#if conditionalStyles.length > 0}
							<span class="bound-count" aria-label="{conditionalStyles.length} rules">
								{conditionalStyles.length}
							</span>
						{/if}
					</span>
					<span class="chevron" class:open={conditionalsExpanded} aria-hidden="true">
						<ChevronRight size={12} strokeWidth={2.5} />
					</span>
				</button>

				{#if conditionalsExpanded}
					<p class="bindings-intro">
						Override <code>fill</code>, <code>opacity</code>, or <code>visible</code> when a URL parameter
						matches a condition. Use this for red-on-loss / green-on-gain cards.
					</p>

					{#if conditionalStyles.length === 0}
						<p class="conditionals-empty">No rules yet.</p>
					{:else}
						<div class="conditionals-list">
							{#each conditionalStyles as rule, i (i)}
								{@const refStatus = paramRefStatus(rule.when.param, canvasParamNames)}
								<div class="conditional-rule">
									<div class="conditional-row">
										<span class="conditional-when-label">When</span>
										<input
											type="text"
											class="field-input conditional-param"
											class:field-input-warning={refStatus.kind === 'unknown' &&
												!!refStatus.suggestion}
											value={rule.when.param}
											oninput={(e) => updateRule(i, 'when', 'param', e.currentTarget.value)}
											placeholder="param"
											aria-label="Rule {i + 1} parameter name"
											aria-describedby={refStatus.kind === 'unknown' && refStatus.suggestion
												? `rule-${i}-param-warning`
												: undefined}
										/>
										<select
											class="field-select conditional-op"
											value={rule.when.op}
											onchange={(e) => updateRule(i, 'when', 'op', e.currentTarget.value)}
											aria-label="Rule {i + 1} operator"
										>
											<option value="==">=</option>
											<option value="!=">≠</option>
											<option value="<">&lt;</option>
											<option value="<=">≤</option>
											<option value=">">&gt;</option>
											<option value=">=">≥</option>
											<option value="contains">contains</option>
										</select>
										<input
											type="text"
											class="field-input conditional-value"
											value={rule.when.value}
											oninput={(e) => updateRule(i, 'when', 'value', e.currentTarget.value)}
											placeholder="value"
											aria-label="Rule {i + 1} comparison value"
										/>
									</div>
									{#if refStatus.kind === 'unknown' && refStatus.suggestion}
										<!--
											Param-name typo warning (TASK-106). Only fires when
											the typed name has a close-enough match in the set
											of known canvas params — without that gate we'd
											false-positive on the legitimate "URL-only param
											consumed only by this rule" pattern (e.g. `?status=win`
											that drives a fill rule but isn't bound to any
											property). With the suggestion-required gate, the
											warning lights up only for actual typos and offers
											a click-to-fix. Codex round 1 P2.
										-->
										<p
											id="rule-{i}-param-warning"
											class="conditional-warning"
											role="alert"
											data-testid="rule-{i}-param-warning"
										>
											No param matches <code>{rule.when.param}</code>.
											<button
												type="button"
												class="conditional-warning-suggest"
												onclick={() => updateRule(i, 'when', 'param', refStatus.suggestion ?? '')}
												data-testid="rule-{i}-param-suggest"
											>
												Did you mean <code>{refStatus.suggestion}</code>?
											</button>
										</p>
									{/if}
									<div class="conditional-row">
										<span class="conditional-when-label">Then set</span>
										<select
											class="field-select conditional-property"
											value={rule.then.property}
											onchange={(e) => updateRule(i, 'then', 'property', e.currentTarget.value)}
											aria-label="Rule {i + 1} property to override"
										>
											<option value="fill">fill</option>
											<option value="opacity">opacity</option>
											<option value="visible">visible</option>
										</select>
										<span class="conditional-arrow">to</span>
										{#if rule.then.property === 'fill'}
											<input
												type="color"
												class="field-color"
												value={rule.then.value || '#000000'}
												oninput={(e) => updateRule(i, 'then', 'value', e.currentTarget.value)}
												aria-label="Rule {i + 1} fill color"
											/>
										{:else if rule.then.property === 'opacity'}
											<input
												type="number"
												class="field-input conditional-then-num"
												min="0"
												max="1"
												step="0.05"
												value={rule.then.value}
												oninput={(e) => updateRule(i, 'then', 'value', e.currentTarget.value)}
												aria-label="Rule {i + 1} opacity 0..1"
											/>
										{:else if rule.then.property === 'visible'}
											<select
												class="field-select"
												value={rule.then.value || 'false'}
												onchange={(e) => updateRule(i, 'then', 'value', e.currentTarget.value)}
												aria-label="Rule {i + 1} visibility"
											>
												<option value="false">hidden</option>
												<option value="true">visible</option>
											</select>
										{/if}
										<button
											type="button"
											class="conditional-remove"
											onclick={() => removeRule(i)}
											aria-label="Remove rule {i + 1}"
											title="Remove rule"
										>
											×
										</button>
									</div>
								</div>
							{/each}
						</div>
					{/if}

					<button type="button" class="conditional-add" onclick={addRule}>+ Add rule</button>
				{/if}
			</section>

			<!-- Position Section (collapsible, collapsed by default) -->
			<section class="section" data-testid="property-section-position">
				<button
					class="section-title collapsible"
					onclick={() => (positionExpanded = !positionExpanded)}
					aria-expanded={positionExpanded}
				>
					<span>Position &amp; size</span>
					<span class="chevron" class:open={positionExpanded} aria-hidden="true"
						><ChevronRight size={12} strokeWidth={2.5} /></span
					>
				</button>

				{#if positionExpanded}
					<div class="field-row bind-row">
						<label class="field-label" for="prop-x">X</label>
						<input
							id="prop-x"
							type="number"
							class="field-input"
							value={Math.round(posX)}
							onchange={(e) => setProp('left', Number(e.currentTarget.value))}
						/>
						{@render bindBtn('left')}
					</div>
					{@render bindEditor('left')}

					<div class="field-row bind-row">
						<label class="field-label" for="prop-y">Y</label>
						<input
							id="prop-y"
							type="number"
							class="field-input"
							value={Math.round(posY)}
							onchange={(e) => setProp('top', Number(e.currentTarget.value))}
						/>
						{@render bindBtn('top')}
					</div>
					{@render bindEditor('top')}

					<!-- Width / height bindings are NOT exposed for badge layers
						because the renderer's `applyBadgeLayouts` recomputes
						`obj.width` / `obj.height` from the label + icon layout
						AFTER `mergeParams` runs, silently overwriting any URL-
						bound value. Showing the ⚡ here would let the user wire
						a binding that looks valid in the editor but has zero
						effect at render. The manual W/H input is still shown
						(informational — the auto-sized bounds), just without
						the bind affordance. -->
					<div class="field-row" class:bind-row={!isBadge}>
						<label class="field-label" for="prop-w">Width</label>
						<input
							id="prop-w"
							type="number"
							class="field-input"
							value={Math.round(objWidth)}
							onchange={(e) => setDimension('width', Number(e.currentTarget.value))}
						/>
						{#if !isBadge}{@render bindBtn('width')}{/if}
					</div>
					{#if !isBadge}{@render bindEditor('width')}{/if}

					<div class="field-row" class:bind-row={!isBadge}>
						<label class="field-label" for="prop-h">Height</label>
						<input
							id="prop-h"
							type="number"
							class="field-input"
							value={Math.round(objHeight)}
							onchange={(e) => setDimension('height', Number(e.currentTarget.value))}
						/>
						{#if !isBadge}{@render bindBtn('height')}{/if}
					</div>
					{#if !isBadge}{@render bindEditor('height')}{/if}

					<div class="field-row">
						<label class="field-label" for="prop-angle">Rotation</label>
						<div class="input-with-suffix">
							<input
								id="prop-angle"
								type="number"
								class="field-input"
								value={Math.round(angle)}
								onchange={(e) => setProp('angle', Number(e.currentTarget.value))}
							/>
							<span class="suffix">&deg;</span>
						</div>
					</div>

					<div class="field-row bind-row">
						<label class="field-label" for="prop-opacity">Opacity</label>
						<input
							id="prop-opacity"
							type="range"
							class="field-range"
							min="0"
							max="1"
							step="0.01"
							value={opacity}
							oninput={(e) => setProp('opacity', Number(e.currentTarget.value))}
						/>
						<span class="range-value">{Math.round(opacity * 100)}%</span>
						{@render bindBtn('opacity')}
					</div>
					{@render bindEditor('opacity')}

					<!-- Visibility row (TASK-104). Adds a concrete field for the
						`visible` property so the inline ⚡ has somewhere to live —
						previously visibility was only reachable through the
						Dynamic Parameters list. The checkbox itself is also a
						useful manual toggle that the editor lacked. -->
					<div class="field-row bind-row">
						<label class="field-label" for="prop-visible">Visible</label>
						<input
							id="prop-visible"
							type="checkbox"
							class="field-checkbox"
							checked={visible}
							onchange={(e) => setProp('visible', e.currentTarget.checked)}
						/>
						{@render bindBtn('visible')}
					</div>
					{@render bindEditor('visible')}
				{/if}
			</section>
		</div>
	{/if}
</aside>

<style>
	.property-panel {
		width: 280px;
		min-width: 280px;
		height: 100%;
		display: flex;
		flex-direction: column;
		border-left: 1px solid var(--color-border);
		background: var(--color-surface);
		font-family: system-ui, sans-serif;
		font-size: 13px;
		overflow: hidden;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--color-text-subtle);
		text-align: center;
		padding: 20px;
	}

	.empty-state p {
		margin: 0 0 4px;
		font-weight: 600;
		font-size: 14px;
	}

	.hint {
		font-size: 11px;
		color: var(--color-text-subtle);
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.panel-header h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.type-badge {
		background: var(--color-border);
		border-radius: 10px;
		padding: 1px 8px;
		font-size: 11px;
		color: var(--color-text-muted);
	}

	.sections {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 12px;
	}

	.section {
		border-bottom: 1px solid var(--color-border);
		padding: 10px 12px;
	}

	.section-title {
		margin: 0 0 8px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-text-muted);
	}

	.collapsible {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		font: inherit;
		color: inherit;
	}

	.chevron {
		display: inline-flex;
		align-items: center;
		transition: transform 0.15s ease;
		color: var(--color-text-subtle);
	}

	.btn-group-item :global(svg) {
		display: block;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.field-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.field-col {
		flex-direction: column;
		align-items: stretch;
	}

	.field-label {
		width: 60px;
		min-width: 60px;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.field-label.small {
		width: 48px;
		min-width: 48px;
		font-size: 11px;
	}

	.field-col .field-label {
		width: auto;
		min-width: auto;
		margin-bottom: 2px;
	}

	.field-input {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		background: var(--color-bg);
	}

	.field-input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(91, 155, 213, 0.2);
	}

	.field-input[readonly] {
		background: var(--color-surface-muted);
		color: var(--color-text-subtle);
	}

	.asset-link-pill {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.35rem 0.6rem;
		margin-bottom: 0.5rem;
		background: var(--color-primary-surface);
		border: 1px solid var(--color-primary-border);
		border-radius: 999px;
		font-size: 0.75rem;
		color: var(--color-primary-hover);
	}

	.asset-link-label {
		font-weight: 500;
	}

	.asset-link-unlink {
		border: none;
		background: transparent;
		color: var(--color-primary-hover);
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
	}

	.asset-link-unlink:hover {
		color: var(--color-primary-hover);
	}

	.asset-link-unlink:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
		border-radius: 2px;
	}

	.input-with-suffix {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.input-with-suffix .field-input {
		flex: 1;
	}

	.suffix {
		font-size: 12px;
		color: var(--color-text-subtle);
	}

	.field-range {
		flex: 1;
		min-width: 0;
	}

	.range-value {
		width: 36px;
		text-align: right;
		font-size: 11px;
		color: var(--color-text-subtle);
	}

	.field-textarea {
		width: 100%;
		padding: 4px 6px;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		resize: vertical;
		background: var(--color-bg);
		box-sizing: border-box;
	}

	.field-textarea:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(91, 155, 213, 0.2);
	}

	.field-select {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		background: var(--color-bg);
	}

	.field-select:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 2px rgba(91, 155, 213, 0.2);
	}

	.field-color {
		width: 32px;
		height: 28px;
		padding: 2px;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		cursor: pointer;
		background: var(--color-bg);
	}

	.btn-group {
		display: flex;
		border: 1px solid var(--color-border-strong);
		border-radius: 4px;
		overflow: hidden;
	}

	.btn-group-item {
		padding: 4px 10px;
		border: none;
		border-right: 1px solid var(--color-border-strong);
		background: var(--color-bg);
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
		color: var(--color-text-muted);
	}

	.btn-group-item:last-child {
		border-right: none;
	}

	.btn-group-item:hover {
		background: var(--color-surface-muted);
	}

	.btn-group-item.active {
		background: var(--color-primary-surface);
		color: var(--color-text);
	}

	.bound-count {
		display: inline-block;
		margin-left: 4px;
		padding: 0 6px;
		background: var(--color-primary);
		color: var(--color-bg);
		border-radius: 9999px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: none;
		line-height: 16px;
		min-width: 16px;
		text-align: center;
	}

	.bindings-intro {
		margin: 8px 0;
		padding: 8px 10px;
		background: var(--color-primary-surface);
		border: 1px solid var(--color-primary-surface);
		border-radius: 4px;
		font-size: 11px;
		color: var(--color-primary-hover);
		line-height: 1.45;
	}

	.bindings-intro code {
		background: var(--color-bg);
		border: 1px solid var(--color-primary-surface);
		border-radius: 3px;
		padding: 0 3px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10.5px;
	}

	.conditionals-empty {
		margin: 8px 0;
		font-size: 11.5px;
		color: var(--color-text-subtle);
		font-style: italic;
	}

	.conditionals-list {
		margin: 8px 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.conditional-rule {
		padding: 8px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.conditional-row {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
	}

	.conditional-when-label {
		min-width: 50px;
		color: var(--color-text-subtle);
		font-weight: 500;
	}

	.conditional-param {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		padding: 3px 5px;
	}

	.conditional-op {
		width: 64px;
		font-size: 11px;
		padding: 3px 4px;
	}

	.conditional-value {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		padding: 3px 5px;
	}

	.conditional-property {
		width: 80px;
		font-size: 11px;
		padding: 3px 4px;
	}

	.conditional-arrow {
		color: var(--color-text-subtle);
	}

	.conditional-then-num {
		width: 60px;
		font-size: 11px;
		padding: 3px 5px;
	}

	.conditional-remove {
		margin-left: auto;
		background: none;
		border: none;
		color: var(--color-text-subtle);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
	}

	.conditional-remove:hover {
		color: var(--color-danger);
	}

	.conditional-add {
		margin-top: 4px;
		padding: 4px 10px;
		font-size: 11.5px;
		background: var(--color-bg);
		border: 1px dashed var(--color-border-strong);
		border-radius: 4px;
		cursor: pointer;
		color: var(--color-text-muted);
		width: 100%;
	}

	.conditional-add:hover {
		background: var(--color-surface-muted);
		border-color: var(--color-text-subtle);
	}

	/* Conditional-rule param-name typo warning (TASK-106). Sits inside
	   the .conditional-rule card between the When-row and the Then-row
	   so the user can fix the rule without losing the surrounding
	   context. */
	.conditional-warning {
		margin: 4px 0 0;
		padding: 6px 8px;
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 4px;
		font-size: 11px;
		color: var(--color-warning-text);
		line-height: 1.45;
	}

	.conditional-warning code {
		background: var(--color-bg);
		border: 1px solid var(--color-warning-border);
		border-radius: 3px;
		padding: 0 0.2rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10.5px;
	}

	.conditional-warning-suggest {
		display: inline-block;
		margin-top: 2px;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-primary-hover);
		font-family: inherit;
		font-size: 11px;
		text-decoration: underline;
		cursor: pointer;
	}

	.conditional-warning-suggest:hover,
	.conditional-warning-suggest:focus-visible {
		color: var(--color-primary-hover);
	}

	.conditional-warning-suggest:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 2px;
	}

	.binding-format-hint {
		margin: 4px 0 6px 56px;
		font-size: 10.5px;
		color: var(--color-text-subtle);
		line-height: 1.4;
	}

	.binding-format-hint code {
		background: var(--color-surface-muted);
		padding: 0 0.25rem;
		border-radius: 3px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10.5px;
	}

	.binding-fields {
		margin-top: 6px;
	}

	.field-input-warning {
		border-color: var(--color-warning);
		background: var(--color-warning-surface);
	}

	.field-input-warning:focus {
		border-color: var(--color-warning);
		box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2);
	}

	.binding-warning {
		margin: 2px 0 6px 56px;
		font-size: 11px;
		color: var(--color-warning-text);
		line-height: 1.35;
	}

	.binding-url-preview {
		margin: 6px 0 0;
		padding: 5px 7px;
		background: var(--color-text);
		border-radius: 3px;
		font-size: 10.5px;
		line-height: 1.4;
		color: var(--color-border-strong);
		overflow-x: auto;
		white-space: nowrap;
	}

	.binding-url-sample {
		margin-top: 3px;
		background: var(--color-text);
	}

	.url-preview-label {
		color: var(--color-text-subtle);
		margin-right: 4px;
	}

	.binding-url-preview code {
		color: var(--color-surface-muted);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	/* TASK-104: Inline ⚡ Make-dynamic affordance.
	   `.bind-row` marks any property field row that participates in the
	   pattern; the ⚡ button at the end of the row stays hidden by default
	   so unbound rows look identical to before, then fades in on hover or
	   keyboard focus. Bound rows always show the icon (tinted) so the user
	   can see at a glance which fields drive the published render. */
	.bind-row {
		position: relative;
	}

	.bind-row-label-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 2px;
	}

	.bind-row-label-line .field-label {
		margin-bottom: 0;
	}

	.bind-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		margin-left: 4px;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--color-border-strong);
		cursor: pointer;
		flex-shrink: 0;
		opacity: 0;
		transition:
			opacity 0.12s ease,
			color 0.12s ease,
			background 0.12s ease,
			border-color 0.12s ease;
	}

	.bind-row:hover .bind-btn,
	.bind-row:focus-within .bind-btn {
		opacity: 1;
	}

	.bind-btn:hover {
		color: var(--color-primary);
		background: var(--color-primary-surface);
		border-color: var(--color-primary-surface);
	}

	.bind-btn:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
		opacity: 1;
	}

	.bind-btn-bound {
		opacity: 1;
		color: var(--color-warning-text);
		background: var(--color-warning-surface);
		border-color: var(--color-warning-border);
	}

	.bind-btn-bound:hover {
		color: var(--color-warning-text);
		background: var(--color-warning-border);
		border-color: var(--color-warning);
	}

	.bind-btn-editing {
		color: var(--color-primary-hover);
		background: var(--color-primary-surface);
		border-color: var(--color-primary-border);
		opacity: 1;
	}

	.bind-editor-card {
		margin: 0 0 10px;
		padding: 8px 10px;
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 4px;
	}

	.bind-editor-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}

	.bind-editor-title {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		color: var(--color-warning-text);
	}

	.bind-editor-actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 8px;
	}

	.bind-editor-unbind,
	.bind-editor-done {
		padding: 3px 10px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 600;
		cursor: pointer;
		line-height: 1.5;
		font-family: inherit;
	}

	.bind-editor-unbind {
		background: var(--color-bg);
		border: 1px solid var(--color-warning-border);
		color: var(--color-warning-text);
	}

	.bind-editor-unbind:hover {
		background: var(--color-warning-surface);
	}

	.bind-editor-done {
		background: var(--color-primary);
		border: 1px solid var(--color-primary);
		color: var(--color-bg);
	}

	.bind-editor-done:hover {
		background: var(--color-primary-hover);
		border-color: var(--color-primary-hover);
	}

	.bind-editor-unbind:focus-visible,
	.bind-editor-done:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}

	/* Static (non-collapsible) section title — used for the new
	   compact Bound Parameters summary which is always visible. */
	.section-title-static {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 0 0 8px;
	}

	.bindings-intro-compact {
		margin: 4px 0 0;
		font-size: 11.5px;
		color: var(--color-text-subtle);
		line-height: 1.5;
	}

	.bindings-intro-compact code {
		background: var(--color-surface-muted);
		padding: 0 0.25rem;
		border-radius: 3px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10.5px;
	}

	.zap-inline {
		display: inline-flex;
		vertical-align: -1px;
		color: var(--color-warning-text);
	}

	.bound-summary-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.bound-summary-item {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.bound-summary-jump {
		flex: 1;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		padding: 4px 6px;
		border: 1px solid var(--color-warning-border);
		border-radius: 4px;
		background: var(--color-warning-surface);
		font-family: inherit;
		font-size: 11.5px;
		color: var(--color-warning-text);
		cursor: pointer;
		text-align: left;
	}

	.bound-summary-jump :global(svg) {
		flex-shrink: 0;
		color: var(--color-warning-text);
	}

	.bound-summary-jump:hover {
		background: var(--color-warning-surface);
		border-color: var(--color-warning);
	}

	.bound-summary-jump:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}

	.bound-summary-jump-active {
		background: var(--color-warning-surface);
		border-color: var(--color-warning);
	}

	.bound-summary-param {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
		color: var(--color-warning-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bound-summary-arrow {
		color: var(--color-warning-text);
		opacity: 0.7;
	}

	.bound-summary-label {
		color: var(--color-text-subtle);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bound-summary-unbind {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-subtle);
		font-size: 14px;
		font-weight: 600;
		line-height: 1;
		cursor: pointer;
	}

	.bound-summary-unbind:hover {
		color: var(--color-danger);
		background: var(--color-danger-border);
		border-color: var(--color-danger-border);
	}

	.bound-summary-unbind:focus-visible {
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}

	.field-checkbox {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		margin: 0;
		cursor: pointer;
	}
</style>
