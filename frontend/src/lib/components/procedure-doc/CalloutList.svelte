<script lang="ts">
	// A step's callouts as a tight stack: cautions before notes, as procedures order them, and in
	// author order within each.
	import CalloutBlock from './CalloutBlock.svelte';
	import type { Callout } from './types.js';

	let { callouts }: { callouts: Callout[] } = $props();
	const ordered = $derived(
		[...callouts].sort((a, b) => Number(a.kind !== 'caution') - Number(b.kind !== 'caution'))
	);
</script>

{#if ordered.length}
	<div class="grid grid-cols-1 gap-1.5">
		{#each ordered as c, i (i)}<CalloutBlock callout={c} />{/each}
	</div>
{/if}
