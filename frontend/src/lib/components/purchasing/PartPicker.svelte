<script lang="ts">
	// Part lookup: type to search part number, name or manufacturer number.
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import type { PickedPart } from './types.js';

	let {
		value = $bindable<PickedPart | null>(null),
		activeOnly = true,
		id,
		disabled = false
	}: {
		value?: PickedPart | null;
		activeOnly?: boolean;
		id?: string;
		disabled?: boolean;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let results = $state<PickedPart[]>([]);
	let loading = $state(false);
	let seq = 0;

	$effect(() => {
		if (!open) return;
		const q = query.trim();
		const mine = ++seq;
		loading = true;
		const timer = setTimeout(async () => {
			try {
				const r = await api.get<{ items: PickedPart[] }>('/parts', {
					search: q,
					state: activeOnly ? 'active' : undefined,
					limit: 12
				});
				if (mine === seq) results = r.items;
			} catch {
				if (mine === seq) results = [];
			} finally {
				if (mine === seq) loading = false;
			}
		}, 150);
		return () => clearTimeout(timer);
	});

	function pick(p: PickedPart) {
		value = p;
		open = false;
		query = '';
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger {id} {disabled}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				class="w-full justify-start font-normal"
				role="combobox"
				aria-expanded={open}
			>
				{#if value}
					<span class="font-mono text-info">{value.internal_pn ?? '—'}</span>
					<span class="truncate">{value.name}</span>
				{:else}
					<span class="text-muted-foreground">Search parts</span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-96 p-0" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input placeholder="Part number or name" bind:value={query} />
			<Command.List>
				{#if !loading && results.length === 0}
					<Command.Empty>No match</Command.Empty>
				{/if}
				{#each results as p (p.id)}
					<Command.Item value={String(p.id)} onSelect={() => pick(p)}>
						<span class="font-mono text-info">{p.internal_pn ?? '—'}</span>
						<span class="truncate">{p.name}</span>
						{#if p.procurement}<span
								class="ml-auto font-mono text-xs text-muted-foreground uppercase"
								>{p.procurement}</span
							>{/if}
					</Command.Item>
				{/each}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
