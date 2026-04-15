<script lang="ts">
	import { goto } from '$app/navigation';

	const presets = [
		{ label: 'OG Image', width: 1200, height: 630 },
		{ label: 'Twitter Card', width: 1200, height: 600 },
		{ label: 'Instagram Post', width: 1080, height: 1080 },
		{ label: 'Custom', width: 0, height: 0 }
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
					<label class="preset">
						<input type="radio" bind:group={selectedPreset} value={i} />
						<span>
							{preset.label}
							{#if preset.label !== 'Custom'}
								<small>{preset.width}&times;{preset.height}</small>
							{/if}
						</span>
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
			<a href="/" class="btn btn-cancel">Cancel</a>
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
		max-width: 500px;
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
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		cursor: pointer;
	}

	.preset small {
		color: #888;
		margin-left: 0.25rem;
	}

	.custom-dimensions {
		display: flex;
		gap: 1rem;
		margin-top: 0.5rem;
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
</style>
