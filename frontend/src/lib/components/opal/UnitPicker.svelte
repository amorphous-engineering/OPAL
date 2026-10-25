<script lang="ts">
	// A unit from the registry (units.ts): shadcn combobox (Popover + Command), grouped by
	// dimension, found by symbol or name, shows the symbol. An old free-text unit shows as it
	// was written until a registry unit is picked. Bind `value`, or pass `onchange`, or both.
	import { UNITS, UNIT_DIMENSIONS, unitByCode } from '@opal/shared';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { cn } from '#lib/utils.js';

	let {
		value = $bindable(),
		onchange,
		id,
		label = 'Unit',
		class: className
	}: {
		value?: string;
		onchange?: (code: string | undefined) => void;
		id?: string;
		label?: string;
		class?: string;
	} = $props();

	let open = $state(false);
	const known = $derived(unitByCode(value));
	const groups = UNIT_DIMENSIONS.map((d) => ({
		dimension: d,
		units: UNITS.filter((u) => u.dimension === d)
	})).filter((g) => g.units.length);

	function pick(code: string | undefined) {
		open = false;
		value = code;
		onchange?.(code);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{id}
				type="button"
				variant="outline"
				size="sm"
				class={cn('h-7 min-w-16 justify-between gap-2 font-mono font-normal', className)}
				role="combobox"
				aria-expanded={open}
				aria-label={label}
				title={known ? known.name : undefined}
			>
				{#if value}{known?.symbol ?? value}{:else}<span class="text-muted-foreground">UNIT</span
					>{/if}
				<span class="text-muted-foreground" aria-hidden="true">▾</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-64 p-0" align="start">
		<Command.Root>
			<Command.Input placeholder="Symbol or name" />
			<Command.List>
				<Command.Empty>No match</Command.Empty>
				{#if value}
					<Command.Group>
						<Command.Item value="none clear" onSelect={() => pick(undefined)}>NO UNIT</Command.Item>
					</Command.Group>
				{/if}
				{#each groups as g (g.dimension)}
					<Command.Group heading={g.dimension}>
						{#each g.units as u (u.code)}
							<Command.Item
								value={`${u.symbol} ${u.name} ${u.code} ${g.dimension}`}
								onSelect={() => pick(u.code)}
							>
								<span class="w-14 shrink-0 font-mono">{u.symbol}</span>
								<span class="truncate text-muted-foreground">{u.name}</span>
							</Command.Item>
						{/each}
					</Command.Group>
				{/each}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
