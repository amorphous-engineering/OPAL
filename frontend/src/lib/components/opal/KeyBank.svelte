<script lang="ts">
	// A bank: related small keys under one border and one shadow, like a row of switches on a
	// panel. `lead` names the bank (ADD) and cannot be pressed. A quiet bank (row tools) stays
	// flat and grey until its row is hovered or holds the focus.
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let {
		lead,
		label,
		quiet = false,
		class: className,
		children
	}: {
		lead?: string;
		/** Accessible name of the group. */
		label: string;
		quiet?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div
	role="group"
	aria-label={label}
	data-key-bank
	class={cn(
		'inline-flex max-w-full shrink-0 flex-wrap items-stretch border bg-background',
		'[&>*+*]:border-l [&>*+*]:border-inherit',
		quiet
			? 'border-transparent text-muted-foreground group-focus-within/row:border-border group-focus-within/row:text-foreground group-focus-within/row:shadow-key2 group-hover/row:border-border group-hover/row:text-foreground group-hover/row:shadow-key2'
			: 'border-border shadow-key2',
		className
	)}
>
	{#if lead}
		<span
			class="flex h-6 items-center bg-muted px-2 font-mono text-xs font-semibold tracking-wider text-muted-foreground"
			>{lead}</span
		>
	{/if}
	{@render children()}
</div>
