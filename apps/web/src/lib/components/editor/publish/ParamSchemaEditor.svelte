<script lang="ts">
	import { ErrorState, LoadingSkeleton } from '$lib/components/ui';
	import type { PublishModalBinding } from '../PublishModal.svelte';

	/**
	 * Bindings-table editor (extracted from PublishModal in TASK-238 under
	 * PLAN-232 Phase D). Renders the "Using this template" header + the
	 * stale-edits warning + the schema error/skeleton + the per-binding
	 * Type/Required row controls.
	 *
	 * Presentational — `paramRows`, `paramRowsLoaded`, `paramRowsError`
	 * still live in PublishModal so the same data feeds <EmbedSnippets>
	 * (typed-TS snippet) and the docs-section's example-URL deriveds
	 * without a second fetch. Edits go through the `onPersist` callback
	 * so the parent owns the PATCH (and the optimistic in-memory
	 * update). Same for retries via `onRetry`.
	 *
	 * Per the task spec's "lifting" decision: `paramRows` ownership
	 * lives at the modal layer for now; it migrates to editor-page
	 * state in Phase C (TASK-245).
	 */
	export interface ParamRow {
		name: string;
		type: string;
		required: boolean;
	}

	interface Props {
		bindings: PublishModalBinding[];
		paramRows: ParamRow[];
		paramRowsLoaded: boolean;
		paramRowsError: boolean;
		bindingsStale?: boolean;
		onPersist: (name: string, patch: Partial<ParamRow>) => void;
		onRetry: () => void;
	}

	let {
		bindings,
		paramRows,
		paramRowsLoaded,
		paramRowsError,
		bindingsStale = false,
		onPersist,
		onRetry
	}: Props = $props();
</script>

{#if bindingsStale}
	<p class="docs-warning">
		⚠️ This canvas has unsaved edits. The dynamic values below may not yet be live on the public
		URL. Save the canvas, then reopen this dialog for the authoritative docs.
	</p>
{/if}

{#if paramRowsError}
	<!--
		GET /api/canvas/[id]/params failed. The bindings table still
		renders below (those come from the in-memory Fabric canvas),
		but Type / Required cells stay disabled until the schema
		reaches the editor — so surface the error inline with retry
		instead of silently leaving them stuck. (TASK-136)
	-->
	<div class="docs-error" data-testid="docs-schema-error">
		<ErrorState
			title="Couldn't load Type / Required"
			message="The saved type/required settings didn't reach the editor. The dynamic values still show below; Type and Required can't be edited until they load."
			{onRetry}
		/>
	</div>
{:else if bindings.length > 0 && !paramRowsLoaded}
	<!--
		Skeleton fills the table area so it doesn't look broken while
		the GET is in flight.
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
		This canvas has no dynamic values yet. Make properties dynamic in the editor (⚡ Dynamic values
		in the property panel) to make the shared URL change based on query string values.
	</p>
{:else}
	<p class="docs-hint">
		This canvas accepts {bindings.length}
		{bindings.length === 1 ? 'dynamic value' : 'dynamic values'}. Omit any to use its default value.
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
					onchange={(e) => onPersist(b.name, { type: e.currentTarget.value })}
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
						onchange={(e) => onPersist(b.name, { required: e.currentTarget.checked })}
					/>
					<span>required</span>
				</label>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* Verbatim copies of PublishModal's docs-section rules so the
	   extract is a visual no-op. */
	.docs-error {
		margin: 0 0 var(--spacing-3);
	}

	.docs-skeleton {
		margin: 0 0 var(--spacing-3);
		display: flex;
		flex-direction: column;
		gap: var(--spacing-2);
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
