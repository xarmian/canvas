<script lang="ts">
	import type { FabricObject } from 'fabric';
	import {
		fabricCanvas,
		selectedObject,
		objects,
		syncObjects,
		setSelectedObject
	} from './state.svelte.ts';

	function getIcon(obj: FabricObject): string {
		const t = obj.type;
		if (t === 'IText' || t === 'Textbox') return '📝';
		if (t === 'FabricImage') return '🖼️';
		return '▪️';
	}

	function getLabel(obj: FabricObject): string {
		const t = obj.type;
		if (t === 'IText' || t === 'Textbox') {
			const text = obj.get('text') as string;
			return text.length > 20 ? text.slice(0, 20) + '…' : text;
		}
		if (t === 'FabricImage') return 'Image';
		if (t === 'Rect') return 'Rectangle';
		return t ?? 'Object';
	}

	function selectLayer(obj: FabricObject) {
		if (!fabricCanvas) return;
		fabricCanvas.setActiveObject(obj);
		setSelectedObject(obj);
		fabricCanvas.renderAll();
	}

	function toggleVisibility(obj: FabricObject) {
		if (!fabricCanvas) return;
		obj.visible = !obj.visible;
		fabricCanvas.renderAll();
	}

	function toggleLock(obj: FabricObject) {
		if (!fabricCanvas) return;
		const locked = !obj.selectable;
		obj.selectable = locked;
		obj.evented = locked;
		fabricCanvas.renderAll();
	}

	function moveUp(obj: FabricObject) {
		if (!fabricCanvas) return;
		fabricCanvas.bringObjectForward(obj);
		syncObjects();
		fabricCanvas.renderAll();
	}

	function moveDown(obj: FabricObject) {
		if (!fabricCanvas) return;
		fabricCanvas.sendObjectBackwards(obj);
		syncObjects();
		fabricCanvas.renderAll();
	}

	let reversed = $derived([...objects].reverse());
</script>

<aside class="layer-panel">
	<header class="panel-header">
		<h3>Layers</h3>
		<span class="count">{objects.length}</span>
	</header>

	<div class="layer-list" role="listbox" aria-label="Canvas layers">
		{#each reversed as obj (obj)}
			<div
				class="layer-row"
				class:selected={selectedObject === obj}
				onclick={() => selectLayer(obj)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') selectLayer(obj);
				}}
				tabindex="0"
				role="option"
				aria-selected={selectedObject === obj}
			>
				<span class="icon">{getIcon(obj)}</span>
				<span class="label">{getLabel(obj)}</span>

				<span class="actions">
					<button
						class="action-btn"
						title={obj.visible ? 'Hide' : 'Show'}
						onclick={(e) => {
							e.stopPropagation();
							toggleVisibility(obj);
						}}
					>
						{obj.visible ? '👁️' : '👁️‍🗨️'}
					</button>

					<button
						class="action-btn"
						title={obj.selectable ? 'Lock' : 'Unlock'}
						onclick={(e) => {
							e.stopPropagation();
							toggleLock(obj);
						}}
					>
						{obj.selectable ? '🔓' : '🔒'}
					</button>

					<button
						class="action-btn"
						title="Move up"
						onclick={(e) => {
							e.stopPropagation();
							moveUp(obj);
						}}
					>
						▲
					</button>

					<button
						class="action-btn"
						title="Move down"
						onclick={(e) => {
							e.stopPropagation();
							moveDown(obj);
						}}
					>
						▼
					</button>
				</span>
			</div>
		{/each}
	</div>
</aside>

<style>
	.layer-panel {
		width: 240px;
		min-width: 240px;
		height: 100%;
		display: flex;
		flex-direction: column;
		border-left: 1px solid #ddd;
		background: #fafafa;
		font-family: system-ui, sans-serif;
		font-size: 13px;
		overflow: hidden;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-bottom: 1px solid #ddd;
	}

	.panel-header h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.count {
		background: #e0e0e0;
		border-radius: 10px;
		padding: 1px 8px;
		font-size: 11px;
		color: #555;
	}

	.layer-list {
		flex: 1;
		overflow-y: auto;
	}

	.layer-row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		border: none;
		border-bottom: 1px solid #eee;
		background: transparent;
		cursor: pointer;
		text-align: left;
		font: inherit;
		color: inherit;
	}

	.layer-row:hover {
		background: #f0f0f0;
	}

	.layer-row.selected {
		background: #d4e4ff;
	}

	.icon {
		flex-shrink: 0;
		width: 20px;
		text-align: center;
	}

	.label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.actions {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}

	.action-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 3px;
		font-size: 12px;
		line-height: 1;
		border-radius: 3px;
		opacity: 0.6;
	}

	.action-btn:hover {
		opacity: 1;
		background: #ddd;
	}
</style>
