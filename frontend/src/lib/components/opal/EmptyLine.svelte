<script lang="ts">
	// An empty table keeps its table's shape: the panel header (title, add action) over
	// one line saying it is empty. Inside a panel that already has the header (a Section or
	// a list frame), only the line.
	import type { Snippet } from 'svelte';
	import { inFrame } from './frame.js';
	import Section from './Section.svelte';

	let {
		label,
		empty,
		onadd,
		addHref,
		addLabel = '+ ADD',
		action
	}: {
		label: string;
		/** The empty sentence; default "No <label>." */
		empty?: string;
		onadd?: () => void;
		addHref?: string;
		addLabel?: string;
		action?: Snippet;
	} = $props();

	const framed = inFrame();
	const ACRONYMS = new Set(['bom', 'po', 'wo', 'op', 'nc', 'opal', 'pn']);
	const sentence = $derived(
		empty ??
			`No ${label
				.split(/\s+/)
				.map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()))
				.join(' ')}.`
	);
	const hasAdd = $derived(!!action || !!addHref || !!onadd);
</script>

{#snippet add()}
	{#if action}
		{@render action()}
	{:else if addHref}
		<a
			href={addHref}
			class="font-mono text-xs font-medium tracking-wider text-info uppercase hover:underline"
			>{addLabel}</a
		>
	{:else if onadd}
		<button
			type="button"
			class="font-mono text-xs font-medium tracking-wider text-info uppercase hover:underline"
			onclick={onadd}>{addLabel}</button
		>
	{/if}
{/snippet}

{#if framed}
	<div class="flex min-h-8 items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground">
		<span>{sentence}</span>
		{#if hasAdd}<span class="ml-auto">{@render add()}</span>{/if}
	</div>
{:else}
	<Section title={label}>
		{#snippet actions()}{@render add()}{/snippet}
		<div class="px-3 py-2 text-sm text-muted-foreground">{sentence}</div>
	</Section>
{/if}
