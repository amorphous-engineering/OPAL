<script lang="ts">
	import { lightbox } from './lightbox.svelte.js';

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && lightbox.src) {
			e.preventDefault();
			lightbox.close();
		}
	}
</script>

<svelte:window {onkeydown} />

{#if lightbox.src}
	<div
		class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/85 p-6"
		role="dialog"
		aria-modal="true"
		aria-label="Image"
		tabindex="-1"
		onclick={() => lightbox.close()}
		onkeydown={(e) => e.key === 'Enter' && lightbox.close()}
	>
		<img
			src={lightbox.src}
			alt={lightbox.caption ?? 'Reference image'}
			class="max-h-[88vh] max-w-full border border-border object-contain"
		/>
		{#if lightbox.caption}
			<div class="font-mono text-xs text-white/80">{lightbox.caption}</div>
		{/if}
	</div>
{/if}
