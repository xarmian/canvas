<script lang="ts">
	import { untrack } from 'svelte';
	import { Modal } from '$lib/components/ui';
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

	$effect(() => {
		if (open) {
			width = currentWidth;
			height = currentHeight;
			backgroundColor = currentBackgroundType === 'color' ? currentBackgroundValue : '#ffffff';
			selectedPreset = matchPreset(currentWidth, currentHeight);
		}
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
		saving = true;
		try {
			const patch: CanvasSettingsPatch = {
				width,
				height,
				backgroundType: 'color',
				backgroundValue: backgroundColor
			};
			const res = await fetch(`/api/canvas/${canvasId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(patch)
			});
			if (!res.ok) {
				toast.error('Failed to update canvas settings.');
				return;
			}
			onApplied(patch);
			toast.success('Canvas settings updated');
			onClose();
		} catch {
			toast.error('Failed to update canvas settings.');
		} finally {
			saving = false;
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
				<input
					type="number"
					min="16"
					max="4096"
					step="1"
					value={width}
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
				<input
					type="number"
					min="16"
					max="4096"
					step="1"
					value={height}
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
			<input
				type="color"
				value={backgroundColor}
				oninput={(e) => (backgroundColor = e.currentTarget.value)}
			/>
			<input
				type="text"
				class="bg-hex"
				value={backgroundColor}
				oninput={(e) => (backgroundColor = e.currentTarget.value)}
				aria-label="Background color hex"
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
		<button type="button" class="btn btn-cancel" disabled={saving} onclick={onClose}>
			Cancel
		</button>
		<button type="button" class="btn btn-primary" disabled={saving || !isChanged} onclick={apply}>
			{saving ? 'Applying…' : 'Apply'}
		</button>
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
		color: #6b7280;
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
		border: 1px solid #d1d5db;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.8125rem;
		background: #fff;
	}

	.preset:hover {
		background: #f9fafb;
	}

	.preset.active {
		border-color: #2563eb;
		background: #eff6ff;
		color: #1d4ed8;
	}

	.preset input[type='radio'] {
		margin: 0;
	}

	.preset-label {
		display: flex;
		flex-direction: column;
	}

	.preset small {
		color: #9ca3af;
		font-size: 0.7rem;
	}

	.preset.active small {
		color: #2563eb;
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
		color: #374151;
		width: 3rem;
	}

	.dim-field input {
		flex: 1;
		min-width: 0;
		padding: 0.35rem 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.dim-field .unit {
		color: #9ca3af;
		font-size: 0.75rem;
	}

	.bg-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.bg-row input[type='color'] {
		width: 2.5rem;
		height: 2rem;
		padding: 2px;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		cursor: pointer;
	}

	.bg-hex {
		flex: 1;
		padding: 0.35rem 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 4px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.8125rem;
	}

	.warn {
		margin: 0 0 0.5rem;
		padding: 0.55rem 0.75rem;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: 5px;
		font-size: 0.8125rem;
		color: #92400e;
		line-height: 1.45;
	}

	.btn {
		padding: 0.45rem 1rem;
		border-radius: 5px;
		font-size: 0.85rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
	}

	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.btn-cancel {
		background: #fff;
		color: #374151;
		border-color: #d1d5db;
	}

	.btn-cancel:hover:not(:disabled) {
		background: #f3f4f6;
	}

	.btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.btn-primary:hover:not(:disabled) {
		background: #1d4ed8;
	}
</style>
