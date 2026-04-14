<script lang="ts">
	let { children } = $props();
</script>

<!-- TODO: Add auth guard + app shell (sidebar, nav) -->
{@render children()}
