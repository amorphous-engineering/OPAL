<script lang="ts">
	// Row of filters above a list. Search first, then selects/toggles, then CLEAR
	// (shown only while a filter is active). Every control writes to the URL.
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import { hasParams, setQuery } from './listquery.js';

	let {
		children,
		clear = [],
		end,
		label = 'Filters'
	}: {
		children: Snippet;
		/** URL keys this bar controls; CLEAR resets exactly these (sort and view survive). */
		clear?: readonly string[];
		/** Right-aligned trailing content. */
		end?: Snippet;
		label?: string;
	} = $props();

	const active = $derived.by(() => {
		void page.url.search;
		return clear.length > 0 && hasParams(clear);
	});

	function reset() {
		setQuery(Object.fromEntries(clear.map((k) => [k, null])));
	}
</script>

<div
	role="search"
	aria-label={label}
	class="flex flex-wrap items-center gap-2 border-b border-border p-2"
>
	{@render children()}
	{#if active}
		<Button variant="link" class="h-auto border-0 p-0 font-mono text-info" onclick={reset}
			>CLEAR</Button
		>
	{/if}
	{#if end}<div class="ml-auto flex items-center gap-3">{@render end()}</div>{/if}
</div>
