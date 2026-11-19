<script lang="ts">
	// One labelled field: the label over its control. Every form uses it, so a label reads the same
	// on create, edit and in a dialog. Required is a quiet mark, not red: red is for errors.
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
	<Label for={forId}>
		<span
			>{label}{#if required}<span class="text-muted-foreground" aria-hidden="true">*</span
				>{/if}</span
		>
	</Label>
	{@render children()}
	{#if hint}<p class="text-xs text-muted-foreground">{hint}</p>{/if}
</div>
