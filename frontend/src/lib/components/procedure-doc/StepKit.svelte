<script lang="ts">
	// Parts a step uses. Execute mode picks the stock record each part is drawn
	// from and consumes it against the step; tooling is recorded, not deducted.
	import { untrack } from 'svelte';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { State } from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import { useDoc, type StockRecord } from './controller.js';
	import KitEditor from './author/KitEditor.svelte';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();
	const ctl = useDoc();

	const workable = $derived(
		ctl.active &&
			!!ctl.actions.consume &&
			(step.status === 'pending' || step.status === 'in_progress')
	);
	const consumedParts = $derived(new Set(step.consumptions.map((c) => c.part_id)));
	const open = $derived(workable ? step.step_kit.filter((k) => !consumedParts.has(k.part_id)) : []);

	let stock = $state<Record<number, StockRecord[]>>({});
	let pick = $state<Record<number, { record: string; qty: string }>>({});
	let busy = $state(false);

	const label = (r: StockRecord) =>
		[
			r.opal_number,
			r.location,
			`${qty(r.quantity)} ${(r.part_uom ?? 'ea').toUpperCase()}`,
			r.lot_number
		]
			.filter(Boolean)
			.join(' · ');

	$effect(() => {
		if (!workable || !ctl.actions.loadStock) return;
		for (const k of open) {
			if (untrack(() => stock[k.part_id])) continue;
			ctl.actions.loadStock(k.part_id).then((records) => {
				const usable = records.filter((r) => Number(r.quantity) > 0);
				stock[k.part_id] = usable;
				const fit = usable.find((r) => Number(r.quantity) >= k.quantity_required) ?? usable[0];
				pick[k.part_id] = { record: fit ? String(fit.id) : '', qty: String(k.quantity_required) };
			});
		}
	});

	async function consume() {
		const items = open
			.map((k) => ({ k, p: pick[k.part_id] }))
			.filter(({ p }) => p && Number(p.qty) > 0)
			.map(({ k, p }) => ({
				inventory_record_id: Number(p.record),
				quantity: Number(p.qty),
				usage_type: k.usage_type
			}));
		if (!items.length || items.some((i) => !i.inventory_record_id) || !ctl.actions.consume) return;
		busy = true;
		try {
			await ctl.actions.consume(step, items);
		} finally {
			busy = false;
		}
	}
</script>

{#if ctl.mode === 'author'}
	<KitEditor {step} />
{:else if step.step_kit.length || step.consumptions.length}
	<div class="grid grid-cols-1 gap-1.5">
		<span class="label">Step parts</span>
		{#if open.length}
			<table class="w-full border-collapse text-xs">
				<thead>
					<tr class="border-b border-border bg-muted/60 text-left">
						{#each ['PART', 'REQ', 'TYPE', 'SOURCE', 'QTY'] as h (h)}
							<th
								class="h-7 px-2 font-mono text-xs font-medium tracking-wider text-muted-foreground"
								>{h}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each open as k (k.part_id)}
						<tr class="border-b border-border">
							<td class="px-2 py-1"
								><span class="font-mono">{k.part_number ?? ''}</span>
								{k.part_name}{#if k.notes}<span class="text-muted-foreground">
										({k.notes})</span
									>{/if}</td
							>
							<td class="px-2 py-1 font-mono">{qty(k.quantity_required)}</td>
							<td class="px-2 py-1"
								><State
									value={k.usage_type}
									tone={k.usage_type === 'tooling' ? 'info' : 'muted'}
								/></td
							>
							<td class="px-2 py-1">
								<NativeSelect
									class="w-full min-w-48"
									size="sm"
									aria-label={`Source for ${k.part_name}`}
									value={pick[k.part_id]?.record ?? ''}
									onchange={(e) =>
										(pick[k.part_id] = { ...pick[k.part_id], record: e.currentTarget.value })}
								>
									{#if !stock[k.part_id]}
										<option value="">Loading…</option>
									{:else if !stock[k.part_id].length}
										<option value="">No stock</option>
									{:else}
										{#each stock[k.part_id] as r (r.id)}<option value={String(r.id)}
												>{label(r)}</option
											>{/each}
									{/if}
								</NativeSelect>
							</td>
							<td class="px-2 py-1">
								<Input
									type="number"
									min="0"
									step="any"
									class="h-7 w-24 font-mono"
									aria-label={`Quantity of ${k.part_name}`}
									value={pick[k.part_id]?.qty ?? String(k.quantity_required)}
									oninput={(e) =>
										(pick[k.part_id] = { ...pick[k.part_id], qty: e.currentTarget.value })}
								/>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<div>
				<Button size="xs" variant="outline" disabled={busy} onclick={consume}>CONSUME PARTS</Button>
			</div>
		{:else if !step.consumptions.length}
			<ul class="m-0 list-none p-0 font-mono text-xs text-muted-foreground">
				{#each step.step_kit as k (k.part_id)}
					<li>
						{k.part_number ?? ''}
						{k.part_name} × {qty(k.quantity_required)}
						{k.usage_type === 'tooling' ? '(TOOLING)' : ''}
					</li>
				{/each}
			</ul>
		{/if}
		{#each step.consumptions as c (c.id)}
			<div class="font-mono text-xs text-muted-foreground">
				<span class="text-ok">CONSUMED</span>
				{c.part_number ?? ''}
				{c.part_name} × {qty(c.quantity)} from
				{#if c.opal_number}<a class="text-info" href={`/inventory/opal/${c.opal_number}`}
						>{c.opal_number}</a
					>{/if}
				{c.location}{c.usage_type === 'tooling' ? ' (TOOLING)' : ''}
			</div>
		{/each}
	</div>
{/if}
