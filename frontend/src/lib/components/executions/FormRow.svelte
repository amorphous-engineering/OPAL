<script lang="ts">
	// A labelled form row: register label over the control.
	import type { Snippet } from 'svelte';

	let {
		label,
		for: forId,
		required = false,
		hint,
		children
	}: {
		label: string;
		for?: string;
		required?: boolean;
		hint?: string;
		children: Snippet;
	} = $props();
</script>

<div class="grid content-start gap-1">
	<label class="label" for={forId}
		>{label}{#if required}<span class="text-error"> *</span>{/if}</label
	>
	{@render children()}
	{#if hint}<p class="text-[11px] text-muted-foreground">{hint}</p>{/if}
</div>
