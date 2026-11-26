<script lang="ts">
	// A unit: shadcn combobox (Popover + Command). The common units come first, then the registry
	// (units.ts) grouped by dimension, found by symbol or name. Text that names no registry unit
	// can be used as typed; it is shown as written and never converted. Text that does name one
	// (psi, inch) picks that unit. Bind `value`, or pass `onchange`, or both.
	import { UNITS, UNIT_DIMENSIONS, unitByCode, unitFromText } from '@opal/shared';
	import CaretDown from 'phosphor-svelte/lib/CaretDown';
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
	let query = $state('');
	/** What the box resolves to: a registry code, or the typed text itself. */
	const typed = $derived.by(() => {
		const t = query.trim();
		if (!t) return null;
		const code = unitFromText(t);
		return code ? null : t.slice(0, 40);
	});
	const COMMON = ['in', 'mm', 's', 'v', 'degf', 'n_m', 'psi']
		.map((c) => unitByCode(c))
		.filter((u) => !!u);
	const known = $derived(unitByCode(value));
	const groups = UNIT_DIMENSIONS.map((d) => ({
		dimension: d,
		units: UNITS.filter((u) => u.dimension === d)
	})).filter((g) => g.units.length);

	function pick(code: string | undefined) {
		open = false;
		query = '';
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
				<CaretDown weight="bold" class="size-3 text-muted-foreground" aria-hidden="true" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-64 p-0" align="start">
		<Command.Root>
			<Command.Input placeholder="Symbol or name" bind:value={query} />
			<Command.List>
				{#if typed}
					<Command.Group>
						<Command.Item value={`${typed} use typed`} onSelect={() => pick(typed ?? undefined)}
							>USE “{typed}”</Command.Item
						>
					</Command.Group>
				{/if}
				<Command.Group heading="common">
					{#each COMMON as u (u.code)}
						<Command.Item
							value={`${u.symbol} ${u.name} ${u.code} common`}
							onSelect={() => pick(u.code)}
						>
							<span class="w-14 shrink-0 font-mono">{u.symbol}</span>
							<span class="truncate text-muted-foreground">{u.name}</span>
						</Command.Item>
					{/each}
				</Command.Group>
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
