<script lang="ts">
	// Pick a part by PN or name. Server-side search; shows PN then name.
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { api } from '#lib/api.js';
	import { cn } from '#lib/utils.js';
	import type { Part, PartRef } from './types.js';

	let {
		value = $bindable<PartRef | null>(null),
		exclude = [],
		placeholder = 'Select part',
		id,
		clearable = false,
		class: className,
		onselect
	}: {
		value?: PartRef | null;
		exclude?: number[];
		placeholder?: string;
		id?: string;
		clearable?: boolean;
		class?: string;
		onselect?: (part: PartRef | null) => void;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let results = $state<Part[]>([]);
	let loading = $state(false);
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (!open) return;
		const q = query.trim();
		clearTimeout(timer);
		const mine = ++seq;
		timer = setTimeout(
			async () => {
				loading = true;
				try {
					const r = await api.get<{ items: Part[] }>('/parts', {
						search: q,
						limit: 10,
						sort_by: 'internal_pn',
						sort_order: 'asc'
					});
					if (mine === seq) results = r.items;
				} catch {
					if (mine === seq) results = [];
				} finally {
					if (mine === seq) loading = false;
				}
			},
			q ? 150 : 0
		);
	});

	function pick(p: PartRef | null) {
		value = p;
		open = false;
		query = '';
		onselect?.(p);
	}

	const shown = $derived(results.filter((r) => !exclude.includes(r.id)));
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		{id}
		type="button"
		class={cn(
			'flex h-8 w-full min-w-0 items-center gap-2 border border-input bg-transparent px-2.5 text-left text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30',
			className
		)}
	>
		{#if value}
			<span class="font-mono text-info">{value.internal_pn ?? '—'}</span>
			<span class="truncate">{value.name}</span>
		{:else}
			<span class="text-muted-foreground">{placeholder}</span>
		{/if}
	</Popover.Trigger>
	<Popover.Content class="w-96 gap-0 p-0" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input placeholder="PN or name" bind:value={query} />
			<Command.List>
				{#if shown.length === 0}
					<Command.Empty>{loading ? 'Searching' : 'No parts'}</Command.Empty>
				{/if}
				{#each shown as p (p.id)}
					<Command.Item value={String(p.id)} onSelect={() => pick(p)}>
						<span class="font-mono text-info">{p.internal_pn}</span>
						<span class="truncate">{p.name}</span>
						{#if p.lifecycle_state === 'draft'}<span class="label ml-auto text-warn">Draft</span
							>{/if}
					</Command.Item>
				{/each}
			</Command.List>
			{#if clearable && value}
				<button
					type="button"
					class="border-t border-border px-2.5 py-1.5 text-left font-mono text-xs text-info hover:bg-accent"
					onclick={() => pick(null)}>CLEAR</button
				>
			{/if}
		</Command.Root>
	</Popover.Content>
</Popover.Root>
