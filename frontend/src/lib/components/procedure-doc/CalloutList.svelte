<script lang="ts">
	// A step's callouts as a vertical stack, in author order.
	import CalloutBlock from './CalloutBlock.svelte';
	import type { Callout } from './types.js';

	let { callouts }: { callouts: Callout[] } = $props();
</script>

{#if callouts.length}
	<div class="grid grid-cols-1 gap-2">
		{#each callouts as c, i (i)}<CalloutBlock callout={c} />{/each}
	</div>
{/if}
