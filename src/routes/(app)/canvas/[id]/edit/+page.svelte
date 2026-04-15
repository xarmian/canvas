<script lang="ts">
	let { data } = $props();
</script>

<svelte:head>
	<title>Edit: {data.canvas.name} | Canvas</title>
</svelte:head>

<div style="padding: 2rem;">
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;"
	>
		<h1 style="margin: 0;">{data.canvas.name}</h1>
		<div style="display: flex; gap: 0.5rem; align-items: center;">
			<span style="color: {data.canvas.published ? '#16a34a' : '#9ca3af'}; font-size: 0.875rem;">
				{data.canvas.published ? 'Published' : 'Draft'}
			</span>
			<span style="color: #9ca3af; font-size: 0.875rem;">
				{data.canvas.width} × {data.canvas.height}
			</span>
		</div>
	</div>

	<p style="color: #6b7280;">
		The Fabric.js editor will be built here in TASK-11. Canvas ID: <code>{data.canvas.id}</code>
	</p>

	<a href="/" style="color: #2563eb;">← Back to dashboard</a>
</div>
