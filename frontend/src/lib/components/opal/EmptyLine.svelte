<script lang="ts">
	// The empty-state rule: an empty relevant section is ONE line —
	// `LABEL — none · + ADD`. Never a header over an empty box, never narration.
	import type { Snippet } from 'svelte';

	let {
		label,
		onadd,
		addHref,
		addLabel = '+ ADD',
		action
	}: {
		label: string;
		onadd?: () => void;
		addHref?: string;
		addLabel?: string;
		action?: Snippet;
	} = $props();
</script>

<div class="flex h-8 items-center gap-2 border-b border-border px-3 font-mono text-xs">
	<span class="font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
	<span class="text-muted-foreground">— none</span>
	{#if action}
		<span class="text-muted-foreground">·</span>{@render action()}
	{:else if addHref}
		<span class="text-muted-foreground">·</span>
		<a href={addHref} class="font-medium text-info hover:underline">{addLabel}</a>
	{:else if onadd}
		<span class="text-muted-foreground">·</span>
		<button type="button" class="font-medium text-info hover:underline" onclick={onadd}
			>{addLabel}</button
		>
	{/if}
</div>
