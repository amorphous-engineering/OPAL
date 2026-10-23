<script lang="ts">
	// Label over control. Labels are nouns (register: mono caps).
	import type { Snippet } from 'svelte';
	import { Label } from '#lib/components/ui/label/index.js';
	import { cn } from '#lib/utils.js';

	let {
		label,
		for: forId,
		required = false,
		hint,
		class: className,
		children
	}: {
		label: string;
		for?: string;
		required?: boolean;
		hint?: string | null;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<div class={cn('grid min-w-0 content-start gap-1.5', className)}>
	<Label for={forId} class="label">
		{label}{#if required}<span class="text-error" aria-hidden="true">*</span>{/if}
	</Label>
	{@render children()}
	{#if hint}<p class="font-mono text-xs text-muted-foreground">{hint}</p>{/if}
</div>
