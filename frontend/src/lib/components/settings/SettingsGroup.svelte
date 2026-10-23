<script lang="ts">
	// One settings area: an anchor, a ruled heading, and its panels stacked in one column.
	import type { Snippet } from 'svelte';

	let { id, title, children }: { id: string; title: string; children: Snippet } = $props();
</script>

<div {id} class="grid scroll-mt-4 grid-cols-1 gap-4">
	<h2 class="border-b border-border pb-1 text-lg font-semibold tracking-tight">{title}</h2>
	{@render children()}
</div>
