<script lang="ts">
	let { children } = $props();
</script>

<!--
	Auth pages (login/signup) ship without a nav, so a skip-link isn't
	useful here — there's nothing to skip past before the form. The
	<main> landmark still benefits screen-reader landmark navigation
	(NVDA/VoiceOver "go to main") which is why we wrap children in it
	rather than the bare <div> we had previously. TASK-145.
-->
<main id="main-content" tabindex="-1">
	{@render children()}
</main>

<style>
	main:focus {
		outline: none;
	}
</style>
