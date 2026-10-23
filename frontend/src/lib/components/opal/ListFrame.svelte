<script lang="ts">
	// The list grammar: a bordered panel holding filter bar, table and pager in one
	// frame, padded off the viewport edge. The parts list is the reference.
	import type { Snippet } from 'svelte';
	import { provideFrame } from './frame.js';

	let { children }: { children: Snippet } = $props();
	provideFrame();
</script>

<div class="p-4">
	<div class="overflow-hidden rounded-lg border border-border bg-card">{@render children()}</div>
</div>
