<script lang="ts">
	// A page's view switcher, built as a panel header bar: same frame, height and fill as a
	// Section header, segments ruled apart like the breadcrumb strip. The active segment takes
	// the card colour with an accent rule along its bottom edge; trailing controls (`end`)
	// sit ruled off at the right. bits-ui supplies the tablist semantics.
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

<div class={cn('flex h-8 items-stretch border border-border bg-muted/60', className)}>
	<Tabs.Root {value} onValueChange={(v) => v && onchange(v)} class="flex min-w-0 flex-1">
		<Tabs.List class="flex min-w-0 items-stretch overflow-x-auto">
			{#each tabs as t (t.id)}
				<Tabs.Trigger
					value={t.id}
					class="label inline-flex items-center gap-1.5 border-r border-border px-3 whitespace-nowrap outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_var(--info)]"
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
