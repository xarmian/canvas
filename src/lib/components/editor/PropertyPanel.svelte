<script lang="ts">
	import type { FabricObject } from 'fabric';
	import { selectedObject, fabricCanvas, markDirty } from './state.svelte.ts';

	// --- Derived properties from the selected object ---

	let objType = $derived(selectedObject?.type?.toLowerCase() ?? '');
	let isText = $derived(
		objType === 'i-text' || objType === 'itext' || objType === 'textbox' || objType === 'text'
	);
	let isImage = $derived(objType === 'image' || objType === 'fabricimage');

	// Position (scale-aware: displayed dimensions = intrinsic × scale)
	let posX = $derived((selectedObject?.get('left') as number) ?? 0);
	let posY = $derived((selectedObject?.get('top') as number) ?? 0);
	let scaleX = $derived((selectedObject?.get('scaleX') as number) ?? 1);
	let scaleY = $derived((selectedObject?.get('scaleY') as number) ?? 1);
	let objWidth = $derived(((selectedObject?.get('width') as number) ?? 0) * scaleX);
	let objHeight = $derived(((selectedObject?.get('height') as number) ?? 0) * scaleY);
	let angle = $derived((selectedObject?.get('angle') as number) ?? 0);
	let opacity = $derived((selectedObject?.get('opacity') as number) ?? 1);

	// Text
	let text = $derived((selectedObject?.get('text') as string) ?? '');
	let fontFamily = $derived((selectedObject?.get('fontFamily') as string) ?? 'Inter');
	let fontSize = $derived((selectedObject?.get('fontSize') as number) ?? 24);
	let fontWeight = $derived((selectedObject?.get('fontWeight') as number) ?? 400);
	let fill = $derived((selectedObject?.get('fill') as string) ?? '#000000');
	let textAlign = $derived((selectedObject?.get('textAlign') as string) ?? 'left');

	// Image
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let imageSrc = $derived(isImage ? ((selectedObject as any)?.getSrc?.() ?? '') : '');

	// Parameter bindings
	let paramBindings: Record<string, { param: string; default: string }> = $derived(
		(selectedObject?.get('paramBindings') as Record<string, { param: string; default: string }>) ??
			{}
	);

	let bindingsExpanded = $state(false);

	// --- Helpers ---

	function setProp(prop: string, value: unknown) {
		if (!selectedObject || !fabricCanvas) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		selectedObject.set(prop as keyof FabricObject, value as any);
		fabricCanvas.renderAll();
		markDirty();
	}

	/** Set width/height accounting for scale — resets scale to 1 and sets intrinsic dimension */
	function setDimension(prop: 'width' | 'height', displayValue: number) {
		if (!selectedObject || !fabricCanvas) return;
		const scaleProp = prop === 'width' ? 'scaleX' : 'scaleY';
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		selectedObject.set(prop as any, displayValue);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		selectedObject.set(scaleProp as any, 1);
		selectedObject.setCoords();
		fabricCanvas.renderAll();
		markDirty();
	}

	function setBinding(property: string, field: 'param' | 'default', value: string) {
		if (!selectedObject) return;
		const current = { ...paramBindings };
		if (!current[property]) {
			current[property] = { param: '', default: '' };
		}
		current[property] = { ...current[property], [field]: value };
		setProp('paramBindings', current);
	}

	function toggleBinding(property: string) {
		if (!selectedObject) return;
		const current = { ...paramBindings };
		if (current[property]) {
			delete current[property];
		} else {
			current[property] = { param: property, default: '' };
		}
		setProp('paramBindings', current);
	}

	/** Bindable properties depend on the object type */
	let bindableProperties = $derived.by(() => {
		const props: { key: string; label: string }[] = [];
		if (isText) {
			props.push({ key: 'text', label: 'Text Content' });
		}
		if (isImage) {
			props.push({ key: 'src', label: 'Image Source' });
		}
		props.push({ key: 'fill', label: 'Fill Color' });
		return props;
	});
</script>

<aside class="property-panel">
	{#if !selectedObject}
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
			<!-- Position Section -->
			<section class="section">
				<h4 class="section-title">Position</h4>

				<div class="field-row">
					<label class="field-label" for="prop-x">X</label>
					<input
						id="prop-x"
						type="number"
						class="field-input"
						value={Math.round(posX)}
						onchange={(e) => setProp('left', Number(e.currentTarget.value))}
					/>
				</div>

				<div class="field-row">
					<label class="field-label" for="prop-y">Y</label>
					<input
						id="prop-y"
						type="number"
						class="field-input"
						value={Math.round(posY)}
						onchange={(e) => setProp('top', Number(e.currentTarget.value))}
					/>
				</div>

				<div class="field-row">
					<label class="field-label" for="prop-w">Width</label>
					<input
						id="prop-w"
						type="number"
						class="field-input"
						value={Math.round(objWidth)}
						onchange={(e) => setDimension('width', Number(e.currentTarget.value))}
					/>
				</div>

				<div class="field-row">
					<label class="field-label" for="prop-h">Height</label>
					<input
						id="prop-h"
						type="number"
						class="field-input"
						value={Math.round(objHeight)}
						onchange={(e) => setDimension('height', Number(e.currentTarget.value))}
					/>
				</div>

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

				<div class="field-row">
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
				</div>
			</section>

			<!-- Text Section -->
			{#if isText}
				<section class="section">
					<h4 class="section-title">Text</h4>

					<div class="field-row field-col">
						<label class="field-label" for="prop-text">Content</label>
						<textarea
							id="prop-text"
							class="field-textarea"
							rows="3"
							value={text}
							oninput={(e) => setProp('text', e.currentTarget.value)}
						></textarea>
					</div>

					<div class="field-row">
						<label class="field-label" for="prop-font">Font</label>
						<select
							id="prop-font"
							class="field-select"
							value={fontFamily}
							onchange={(e) => setProp('fontFamily', e.currentTarget.value)}
						>
							<option value="Inter">Inter</option>
							<option value="Arial">Arial</option>
							<option value="Georgia">Georgia</option>
							<option value="Courier New">Courier New</option>
							<option value="Times New Roman">Times New Roman</option>
						</select>
					</div>

					<div class="field-row">
						<label class="field-label" for="prop-fontsize">Size</label>
						<input
							id="prop-fontsize"
							type="number"
							class="field-input"
							min="1"
							value={fontSize}
							onchange={(e) => setProp('fontSize', Number(e.currentTarget.value))}
						/>
					</div>

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

					<div class="field-row">
						<label class="field-label" for="prop-fill">Color</label>
						<input
							id="prop-fill"
							type="color"
							class="field-color"
							value={fill}
							oninput={(e) => setProp('fill', e.currentTarget.value)}
						/>
					</div>

					<div class="field-row">
						<span class="field-label">Align</span>
						<div class="btn-group" role="group" aria-label="Text alignment">
							<button
								class="btn-group-item"
								class:active={textAlign === 'left'}
								onclick={() => setProp('textAlign', 'left')}
								title="Align left">L</button
							>
							<button
								class="btn-group-item"
								class:active={textAlign === 'center'}
								onclick={() => setProp('textAlign', 'center')}
								title="Align center">C</button
							>
							<button
								class="btn-group-item"
								class:active={textAlign === 'right'}
								onclick={() => setProp('textAlign', 'right')}
								title="Align right">R</button
							>
						</div>
					</div>
				</section>
			{/if}

			<!-- Image Section -->
			{#if isImage}
				<section class="section">
					<h4 class="section-title">Image</h4>

					<div class="field-row field-col">
						<label class="field-label" for="prop-src">Source URL</label>
						<input id="prop-src" type="text" class="field-input" value={imageSrc} readonly />
					</div>
				</section>
			{/if}

			<!-- Parameter Binding Section -->
			<section class="section">
				<button
					class="section-title collapsible"
					onclick={() => (bindingsExpanded = !bindingsExpanded)}
				>
					<span>Dynamic Parameters</span>
					<span class="chevron" class:open={bindingsExpanded}>&#9654;</span>
				</button>

				{#if bindingsExpanded}
					<div class="bindings-list">
						{#each bindableProperties as prop (prop.key)}
							{@const bound = paramBindings[prop.key]}
							<div class="binding-row">
								<div class="binding-header">
									<span class="binding-label">{prop.label}</span>
									<button
										class="binding-toggle"
										class:active={!!bound}
										onclick={() => toggleBinding(prop.key)}
										title={bound ? 'Remove binding' : 'Add binding'}>&#9889;</button
									>
								</div>

								{#if bound}
									<div class="binding-fields">
										<div class="field-row">
											<label class="field-label small" for="bind-{prop.key}-param">Param</label>
											<input
												id="bind-{prop.key}-param"
												type="text"
												class="field-input"
												value={bound.param}
												oninput={(e) => setBinding(prop.key, 'param', e.currentTarget.value)}
												placeholder="parameter name"
											/>
										</div>
										<div class="field-row">
											<label class="field-label small" for="bind-{prop.key}-default">Default</label>
											<input
												id="bind-{prop.key}-default"
												type="text"
												class="field-input"
												value={bound.default}
												oninput={(e) => setBinding(prop.key, 'default', e.currentTarget.value)}
												placeholder="default value"
											/>
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
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
		border-left: 1px solid #ddd;
		background: #fafafa;
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
		color: #999;
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
		color: #bbb;
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

	.type-badge {
		background: #e0e0e0;
		border-radius: 10px;
		padding: 1px 8px;
		font-size: 11px;
		color: #555;
	}

	.sections {
		flex: 1;
		overflow-y: auto;
		padding-bottom: 12px;
	}

	.section {
		border-bottom: 1px solid #eee;
		padding: 10px 12px;
	}

	.section-title {
		margin: 0 0 8px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #777;
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
		font-size: 10px;
		transition: transform 0.15s ease;
		color: #999;
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
		color: #666;
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
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		background: #fff;
	}

	.field-input:focus {
		outline: none;
		border-color: #5b9bd5;
		box-shadow: 0 0 0 2px rgba(91, 155, 213, 0.2);
	}

	.field-input[readonly] {
		background: #f0f0f0;
		color: #888;
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
		color: #888;
	}

	.field-range {
		flex: 1;
		min-width: 0;
	}

	.range-value {
		width: 36px;
		text-align: right;
		font-size: 11px;
		color: #888;
	}

	.field-textarea {
		width: 100%;
		padding: 4px 6px;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		resize: vertical;
		background: #fff;
		box-sizing: border-box;
	}

	.field-textarea:focus {
		outline: none;
		border-color: #5b9bd5;
		box-shadow: 0 0 0 2px rgba(91, 155, 213, 0.2);
	}

	.field-select {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
		border: 1px solid #ccc;
		border-radius: 4px;
		font-size: 12px;
		font-family: inherit;
		background: #fff;
	}

	.field-select:focus {
		outline: none;
		border-color: #5b9bd5;
		box-shadow: 0 0 0 2px rgba(91, 155, 213, 0.2);
	}

	.field-color {
		width: 32px;
		height: 28px;
		padding: 2px;
		border: 1px solid #ccc;
		border-radius: 4px;
		cursor: pointer;
		background: #fff;
	}

	.btn-group {
		display: flex;
		border: 1px solid #ccc;
		border-radius: 4px;
		overflow: hidden;
	}

	.btn-group-item {
		padding: 4px 10px;
		border: none;
		border-right: 1px solid #ccc;
		background: #fff;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
		color: #666;
	}

	.btn-group-item:last-child {
		border-right: none;
	}

	.btn-group-item:hover {
		background: #f0f0f0;
	}

	.btn-group-item.active {
		background: #d4e4ff;
		color: #333;
	}

	.bindings-list {
		margin-top: 8px;
	}

	.binding-row {
		margin-bottom: 10px;
		padding: 8px;
		background: #f5f5f5;
		border-radius: 4px;
		border: 1px solid #eee;
	}

	.binding-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.binding-label {
		font-size: 12px;
		font-weight: 500;
		color: #555;
	}

	.binding-toggle {
		background: none;
		border: 1px solid #ccc;
		border-radius: 4px;
		padding: 2px 6px;
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
		color: #999;
	}

	.binding-toggle.active {
		background: #fff3cd;
		border-color: #ffc107;
		color: #856404;
	}

	.binding-fields {
		margin-top: 6px;
	}
</style>
