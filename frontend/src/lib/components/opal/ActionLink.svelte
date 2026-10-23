<script lang="ts">
	// Text action in a header bar or row: accent = action (register rule 3).
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		href,
		onclick,
		disabled = false,
		danger = false,
		title,
		class: className,
		children
	}: {
		href?: string;
		onclick?: () => void;
		disabled?: boolean;
		danger?: boolean;
		title?: string;
		class?: string;
		children: Snippet;
	} = $props();

	const cls = $derived(
		cn(
			'font-mono text-xs font-medium tracking-wide whitespace-nowrap hover:underline disabled:pointer-events-none disabled:opacity-40',
			danger ? 'text-error' : 'text-info',
			className
		)
	);
</script>

{#if href}
	<a {href} {title} class={cls}>{@render children()}</a>
{:else}
	<Button variant="link" {onclick} {disabled} {title} class={cn('h-auto border-0 p-0', cls)}
		>{@render children()}</Button
	>
{/if}
