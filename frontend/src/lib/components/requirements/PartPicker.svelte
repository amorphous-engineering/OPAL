<script lang="ts">
	// Search parts by name or part number; picking one calls onpick.
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api, type Page } from '#lib/api.js';

	interface PartHit {
		id: number;
		name: string;
		internal_pn: string | null;
	}

	let { onpick, exclude = [] }: { onpick: (part: PartHit) => void; exclude?: number[] } = $props();

	let open = $state(false);
	let query = $state('');
	let hits = $state<PartHit[]>([]);
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		if (!open) return;
		const q = query.trim();
		clearTimeout(timer);
		const mine = ++seq;
		timer = setTimeout(async () => {
			try {
				const r = await api.get<Page<PartHit>>('/parts', { search: q, limit: 20 });
				if (mine === seq) hits = r.items.filter((p) => !exclude.includes(p.id));
			} catch {
				if (mine === seq) hits = [];
			}
		}, 150);
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button variant="ghost" size="xs" class="font-mono text-info" {...props}>+ ASSIGN PART</Button
			>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		<Command.Root shouldFilter={false}>
			<Command.Input placeholder="Part name or number" bind:value={query} />
			<Command.List>
				<Command.Empty>No part</Command.Empty>
				{#each hits as p (p.id)}
					<Command.Item
						value={`part-${p.id}`}
						onSelect={() => {
							open = false;
							query = '';
							onpick(p);
						}}
					>
						<span class="mono shrink-0 text-info">{p.internal_pn ?? '—'}</span>
						<span class="truncate">{p.name}</span>
					</Command.Item>
				{/each}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
