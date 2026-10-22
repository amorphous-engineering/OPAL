<script lang="ts">
	// A page's view switcher, in the same register as the top-nav buttons:
	// mono uppercase, muted until hovered; the active tab is OPAL orange, boxed.
	// bits-ui supplies the tablist semantics (arrow keys, aria-selected).
	import { Tabs } from 'bits-ui';
	import { cn } from '#lib/utils.js';

	let {
		tabs,
		value,
		onchange,
		class: className
	}: {
		tabs: { id: string; label: string; count?: number }[];
		value: string;
		onchange: (id: string) => void;
		class?: string;
	} = $props();
</script>

<Tabs.Root {value} onValueChange={(v) => v && onchange(v)}>
	<Tabs.List class={cn('flex flex-wrap items-center gap-1 border-b border-border pb-1', className)}>
		{#each tabs as t (t.id)}
			<Tabs.Trigger
				value={t.id}
				class="inline-flex h-7 items-center gap-1.5 border border-transparent px-2 font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase outline-none hover:border-input hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=active]:border-info data-[state=active]:text-info"
			>
				{t.label}
				{#if t.count}<span class="tabular-nums opacity-70">{t.count}</span>{/if}
			</Tabs.Trigger>
		{/each}
	</Tabs.List>
</Tabs.Root>
