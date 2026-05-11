<script lang="ts">
	import { untrack } from 'svelte';
	import { Modal, Button, Input } from '$lib/components/ui';
	import { toast } from '$lib/stores/toast.svelte';

	export interface CanvasSettingsPatch {
		width: number;
		height: number;
		backgroundType: 'color' | 'image';
		backgroundValue: string;
	}

	interface Props {
		open: boolean;
		canvasId: string;
		currentWidth: number;
		currentHeight: number;
		currentBackgroundType: 'color' | 'image';
		currentBackgroundValue: string;
		/** True if there's any non-background content on the canvas. Used to show
		 * an overflow warning when the user is about to shrink the canvas. */
		hasContent: boolean;
		onClose: () => void;
		/** Called after a successful PATCH with the new values so the editor
		 * can reconcile its Fabric canvas dimensions. */
		onApplied: (patch: CanvasSettingsPatch) => void;
	}

	const PRESETS = [
		{ label: 'OG Image', width: 1200, height: 630 },
		{ label: 'Twitter Card', width: 1200, height: 600 },
		{ label: 'Instagram Post', width: 1080, height: 1080 },
		{ label: 'Instagram Story', width: 1080, height: 1920 },
		{ label: 'Custom', width: 0, height: 0 }
	];

	let {
		open,
		canvasId,
		currentWidth,
		currentHeight,
		currentBackgroundType,
		currentBackgroundValue,
		hasContent,
		onClose,
		onApplied
	}: Props = $props();

	function matchPreset(w: number, h: number): number {
		for (let i = 0; i < PRESETS.length; i++) {
			const p = PRESETS[i];
			if (p.label === 'Custom') continue;
			if (p.width === w && p.height === h) return i;
		}
		return PRESETS.findIndex((p) => p.label === 'Custom');
	}

	// Editable state — initialized from props on first render and resynced in
	// the $effect below each time the modal opens. `untrack` silences
	// svelte-check's state_referenced_locally warning; the effect is what
	// actually keeps these in step with the parent.
	let width = $state(untrack(() => currentWidth));
	let height = $state(untrack(() => currentHeight));
	let backgroundColor = $state(
		untrack(() => (currentBackgroundType === 'color' ? currentBackgroundValue : '#ffffff'))
	);
	let selectedPreset = $state(untrack(() => matchPreset(currentWidth, currentHeight)));
	let saving = $state(false);
	/** Flips false when the component unmounts so in-flight apply() calls
	 * can detect departure from /canvas/[id]/edit and skip UI mutations
	 * (onApplied, toasts) that would otherwise leak onto unrelated pages. */
	let isMounted = true;
	$effect(() => {
		return () => {
			isMounted = false;
		};
	});

	$effect(() => {
		if (open) {
			width = currentWidth;
			height = currentHeight;
			backgroundColor = currentBackgroundType === 'color' ? currentBackgroundValue : '#ffffff';
			selectedPreset = matchPreset(currentWidth, currentHeight);
		}
	});

	// Reset saving=true when the modal is remounted against a different
	// canvas id. Without this, a stalled PATCH from canvas A leaves the
	// Apply button disabled on canvas B because the stale-guard in apply()
	// returns early from the in-flight request and never clears `saving`
	// for the new canvas. fetch() has no timeout/abort, so the old request
	// may never settle.
	$effect(() => {
		void canvasId;
		saving = false;
	});

	let isCustom = $derived(PRESETS[selectedPreset]?.label === 'Custom');

	function applyPresetChoice(index: number) {
		selectedPreset = index;
		const preset = PRESETS[index];
		if (preset.label !== 'Custom') {
			width = preset.width;
			height = preset.height;
		}
	}

	let isShrinking = $derived(width < currentWidth || height < currentHeight);
	let isChanged = $derived(
		width !== currentWidth ||
			height !== currentHeight ||
			backgroundColor !== (currentBackgroundType === 'color' ? currentBackgroundValue : '') ||
			currentBackgroundType !== 'color'
	);

	function validate(): string | null {
		if (!Number.isFinite(width) || width < 16 || width > 4096) {
			return 'Width must be between 16 and 4096 pixels.';
		}
		if (!Number.isFinite(height) || height < 16 || height > 4096) {
			return 'Height must be between 16 and 4096 pixels.';
		}
		// We always persist backgroundType=color via this modal; image backgrounds
		// are managed elsewhere.
		if (!/^#[0-9a-fA-F]{6}$/.test(backgroundColor)) {
			return 'Background color must be a hex value like #ffffff.';
		}
		return null;
	}

	async function apply() {
		if (saving) return;
		const err = validate();
		if (err) {
			toast.error(err);
			return;
		}
		// Pin the canvas id at request start. If the user switches to a
		// different /canvas/[id]/edit while the PATCH is in flight, we must
		// not apply canvas A's dimensions/background to canvas B (which
		// would resize/recolor the wrong canvas + show a misleading toast).
		// Unmount is the same class of problem — don't flush UI when the
		// editor is gone.
		const originCanvasId = canvasId;
		const isStale = () => !isMounted || canvasId !== originCanvasId;
		saving = true;
		try {
			const patch: CanvasSettingsPatch = {
				width,
				height,
				backgroundType: 'color',
				backgroundValue: backgroundColor
			};
			const res = await fetch(`/api/canvas/${originCanvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			});
			if (isStale()) return;
			if (!res.ok) {
				toast.error('Failed to update canvas settings.');
				return;
			}
			onApplied(patch);
			toast.success('Canvas settings updated');
			onClose();
		} catch {
			if (isStale()) return;
			toast.error('Failed to update canvas settings.');
		} finally {
			// Only clear the saving flag for the originating canvas. A stale
			// late completion must not re-enable the button on canvas B if
			// canvas B has its own PATCH in flight (would allow double-submit).
			// The canvas-switch $effect above is what resets saving on switch.
			if (!isStale()) saving = false;
		}
	}
</script>

<Modal {open} title="Canvas settings" width="30rem" {onClose}>
	<div class="field-group">
		<span class="section-label">Dimensions</span>
		<div class="presets">
			{#each PRESETS as preset, i (preset.label)}
				<label class="preset" class:active={selectedPreset === i}>
					<input
						type="radio"
						name="canvas-preset"
						checked={selectedPreset === i}
						onchange={() => applyPresetChoice(i)}
					/>
					<span class="preset-label">
						{preset.label}
						{#if preset.label !== 'Custom'}
							<small>{preset.width}&times;{preset.height}</small>
						{/if}
					</span>
				</label>
			{/each}
		</div>

		<div class="dim-row">
			<label class="dim-field">
				<span>Width</span>
				<Input
					type="number"
					size="sm"
					min={16}
					max={4096}
					step={1}
					value={String(width)}
					class="dim-input"
					onchange={(e) => {
						width = Number(e.currentTarget.value);
						if (!isCustom) {
							selectedPreset = PRESETS.findIndex((p) => p.label === 'Custom');
						}
					}}
				/>
				<span class="unit">px</span>
			</label>
			<label class="dim-field">
				<span>Height</span>
				<Input
					type="number"
					size="sm"
					min={16}
					max={4096}
					step={1}
					value={String(height)}
					class="dim-input"
					onchange={(e) => {
						height = Number(e.currentTarget.value);
						if (!isCustom) {
							selectedPreset = PRESETS.findIndex((p) => p.label === 'Custom');
						}
					}}
				/>
				<span class="unit">px</span>
			</label>
		</div>
	</div>

	<div class="field-group">
		<span class="section-label">Background color</span>
		<div class="bg-row">
			<Input
				type="color"
				value={backgroundColor}
				oninput={(e) => (backgroundColor = e.currentTarget.value)}
				aria-label="Background color"
			/>
			<Input
				type="text"
				size="sm"
				value={backgroundColor}
				oninput={(e) => (backgroundColor = e.currentTarget.value)}
				aria-label="Background color hex"
				class="bg-hex"
			/>
		</div>
	</div>

	{#if isShrinking && hasContent}
		<p class="warn">
			⚠️ The new dimensions are smaller than the current canvas. Layers near the edges may be
			clipped or extend beyond the visible area. You can reposition them after applying.
		</p>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" disabled={saving} onclick={onClose}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!isChanged} onclick={apply}>
			{saving ? 'Applying…' : 'Apply'}
		</Button>
	{/snippet}
</Modal>

<style>
	.field-group {
		margin-bottom: 1rem;
	}

	.section-label {
		display: block;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-text-subtle);
		margin-bottom: 0.5rem;
	}

	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 0.4rem;
		margin-bottom: 0.75rem;
	}

	.preset {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--color-border-strong);
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.8125rem;
		background: var(--color-bg);
	}

	.preset:hover {
		background: var(--color-surface-muted);
	}

	.preset.active {
		border-color: var(--color-primary);
		background: var(--color-primary-surface);
		color: var(--color-primary-hover);
	}

	.preset input[type='radio'] {
		margin: 0;
	}

	.preset-label {
		display: flex;
		flex-direction: column;
	}

	.preset small {
		color: var(--color-text-subtle);
		font-size: 0.7rem;
	}

	.preset.active small {
		color: var(--color-primary);
	}

	.dim-row {
		display: flex;
		gap: 0.75rem;
	}

	.dim-field {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8125rem;
	}

	.dim-field > span:first-child {
		font-weight: 500;
		color: var(--color-text-muted);
		width: 3rem;
	}

	/*
	 * Width/height number inputs come from the Input primitive at
	 * `size="sm"`. The wrapping `.dim-field` already sizes them; the
	 * primitive needs `flex: 1` + zero min-width so it can shrink to
	 * fit the row alongside the "px" unit label.
	 */
	.dim-field :global(.dim-input) {
		flex: 1;
		min-width: 0;
	}

	.dim-field .unit {
		color: var(--color-text-subtle);
		font-size: 0.75rem;
	}

	.bg-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	/*
	 * The hex input next to the color swatch wants a monospace +
	 * flex-fill treatment. The Input primitive provides the border /
	 * padding / radius from `size="sm"`; the per-instance class
	 * supplies the typography.
	 */
	.bg-row :global(.bg-hex) {
		flex: 1;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}

	.warn {
		margin: 0 0 0.5rem;
		padding: 0.55rem 0.75rem;
		background: var(--color-warning-surface);
		border: 1px solid var(--color-warning-border);
		border-radius: 5px;
		font-size: 0.8125rem;
		color: var(--color-warning-text);
		line-height: 1.45;
	}
</style>
