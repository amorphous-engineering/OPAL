<script lang="ts" module>
	export interface PickerOption {
		value: number;
		label: string;
		sub?: string;
	}
</script>

<script lang="ts">
	// Search-and-pick popover for a record (part, issue). The caller supplies
	// the search; results are options the user selects with keyboard or mouse.
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		search,
		onpick,
		label,
		placeholder = 'Search…',
		disabled = false
	}: {
		search: (q: string) => Promise<PickerOption[]>;
		onpick: (option: PickerOption) => void;
		label: string;
		placeholder?: string;
		disabled?: boolean;
	} = $props();

	let open = $state(false);
	let query = $state('');
	let options = $state<PickerOption[]>([]);
	let seq = 0;

	$effect(() => {
		if (!open) return;
		const q = query.trim();
		const mine = ++seq;
		const timer = setTimeout(
			async () => {
				try {
					const r = await search(q);
					if (mine === seq) options = r;
				} catch {
					if (mine === seq) options = [];
				}
			},
			q ? 200 : 0
		);
		return () => clearTimeout(timer);
	});

	function pick(o: PickerOption) {
		open = false;
		query = '';
		onpick(o);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" {disabled}>{label}</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-96 p-0" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input {placeholder} bind:value={query} />
			<Command.List>
				<Command.Empty>No match</Command.Empty>
				{#each options as o (o.value)}
					<Command.Item value={String(o.value)} onSelect={() => pick(o)}>
						<span class="shrink-0 font-mono whitespace-nowrap text-info">{o.label}</span>
						{#if o.sub}<span class="ml-2 truncate text-muted-foreground">{o.sub}</span>{/if}
					</Command.Item>
				{/each}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
