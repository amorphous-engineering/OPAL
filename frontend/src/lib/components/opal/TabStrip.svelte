<script lang="ts">
	// A page's view switcher: a row of keys in a panel bar, the active one filled (you are here).
	// Trailing controls (`end`) sit ruled off at the right. bits-ui supplies the tablist semantics.
	import type { Snippet } from 'svelte';
	import { Tabs } from 'bits-ui';
	import { cn } from '#lib/utils.js';

	let {
		tabs,
		value,
		onchange,
		end,
		class: className
	}: {
		tabs: { id: string; label: string; count?: number }[];
		value: string;
		onchange: (id: string) => void;
		end?: Snippet;
		class?: string;
	} = $props();
</script>

<div
	class={cn(
		'flex h-10 items-stretch overflow-hidden rounded-lg border border-border bg-card',
		className
	)}
>
	<Tabs.Root {value} onValueChange={(v) => v && onchange(v)} class="flex min-w-0 flex-1">
		<Tabs.List class="flex min-w-0 items-center gap-1.5 overflow-x-auto px-2 py-1">
			{#each tabs as t (t.id)}
				<Tabs.Trigger
					value={t.id}
					class="label inline-flex h-7 items-center gap-1.5 border border-foreground bg-card px-3 whitespace-nowrap text-foreground shadow-key2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-none"
				>
					{t.label}
					{#if t.count}<span class="tabular-nums">{t.count}</span>{/if}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>
	</Tabs.Root>
	{#if end}
		<div class="flex items-stretch border-l border-border">{@render end()}</div>
	{/if}
</div>
