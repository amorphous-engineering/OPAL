<script lang="ts">
	// Text action in a header bar or row: accent = action. Keys carry a shadow; this does not.
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		href,
		disabled = false,
		class: className,
		children,
		...rest
	}: {
		href?: string;
		disabled?: boolean;
		class?: string;
		children: Snippet;
		// Anything else a link or trigger passes through: onclick, title, target, aria-*.
		[key: string]: unknown;
	} = $props();

	const cls = $derived(
		cn(
			'inline-flex h-6 items-center font-mono text-xs font-medium tracking-wide whitespace-nowrap text-info hover:underline disabled:pointer-events-none disabled:opacity-40',
			className
		)
	);
</script>

{#if href}
	<a {href} class={cls} {...rest}>{@render children()}</a>
{:else}
	<Button variant="link" {disabled} class={cn('border-0 p-0', cls)} {...rest}
		>{@render children()}</Button
	>
{/if}
