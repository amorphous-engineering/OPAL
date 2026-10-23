<script lang="ts">
	// Structure: a panel with a header bar (label, count, actions) over its body.
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.js';
	import { provideFrame } from './frame.js';

	let {
		title,
		count,
		actions,
		children,
		class: className,
		id
	}: {
		title: string;
		count?: number | string;
		actions?: Snippet;
		children: Snippet;
		class?: string;
		id?: string;
	} = $props();

	// Children render inside this panel's frame (an empty table is only its line).
	provideFrame();
</script>

<section {id} class={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
	<header class="flex h-8 items-center gap-2 border-b border-border bg-muted/60 px-3">
		<h2 class="label text-foreground">{title}</h2>
		{#if count !== undefined}<span class="mono text-xs text-muted-foreground">{count}</span>{/if}
		<div class="ml-auto flex items-center gap-1">{@render actions?.()}</div>
	</header>
	{@render children()}
</section>
