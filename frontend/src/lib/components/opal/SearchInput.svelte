<script lang="ts">
	// Debounced search box bound to the `q` URL parameter. `/` focuses it from anywhere
	// outside a text field.
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { Input } from '#lib/components/ui/input/index.js';
	import { cn } from '#lib/utils.js';
	import { setQuery } from './listquery.js';

	let {
		label,
		placeholder,
		param = 'q',
		class: className
	}: { label: string; placeholder: string; param?: string; class?: string } = $props();

	const fromUrl = $derived(page.url.searchParams.get(param) ?? '');
	let value = $derived(fromUrl);
	let el = $state<HTMLInputElement | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function oninput() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (value.trim() !== fromUrl) setQuery({ [param]: value.trim() }, { replace: true });
		}, 250);
	}
	onDestroy(() => clearTimeout(timer));

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
		const t = e.target as HTMLElement | null;
		if (t?.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
		e.preventDefault();
		el?.focus();
	}
</script>

<svelte:window {onkeydown} />

<Input
	bind:ref={el}
	bind:value
	{oninput}
	type="search"
	placeholder="{placeholder}    /"
	aria-label={label}
	class={cn('h-7 w-72', className)}
/>
