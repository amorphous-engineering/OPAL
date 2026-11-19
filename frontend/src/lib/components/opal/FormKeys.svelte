<script lang="ts">
	// The end of a form: its error, then CANCEL and the one primary key, at the right. While the
	// primary is inert the fields it still needs are named beside it, so an inert key always says
	// why (CLAUDE.md, what a page presents, 5).
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import ErrorBanner from './ErrorBanner.svelte';

	let {
		submit,
		cancel,
		cancelLabel = 'CANCEL',
		missing = [],
		busy = false,
		error = null,
		sticky = false,
		lead,
		class: className
	}: {
		submit: string;
		/** Where CANCEL goes, or what it does. None on a form whose page already has DONE. */
		cancel?: string | (() => void);
		cancelLabel?: string;
		/** Required fields still blank, as nouns. */
		missing?: string[];
		busy?: boolean;
		error?: string | null;
		/** Pinned to the bottom of the screen, for a form taller than one screen. */
		sticky?: boolean;
		/** Anything that sits at the left of the keys. */
		lead?: Snippet;
		class?: string;
	} = $props();

	const needs = $derived(
		missing.length < 2
			? missing.join('')
			: `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
	);
</script>

<div
	class={cn(
		'grid grid-cols-1 gap-2',
		sticky && 'sticky bottom-0 z-10 -mx-4 border-t border-border bg-background px-4 py-2',
		className
	)}
>
	<ErrorBanner message={error} />
	<div class="flex flex-wrap items-center justify-end gap-2">
		{@render lead?.()}
		{#if needs && !busy}
			<span class="text-xs text-muted-foreground" data-form-needs>Needs {needs}</span>
		{/if}
		{#if typeof cancel === 'string'}
			<Button variant="outline" href={cancel}>{cancelLabel}</Button>
		{:else if cancel}
			<Button variant="outline" onclick={cancel} disabled={busy}>{cancelLabel}</Button>
		{/if}
		<Button type="submit" disabled={busy || missing.length > 0}>{submit}</Button>
	</div>
</div>
