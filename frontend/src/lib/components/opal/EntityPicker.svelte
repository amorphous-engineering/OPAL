<script lang="ts" module>
	export interface PickerOption {
		value: number;
		label: string;
		sub?: string;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	// Search-and-pick popover for a record that is not a part (parts use PartPicker).
	// The caller supplies the search; the user selects a result with keyboard or mouse.
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toastError } from './toast.js';

	let {
		search,
		onpick,
		label,
		placeholder = 'Search…',
		disabled = false,
		align = 'start',
		trigger
	}: {
		search: (q: string) => Promise<PickerOption[]>;
		onpick: (option: PickerOption) => void;
		label: string;
		placeholder?: string;
		disabled?: boolean;
		align?: 'start' | 'end';
		/** Replaces the default button, e.g. with a SET text action. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
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
				} catch (e) {
					if (mine === seq) options = [];
					toastError(e);
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
	<Popover.Trigger {disabled}>
		{#snippet child({ props })}
			{#if trigger}
				{@render trigger({ props })}
			{:else}
				<Button {...props} variant="outline" size="sm">{label}</Button>
			{/if}
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-96 p-0" {align}>
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
