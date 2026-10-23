<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import LabelFace from '#lib/components/labels/LabelFace.svelte';
	import { DEFAULT_SIZE, LABEL_SIZES, sizeFor } from '#lib/components/labels/sizes.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const STORE = 'opal.label.size';
	let sizeKey = $state(page.url.searchParams.get('size') ?? DEFAULT_SIZE);
	let copies = $state(Math.max(1, Number(page.url.searchParams.get('copies')) || 1));
	const size = $derived(sizeFor(sizeKey));

	onMount(() => {
		// Last size used on this browser, unless the link names one.
		if (!page.url.searchParams.get('size')) {
			try {
				const saved = localStorage.getItem(STORE);
				if (saved) sizeKey = saved;
			} catch {
				/* storage unavailable */
			}
		}
		if (page.url.searchParams.get('print') === '1' && data.specs.length) {
			setTimeout(() => window.print(), 400);
		}
	});

	// The printed page is exactly one label: @page size follows the chosen stock.
	$effect(() => {
		const style = document.createElement('style');
		style.textContent = `@page { size: ${size.width}in ${size.height}in; margin: 0; }`;
		document.head.append(style);
		return () => style.remove();
	});

	function setSize(key: string) {
		sizeKey = key;
		try {
			localStorage.setItem(STORE, key);
		} catch {
			/* storage unavailable */
		}
	}

	const sheets = $derived(
		data.specs.flatMap((spec) =>
			Array.from({ length: Math.min(99, Math.max(1, Math.floor(copies) || 1)) }, (_, i) => ({
				spec,
				id: `${spec.key}-${i}`
			}))
		)
	);
</script>

<svelte:head>
	<title>Labels · OPAL</title>
</svelte:head>

<div
	class="flex flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-2 print:hidden"
>
	<span class="font-mono text-sm font-bold tracking-[0.2em]">LABELS</span>
	<span class="mono text-xs text-muted-foreground">{sheets.length}</span>

	<label class="ml-4 flex items-center gap-2 text-xs">
		<span class="label">Stock</span>
		<NativeSelect
			size="sm"
			value={sizeKey}
			onchange={(e) => setSize(e.currentTarget.value)}
			aria-label="Label stock"
		>
			{#each LABEL_SIZES as s (s.key)}<option value={s.key}>{s.name}</option>{/each}
		</NativeSelect>
	</label>
	<label class="flex items-center gap-2 text-xs">
		<span class="label">Copies</span>
		<Input type="number" min="1" max="99" class="h-7 w-16 font-mono" bind:value={copies} />
	</label>

	<div class="ml-auto flex items-center gap-2">
		<Button size="sm" variant="outline" onclick={() => history.back()}>BACK</Button>
		<Button size="sm" disabled={!sheets.length} onclick={() => window.print()}>PRINT</Button>
	</div>
</div>

{#if data.failures.length}
	<ul
		role="alert"
		class="m-4 space-y-0.5 rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error print:hidden"
	>
		{#each data.failures as f (f)}<li>{f}</li>{/each}
	</ul>
{/if}

{#if !sheets.length && !data.failures.length}
	<p class="m-4 font-mono text-xs text-muted-foreground print:hidden">LABELS — none</p>
{/if}

<div class="sheet flex flex-col items-start gap-4 p-4 print:gap-0 print:p-0">
	{#each sheets as s (s.id)}
		<div class="one border border-border print:border-0">
			<LabelFace spec={s.spec} {size} />
		</div>
	{/each}
</div>

<style>
	@media print {
		.one {
			break-after: page;
			page-break-after: always;
		}
		.one:last-child {
			break-after: auto;
			page-break-after: auto;
		}
	}
</style>
