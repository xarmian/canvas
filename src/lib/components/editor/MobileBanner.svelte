<script lang="ts">
	import { Monitor } from '@lucide/svelte';

	/** Session-storage key so "Continue anyway" persists for the tab but not
	 * across full browser restarts. */
	const DISMISS_KEY = 'canvas.editor-mobile-banner-dismissed';
	/** Editor layout assumes >= this viewport width; below, side panels
	 * collapse or overlap the canvas. */
	const MIN_DESKTOP_WIDTH = 1024;

	/** Reads sessionStorage defensively. Strict-privacy modes and some
	 * sandboxed iframes throw SecurityError on access itself (not just on
	 * setItem), which would blow up component setup and break the editor
	 * page before the banner ever rendered. Return false on any failure —
	 * worst case the banner appears again on a refresh. */
	function readDismissed(): boolean {
		if (typeof window === 'undefined') return false;
		try {
			return window.sessionStorage.getItem(DISMISS_KEY) === '1';
		} catch {
			return false;
		}
	}

	let viewportWidth = $state<number>(typeof window !== 'undefined' ? window.innerWidth : Infinity);
	let dismissed = $state<boolean>(readDismissed());

	$effect(() => {
		function onResize() {
			viewportWidth = window.innerWidth;
		}
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	});

	let visible = $derived(!dismissed && viewportWidth < MIN_DESKTOP_WIDTH);

	function dismiss() {
		dismissed = true;
		try {
			sessionStorage.setItem(DISMISS_KEY, '1');
		} catch {
			// Private mode / storage disabled — the in-memory flag still works for
			// the session; just skip persistence.
		}
	}
</script>

{#if visible}
	<div class="overlay" role="dialog" aria-labelledby="mobile-banner-title" aria-modal="true">
		<div class="banner">
			<div class="icon" aria-hidden="true">
				<Monitor size={44} strokeWidth={1.8} />
			</div>
			<h2 id="mobile-banner-title" class="title">The editor works best on a larger screen</h2>
			<p class="lede">
				Canvas's drag-and-drop editor is built for desktop — side panels, precise pointer work, and
				the full toolbar don't fit well below about 1024 pixels wide. You can still continue if you
				know what you're doing.
			</p>
			<div class="actions">
				<a href="/" class="btn btn-primary">Back to dashboard</a>
				<button type="button" class="btn btn-secondary" onclick={dismiss}> Continue anyway </button>
			</div>
			<p class="hint">
				Published canvases and share URLs work perfectly on mobile — this only affects the
				design-time editor.
			</p>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 10000;
		background: rgba(15, 23, 42, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}

	.banner {
		background: #fff;
		border-radius: 12px;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
		max-width: 28rem;
		padding: 1.5rem 1.25rem;
		text-align: center;
		color: #1e293b;
	}

	.icon {
		display: flex;
		justify-content: center;
		margin-bottom: 0.75rem;
		color: #2563eb;
	}

	.title {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
		font-weight: 700;
		color: #0f172a;
	}

	.lede {
		margin: 0 0 1rem;
		font-size: 0.9rem;
		line-height: 1.55;
		color: #475569;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.btn {
		padding: 0.5rem 1rem;
		border-radius: 6px;
		font-size: 0.875rem;
		font-weight: 500;
		border: 1px solid transparent;
		cursor: pointer;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}

	.btn-primary {
		background: #2563eb;
		color: #fff;
	}

	.btn-primary:hover {
		background: #1d4ed8;
	}

	.btn-secondary {
		background: #fff;
		color: #374151;
		border-color: #d1d5db;
	}

	.btn-secondary:hover {
		background: #f3f4f6;
	}

	.hint {
		margin: 0;
		font-size: 0.75rem;
		color: #94a3b8;
		line-height: 1.45;
	}
</style>
