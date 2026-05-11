<script lang="ts">
	/**
	 * Editor keyboard shortcut cheatsheet.
	 *
	 * Bound to `?` in the editor's global keydown listener. Lists every
	 * shortcut the editor responds to, grouped by category. The shortcut
	 * keys themselves are described in plain text — we don't try to detect
	 * platform (Mac vs. Windows) and rewrite "Cmd" / "Ctrl"; we show
	 * "Cmd / Ctrl" everywhere because the editor binds both modifiers
	 * to the same actions.
	 */
	import { Modal } from '$lib/components/ui';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	const groups = [
		{
			title: 'Editing',
			items: [
				{ keys: ['Cmd / Ctrl', 'Z'], label: 'Undo' },
				{ keys: ['Cmd / Ctrl', 'Shift', 'Z'], label: 'Redo' },
				{ keys: ['Cmd / Ctrl', 'D'], label: 'Duplicate selected' },
				// Cmd/Ctrl+S blurs the active element before saving so any
				// property-panel input that commits on `change` (X/Y/W/H,
				// font size, etc.) flushes its pending value into Fabric
				// before serialize. Worth surfacing because "save"
				// otherwise feels surprising when an input is focused.
				{ keys: ['Cmd / Ctrl', 'S'], label: 'Save (flushes input + auto-saves)' },
				{ keys: ['Delete'], label: 'Delete selected' }
			]
		},
		{
			title: 'Selection',
			items: [
				{ keys: ['Esc'], label: 'Deselect' },
				{ keys: ['Arrow keys'], label: 'Nudge selected by 1px' },
				{ keys: ['Shift', 'Arrow keys'], label: 'Nudge selected by 10px' }
			]
		},
		{
			title: 'Layer order',
			items: [
				{ keys: ['Cmd / Ctrl', ']'], label: 'Bring forward' },
				{ keys: ['Cmd / Ctrl', '['], label: 'Send backward' },
				{ keys: ['Cmd / Ctrl', 'Shift', ']'], label: 'Bring to front' },
				{ keys: ['Cmd / Ctrl', 'Shift', '['], label: 'Send to back' }
			]
		},
		{
			// TASK-133 — Alt+Shift was chosen because it's unbound on
			// Chrome/Firefox/Safari across macOS/Windows/Linux. Align
			// requires 2+ selected objects; distribute requires 3+
			// (matches the toolbar's gating).
			title: 'Alignment',
			items: [
				{ keys: ['Alt', 'Shift', 'L'], label: 'Align left' },
				{ keys: ['Alt', 'Shift', 'C'], label: 'Align horizontal center' },
				{ keys: ['Alt', 'Shift', 'R'], label: 'Align right' },
				{ keys: ['Alt', 'Shift', 'T'], label: 'Align top' },
				{ keys: ['Alt', 'Shift', 'M'], label: 'Align vertical center' },
				{ keys: ['Alt', 'Shift', 'B'], label: 'Align bottom' },
				{ keys: ['Alt', 'Shift', 'H'], label: 'Distribute horizontally' },
				{ keys: ['Alt', 'Shift', 'V'], label: 'Distribute vertically' }
			]
		},
		{
			title: 'Help',
			items: [{ keys: ['?'], label: 'Open this cheatsheet' }]
		}
	];
</script>

<Modal {open} title="Keyboard shortcuts" {onClose} width="32rem">
	{#each groups as group (group.title)}
		<section class="group">
			<h3>{group.title}</h3>
			<ul>
				{#each group.items as item (item.label)}
					<li>
						<span class="keys">
							{#each item.keys as key, i (i)}
								<kbd>{key}</kbd>
								{#if i < item.keys.length - 1}<span class="plus">+</span>{/if}
							{/each}
						</span>
						<span class="label">{item.label}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
	<p class="note">Shortcuts are inactive while typing in an input or editing text on the canvas.</p>
</Modal>

<style>
	.group {
		margin-bottom: 1rem;
	}

	.group h3 {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-subtle);
	}

	.group ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem 1rem;
	}

	.group li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		font-size: 0.9rem;
	}

	.keys {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		flex-shrink: 0;
	}

	.plus {
		color: var(--color-text-subtle);
		font-size: 0.75rem;
	}

	kbd {
		display: inline-block;
		padding: 0.1rem 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-text);
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border-strong);
		border-bottom-width: 2px;
		border-radius: 4px;
	}

	.label {
		color: var(--color-text-muted);
		text-align: right;
	}

	.note {
		margin: 1rem 0 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-surface-muted);
		font-size: 0.8rem;
		color: var(--color-text-subtle);
	}
</style>
