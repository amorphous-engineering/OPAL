<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let {
		label,
		value,
		mono = false,
		children
	}: {
		label: string;
		value?: string | number | null;
		mono?: boolean;
		children?: Snippet;
	} = $props();

	const empty = $derived(!children && (value === null || value === undefined || value === ''));
</script>

<tr class="border-b border-border last:border-b-0">
	<th
		scope="row"
		class="w-40 py-1.5 pr-3 pl-3 text-left align-top font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
		>{label}</th
	>
	<td
		class={cn(
			'py-1.5 pr-3 align-top',
			mono && 'font-mono tabular-nums',
			empty && 'text-muted-foreground'
		)}
	>
		{#if children}{@render children()}{:else if empty}—{:else}{value}{/if}
	</td>
</tr>
