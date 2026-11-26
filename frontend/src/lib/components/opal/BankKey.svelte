<script lang="ts">
	// One key in a KeyBank. The bank draws the border and shadow; the key only fills on hover.
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';

	let {
		class: className,
		children,
		...rest
	}: {
		class?: string;
		children: Snippet;
		// onclick, title, aria-*, disabled, draggable and the props a picker trigger passes.
		[key: string]: unknown;
	} = $props();
</script>

<button
	type="button"
	class={cn(
		'inline-flex h-6 min-w-6 items-center justify-center px-2 font-mono text-xs font-medium whitespace-nowrap text-inherit outline-none hover:bg-accent hover:text-foreground focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40',
		className
	)}
	{...rest}>{@render children()}</button
>
