<script lang="ts">
	// Facts as detail rows. Absence is a muted dash, never an omitted row.
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let { children, class: className }: { children: Snippet; class?: string } = $props();
</script>

<table class={cn('w-full border-collapse text-sm', className)}>
	<tbody>{@render children()}</tbody>
</table>
