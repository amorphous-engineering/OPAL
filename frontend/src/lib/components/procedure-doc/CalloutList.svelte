<script lang="ts">
	// A step's callouts as a tight stack: warnings, then cautions, then notes, as procedures order
	// them, and in author order within each.
	import CalloutBlock from './CalloutBlock.svelte';
	import { orderCallouts } from './callouts.js';
	import type { Callout } from './types.js';

	let { callouts }: { callouts: Callout[] } = $props();
	const ordered = $derived(orderCallouts(callouts));
</script>

{#if ordered.length}
	<div class="grid grid-cols-1 gap-1.5">
		{#each ordered as c, i (i)}<CalloutBlock callout={c} />{/each}
	</div>
{/if}
