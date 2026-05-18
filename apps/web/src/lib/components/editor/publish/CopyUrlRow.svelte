<script lang="ts">
	import { Input, Button } from '$lib/components/ui';
	import { copyToClipboard } from '$lib/share-clipboard';

	/**
	 * Read-only URL field with a Copy button. Used by PublishModal for the
	 * share-page URL and the rendered-image URL, and (later) anywhere else
	 * we surface a copyable URL with help text. Extracted in TASK-234.
	 *
	 * `copyLabel` controls the toast wording — it shows as
	 * "{copyLabel} copied to clipboard". The clipboard call routes through
	 * the canonical helper so fallback path + toast vocabulary stay in
	 * lockstep with the rest of the editor (TASK-132).
	 *
	 * The styles below are copied verbatim from PublishModal's `.field`,
	 * `.copy-row`, `.help`, and the `:global(.url-input)` rule so the
	 * extract is a visual no-op. PublishModal still owns the same rules
	 * for its remaining field rows (slug, sharing inputs).
	 */
	interface Props {
		id: string;
		label: string;
		url: string;
		copyLabel: string;
		helpHtml?: import('svelte').Snippet;
	}

	let { id, label, url, copyLabel, helpHtml }: Props = $props();

	async function copy() {
		await copyToClipboard(url, { success: `${copyLabel} copied to clipboard` });
	}
</script>

<div class="field">
	<label for={id}>{label}</label>
	<div class="copy-row">
		<Input {id} type="text" readonly value={url} class="url-input" />
		<Button variant="copy" onclick={copy}>Copy</Button>
	</div>
	{#if helpHtml}
		<p class="help">{@render helpHtml()}</p>
	{/if}
</div>

<style>
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
	 * but want a monospace + slightly muted treatment so the URL value is
	 * visually distinct from a normal editable text field. `:global`
	 * reaches through the primitive's scoped CSS.
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

	.help :global(code) {
		background: var(--color-surface-muted);
		padding: 0 0.25rem;
		border-radius: 3px;
	}
</style>
