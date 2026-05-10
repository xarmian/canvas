<script lang="ts">
	import { goto } from '$app/navigation';

	/**
	 * New-canvas presets (TASK-102). The label + description teach
	 * unfamiliar creators which preset to pick — the dimension-only
	 * labels we shipped before required prior knowledge of OG conventions.
	 *
	 * Label is the *accessible* name of the radio (Playwright + screen
	 * readers both read it). Description is the explanatory copy below
	 * the label. The thumbnail is a small CSS-scaled outline that
	 * conveys aspect ratio at a glance — no SVG or image asset
	 * required.
	 *
	 * `recommended` flags the default preset so its row gets a "(recommended)"
	 * badge. We don't repeat the size in the label because the size is
	 * already shown explicitly to the right of the description.
	 */
	const presets = [
		{
			label: 'OG / Twitter',
			width: 1200,
			height: 630,
			description: 'Used by Twitter, LinkedIn, Slack, Discord, and most link previews.',
			recommended: true
		},
		{
			label: 'Twitter card',
			width: 1200,
			height: 600,
			description: "Twitter's specific card size; only use if you want the Twitter-only ratio.",
			recommended: false
		},
		{
			label: 'Instagram post',
			width: 1080,
			height: 1080,
			description: 'Square format for Instagram feed.',
			recommended: false
		},
		{
			label: 'Custom',
			width: 0,
			height: 0,
			description: 'Set your own dimensions.',
			recommended: false
		}
	] as const;

	let name = $state('');
	let selectedPreset = $state(0);
	let customWidth = $state(1200);
	let customHeight = $state(630);
	let backgroundValue = $state('#ffffff');
	let loading = $state(false);
	let error = $state('');

	let width = $derived(
		presets[selectedPreset].label === 'Custom' ? customWidth : presets[selectedPreset].width
	);
	let height = $derived(
		presets[selectedPreset].label === 'Custom' ? customHeight : presets[selectedPreset].height
	);
	let isCustom = $derived(presets[selectedPreset].label === 'Custom');

	/**
	 * Scale the thumbnail outline so the larger dimension fits within
	 * `MAX_THUMB`. Square (Instagram) renders as a square; landscape
	 * (OG/Twitter) renders as a rectangle. Keeps the visual story
	 * "this is the shape your image will be."
	 */
	const MAX_THUMB = 32;
	function thumbStyle(w: number, h: number): string {
		if (w <= 0 || h <= 0) return '';
		const ratio = w / h;
		const tw = ratio >= 1 ? MAX_THUMB : MAX_THUMB * ratio;
		const th = ratio >= 1 ? MAX_THUMB / ratio : MAX_THUMB;
		return `width: ${tw}px; height: ${th}px;`;
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		loading = true;

		try {
			const res = await fetch('/api/canvas', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					width,
					height,
					backgroundType: 'color',
					backgroundValue
				})
			});

			if (!res.ok) {
				const data = await res.json().catch(() => null);
				error = data?.message ?? 'Something went wrong. Please try again.';
				return;
			}

			const { id } = await res.json();
			goto(`/canvas/${id}/edit`);
		} catch {
			error = 'Network error. Please check your connection and try again.';
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>New Canvas | Canvas</title>
</svelte:head>

<div class="page">
	<form class="form" onsubmit={handleSubmit}>
		<h1>Create a new canvas</h1>

		{#if error}
			<div class="error" role="alert">{error}</div>
		{/if}

		<label class="field">
			<span class="label">Name</span>
			<input type="text" bind:value={name} required placeholder="My canvas" />
		</label>

		<fieldset class="field">
			<legend class="label">Dimensions</legend>
			<div class="presets">
				{#each presets as preset, i (preset.label)}
					<label class="preset" class:active={selectedPreset === i}>
						<input type="radio" bind:group={selectedPreset} value={i} />
						<span class="thumb-wrap" aria-hidden="true">
							{#if preset.label !== 'Custom'}
								<span
									class="thumb"
									style={thumbStyle(preset.width, preset.height)}
									aria-hidden="true"
								></span>
							{:else}
								<span class="thumb thumb-custom" aria-hidden="true">?</span>
							{/if}
						</span>
						<span class="preset-text">
							<span class="preset-label">
								{preset.label}{#if preset.recommended}
									<span class="badge-recommended">recommended</span>
								{/if}
							</span>
							<span class="preset-desc">{preset.description}</span>
						</span>
						{#if preset.label !== 'Custom'}
							<span class="preset-size">{preset.width}&times;{preset.height}</span>
						{/if}
					</label>
				{/each}
			</div>

			{#if isCustom}
				<div class="custom-dimensions">
					<label class="dimension">
						<span>Width</span>
						<input type="number" bind:value={customWidth} min="1" max="4096" required />
					</label>
					<label class="dimension">
						<span>Height</span>
						<input type="number" bind:value={customHeight} min="1" max="4096" required />
					</label>
				</div>
			{/if}
		</fieldset>

		<label class="field">
			<span class="label">Background color</span>
			<div class="color-picker">
				<input type="color" bind:value={backgroundValue} />
				<span class="color-value">{backgroundValue}</span>
			</div>
		</label>

		<div class="actions">
			<a href="/dashboard" class="btn btn-cancel">Cancel</a>
			<button type="submit" class="btn btn-primary" disabled={loading}>
				{#if loading}
					Creating...
				{:else}
					Create Canvas
				{/if}
			</button>
		</div>
	</form>
</div>

<style>
	.page {
		display: flex;
		justify-content: center;
		padding: 2rem 1rem;
	}

	.form {
		width: 100%;
		max-width: 540px;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 1.5rem;
	}

	.error {
		background: #fef2f2;
		color: #b91c1c;
		border: 1px solid #fecaca;
		border-radius: 6px;
		padding: 0.75rem 1rem;
		font-size: 0.875rem;
		margin-bottom: 1.25rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
		border: none;
		padding: 0;
	}

	.label,
	legend.label {
		font-size: 0.875rem;
		font-weight: 600;
		color: #333;
	}

	input[type='text'],
	input[type='number'] {
		padding: 0.5rem 0.75rem;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 0.9rem;
		outline: none;
		transition: border-color 0.15s;
	}

	input[type='text']:focus,
	input[type='number']:focus {
		border-color: #111;
	}

	.presets {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.preset {
		display: grid;
		grid-template-columns: auto auto 1fr auto;
		align-items: center;
		gap: 0.6rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		font-size: 0.9rem;
		cursor: pointer;
		background: #fff;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.preset:hover {
		background: #f8fafc;
	}

	.preset.active {
		border-color: #0f172a;
		background: #f1f5f9;
	}

	.thumb-wrap {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
	}

	.thumb {
		display: block;
		border: 1.5px solid #64748b;
		border-radius: 2px;
		background: #fff;
	}

	.preset.active .thumb {
		border-color: #0f172a;
	}

	.thumb-custom {
		width: 28px;
		height: 28px;
		border-style: dashed;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.85rem;
		font-weight: 600;
		color: #64748b;
		background: #fff;
	}

	.preset-text {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.preset-label {
		font-weight: 600;
		color: #0f172a;
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
	}

	.badge-recommended {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: #ecfeff;
		color: #0e7490;
		border: 1px solid #a5f3fc;
	}

	.preset-desc {
		font-size: 0.8rem;
		color: #64748b;
		line-height: 1.4;
	}

	.preset-size {
		font-size: 0.75rem;
		color: #475569;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		white-space: nowrap;
	}

	.custom-dimensions {
		display: flex;
		gap: 1rem;
		margin-top: 0.75rem;
	}

	.dimension {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
		font-size: 0.85rem;
		color: #555;
	}

	.color-picker {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	input[type='color'] {
		width: 40px;
		height: 40px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		padding: 2px;
		cursor: pointer;
	}

	.color-value {
		font-size: 0.85rem;
		color: #888;
		font-family: monospace;
	}

	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-top: 2rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		padding: 0.6rem 1.25rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		text-decoration: none;
		border: none;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.btn:hover {
		opacity: 0.85;
	}

	.btn-primary {
		background: #111;
		color: #fff;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-cancel {
		background: none;
		color: #666;
		padding: 0.6rem 0.75rem;
	}

	.btn-cancel:hover {
		color: #111;
	}

	@media (max-width: 520px) {
		/*
		 * Drop the size column on narrow screens. The description
		 * already conveys the platform target, and removing the
		 * trailing size keeps the row's grid track count (3) in
		 * sync with the rendered children (radio, thumb, text) so
		 * auto-placement doesn't push items onto a second row.
		 * Custom rows already had no size column, so they're
		 * unaffected.
		 */
		.preset {
			grid-template-columns: auto auto 1fr;
			gap: 0.5rem;
		}

		.preset-size {
			display: none;
		}
	}
</style>
