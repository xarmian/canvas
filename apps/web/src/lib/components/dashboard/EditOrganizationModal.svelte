<script lang="ts">
	/**
	 * Modal for editing a canvas's folder + tags from the dashboard.
	 *
	 * Folder is a single string (or null = uncategorized). Tags are a free-
	 * form list — entered comma- or Enter-separated, stored normalized.
	 *
	 * The modal does NOT call the API itself; it bubbles the chosen values
	 * to a parent `onSave` callback so the dashboard page can update its
	 * local optimistic cache immediately. Keeping I/O in the parent also
	 * means a future bulk-edit toolbar can reuse this modal with a
	 * different save handler.
	 */
	import { Modal, Button, Input } from '$lib/components/ui';
	import { X } from '@lucide/svelte';

	interface Props {
		open: boolean;
		canvasName: string;
		initialFolder: string | null;
		initialTags: string[];
		/** Used to power the folder datalist suggestions. */
		knownFolders: string[];
		onSave: (folder: string | null, tags: string[]) => void | Promise<void>;
		onClose: () => void;
	}

	let { open, canvasName, initialFolder, initialTags, knownFolders, onSave, onClose }: Props =
		$props();

	import { untrack } from 'svelte';

	let folderInput = $state(untrack(() => initialFolder ?? ''));
	let tagInput = $state('');
	let tags = $state<string[]>(untrack(() => [...initialTags]));
	let saving = $state(false);

	// Reset local state when the modal opens for a new canvas. Without
	// this, opening Organize on canvas B after editing canvas A would
	// show A's draft values until the user types something.
	$effect(() => {
		if (open) {
			folderInput = initialFolder ?? '';
			tags = [...initialTags];
			tagInput = '';
		}
	});

	function addTag(raw: string) {
		const cleaned = raw.trim();
		if (cleaned.length === 0) return;
		// Guard against duplicates so a careless paste doesn't show up
		// twice in the chip list.
		if (!tags.includes(cleaned)) tags = [...tags, cleaned];
	}

	function handleTagKey(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addTag(tagInput);
			tagInput = '';
		} else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
			// Convenient empty-input backspace: pops the last chip so users
			// can fix typos without reaching for the X.
			tags = tags.slice(0, -1);
		}
	}

	function removeTag(tag: string) {
		tags = tags.filter((t) => t !== tag);
	}

	async function handleSubmit() {
		if (saving) return;
		saving = true;
		try {
			// Flush any pending tag input on save so the user doesn't lose
			// a tag they typed but didn't press Enter on.
			if (tagInput.trim().length > 0) {
				addTag(tagInput);
				tagInput = '';
			}
			const folderTrimmed = folderInput.trim();
			await onSave(folderTrimmed.length > 0 ? folderTrimmed : null, tags);
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} title="Organize canvas" {onClose} width="28rem">
	<form
		onsubmit={(e) => {
			e.preventDefault();
			void handleSubmit();
		}}
	>
		<p class="lede">
			Set a folder and tags for <strong>{canvasName}</strong>. Folders group canvases in the
			sidebar; tags are searchable and clickable.
		</p>

		<div class="field">
			<label for="org-folder-input" class="label">Folder</label>
			<Input
				id="org-folder-input"
				type="text"
				list="known-folders"
				bind:value={folderInput}
				placeholder="Leave empty for uncategorized"
				data-testid="org-folder"
			/>
			<datalist id="known-folders">
				{#each knownFolders as folder (folder)}
					<option value={folder}></option>
				{/each}
			</datalist>
		</div>

		<div class="field">
			<span class="label">Tags</span>
			<div class="tag-input">
				{#each tags as tag (tag)}
					<span class="chip">
						<span>#{tag}</span>
						<!--
							Tag-remove "×" stays inline. The Button primitive
							doesn't yet have an icon-only ultra-compact size
							that fits inside a 1.5rem-tall chip — using it
							would inflate the chip height. Tracked for the
							icon-button enhancement.
						-->
						<button
							type="button"
							class="chip-remove"
							aria-label="Remove tag {tag}"
							onclick={() => removeTag(tag)}
						>
							<X size={12} aria-hidden="true" />
						</button>
					</span>
				{/each}
				<!--
					Borderless tag input nested inside `.tag-input` (the
					chip container provides the visible border). `class`
					opts into a `:global` override that strips the
					primitive's border + padding so it blends in.
				-->
				<Input
					type="text"
					bind:value={tagInput}
					onkeydown={handleTagKey}
					placeholder={tags.length === 0 ? 'Type a tag and press Enter' : ''}
					data-testid="org-tag-input"
					class="chip-input"
				/>
			</div>
			<p class="hint">Press Enter or comma to add a tag. Backspace removes the last chip.</p>
		</div>

		<div class="actions">
			<Button variant="secondary" onclick={onClose} disabled={saving}>Cancel</Button>
			<Button variant="primary" type="submit" loading={saving} data-testid="org-save">
				{saving ? 'Saving…' : 'Save'}
			</Button>
		</div>
	</form>
</Modal>

<style>
	.lede {
		margin: 0 0 1rem;
		color: #475569;
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.field {
		display: block;
		margin-bottom: 1rem;
	}

	.label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		color: #334155;
		margin-bottom: 0.4rem;
	}

	.tag-input {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		padding: 0.4rem;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		background: #fff;
	}

	/*
	 * The tag input is the bare-input variant of the Input primitive,
	 * sitting inside the visible `.tag-input` border. Strip the
	 * primitive's own border + padding so it blends into the chip row.
	 */
	.tag-input :global(.chip-input) {
		flex: 1;
		min-width: 8ch;
		border: none;
		padding: 0.15rem 0.25rem;
		background: transparent;
	}

	.tag-input :global(.chip-input:focus-visible) {
		outline: none;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		background: #e0e7ff;
		color: #3730a3;
		font-size: 0.8rem;
	}

	.chip-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		color: inherit;
		line-height: 1;
		cursor: pointer;
		padding: 0;
		border-radius: 999px;
	}

	.chip-remove:focus-visible {
		outline: 2px solid #2563eb;
		outline-offset: 1px;
	}

	.hint {
		margin: 0.4rem 0 0;
		color: #94a3b8;
		font-size: 0.75rem;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
		margin-top: 1.25rem;
	}
</style>
