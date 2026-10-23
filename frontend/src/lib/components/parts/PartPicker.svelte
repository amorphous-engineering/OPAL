<script lang="ts" generics="T extends PartRef">
	// The one way to pick a part: PN or name, searched server-side. The default trigger is a
	// field showing the bound part; `trigger` replaces it (e.g. a "+ ASSIGN PART" action).
	// Results are full part rows, so `value` and `onselect` may use any part shape.
	import type { Snippet } from 'svelte';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { toastError } from '#lib/components/opal/index.js';
	import { cn } from '#lib/utils.js';
	import type { Part, PartRef } from './types.js';

	let {
		value = $bindable<T | null>(null),
		exclude = [],
		activeOnly = false,
		meta,
		placeholder = 'Select part',
		id,
		clearable = false,
		disabled = false,
		align = 'start',
		class: className,
		onselect,
		trigger
	}: {
		value?: T | null;
		exclude?: number[];
		/** Only parts in the active lifecycle state. */
		activeOnly?: boolean;
		/** A part fact shown at the end of each result row. */
		meta?: 'procurement' | 'tracking_type';
		placeholder?: string;
		id?: string;
		clearable?: boolean;
		disabled?: boolean;
		align?: 'start' | 'end';
		class?: string;
		onselect?: (part: T | null) => void;
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let results = $state<Part[]>([]);
	let loading = $state(false);
	let seq = 0;

	$effect(() => {
		if (!open) return;
		const q = query.trim();
		const mine = ++seq;
		loading = true;
		const timer = setTimeout(
			async () => {
				try {
					const r = await api.get<{ items: Part[] }>('/parts', {
						search: q,
						state: activeOnly ? 'active' : undefined,
						limit: 12,
						sort_by: 'internal_pn',
						sort_order: 'asc'
					});
					if (mine === seq) results = r.items;
				} catch (e) {
					if (mine === seq) results = [];
					toastError(e);
				} finally {
					if (mine === seq) loading = false;
				}
			},
			q ? 150 : 0
		);
		return () => clearTimeout(timer);
	});

	function pick(p: T | null) {
		value = p;
		open = false;
		query = '';
		onselect?.(p);
	}

	const shown = $derived(results.filter((r) => !exclude.includes(r.id)));
</script>

<Popover.Root bind:open>
	<Popover.Trigger {id} {disabled}>
		{#snippet child({ props })}
			{#if trigger}
				{@render trigger({ props })}
			{:else}
				<Button
					{...props}
					variant="outline"
					role="combobox"
					aria-expanded={open}
					class={cn('w-full min-w-0 justify-start gap-2 font-normal', className)}
				>
					{#if value}
						<span class="font-mono text-info">{value.internal_pn ?? '—'}</span>
						<span class="truncate">{value.name}</span>
					{:else}
						<span class="text-muted-foreground">{placeholder}</span>
					{/if}
				</Button>
			{/if}
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-96 gap-0 p-0" {align}>
		<Command.Root shouldFilter={false}>
			<Command.Input placeholder="PN or name" bind:value={query} />
			<Command.List>
				{#if shown.length === 0}
					<Command.Empty>{loading ? 'Searching' : 'No parts'}</Command.Empty>
				{/if}
				{#each shown as p (p.id)}
					<Command.Item value={String(p.id)} onSelect={() => pick(p as unknown as T)}>
						<span class="shrink-0 font-mono text-info">{p.internal_pn ?? '—'}</span>
						<span class="truncate">{p.name}</span>
						<span class="ml-auto flex shrink-0 items-center gap-2">
							{#if p.lifecycle_state === 'draft'}<span class="label text-warn">Draft</span>{/if}
							{#if meta}<span class="font-mono text-xs text-muted-foreground uppercase"
									>{p[meta]}</span
								>{/if}
						</span>
					</Command.Item>
				{/each}
			</Command.List>
			{#if clearable && value}
				<Button
					variant="ghost"
					class="h-auto justify-start rounded-t-none border-0 border-t border-border px-2.5 py-1.5 font-mono font-normal text-info"
					onclick={() => pick(null)}>CLEAR</Button
				>
			{/if}
		</Command.Root>
	</Popover.Content>
</Popover.Root>
