<script lang="ts">
	// Material in and out of the work order: kit against consumption, the
	// consumption ledger with provenance, and the productions it yields.
	import { onMount } from 'svelte';
	import { api } from '#lib/api.js';
	import {
		confirm,
		DataTable,
		EmptyLine,
		Section,
		State,
		toastError
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { qty } from '#lib/format.js';
	import type { DocConsumption } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import type { KitRow, ProductionRow } from '#lib/execution/types.js';

	let { store }: { store: ExecutionStore } = $props();
	const doc = $derived(store.doc!);
	const inst = $derived(doc.instance);
	const canConsume = $derived(inst.status === 'in_work' || inst.status === 'completed');

	interface Availability {
		items: {
			part_id: number;
			quantity_available: number;
			uom: string | null;
			available_locations: {
				inventory_record_id: number;
				opal_number: string | null;
				location: string;
				lot_number: string | null;
				quantity: number;
			}[];
		}[];
	}
	let avail = $state<Availability | null>(null);
	let pick = $state<Record<number, { record: string; qty: string }>>({});
	let busy = $state(false);

	const remaining = (k: KitRow) => Math.max(0, k.qty_required - k.qty_consumed);

	async function loadAvailability() {
		if (!doc.kit.items.length) return;
		try {
			avail = await api.get<Availability>(`/procedure-instances/${store.id}/kit-availability`);
			for (const k of doc.kit.items) {
				const it = avail.items.find((x) => x.part_id === k.part_id);
				const need = remaining(k);
				const fit =
					it?.available_locations.find((l) => l.quantity >= need) ?? it?.available_locations[0];
				pick[k.part_id] = {
					record: fit ? String(fit.inventory_record_id) : '',
					qty: need ? String(need) : '0'
				};
			}
		} catch {
			/* availability is advisory */
		}
	}
	onMount(loadAvailability);

	const label = (
		l: Availability['items'][number]['available_locations'][number],
		uom: string | null
	) =>
		[l.opal_number, l.location, `${qty(l.quantity)} ${(uom ?? 'ea').toUpperCase()}`, l.lot_number]
			.filter(Boolean)
			.join(' · ');

	async function consumeKit() {
		const items = doc.kit.items
			.map((k) => ({ k, p: pick[k.part_id] }))
			.filter(({ p }) => p && Number(p.qty) > 0)
			.map(({ p }) => ({ inventory_record_id: Number(p.record), quantity: Number(p.qty) }));
		if (!items.length) return;
		if (items.some((i) => !i.inventory_record_id)) {
			toastError(new Error('Select a source for every part'));
			return;
		}
		busy = true;
		try {
			await store.consumeKit(items);
			await loadAvailability();
		} catch (e) {
			toastError(e, 'Failed to consume parts');
		} finally {
			busy = false;
		}
	}

	const consumedCols: Column<DocConsumption>[] = [
		{ key: 'part_number', label: 'Part', mono: true },
		{ key: 'part_name', label: 'Name' },
		{ key: 'opal_number', label: 'OPAL #', mono: true },
		{ key: 'quantity', label: 'Qty', align: 'right', mono: true },
		{ key: 'lot_number', label: 'Lot', mono: true },
		{ key: 'location', label: 'Location', mono: true },
		{ key: 'step_number', label: 'Step', mono: true },
		{ key: 'usage_type', label: 'Type' }
	];

	const prodCols: Column<ProductionRow>[] = [
		{ key: 'part', label: 'Part' },
		{ key: 'serial_number', label: 'Serial', mono: true },
		{ key: 'opal_number', label: 'OPAL #', mono: true },
		{ key: 'quantity', label: 'Qty', align: 'right', mono: true },
		{ key: 'lot_number', label: 'Lot (WO)', mono: true },
		{ key: 'location', label: 'Location', mono: true },
		{ key: 'status', label: 'Status' }
	];

	let location = $state('');
	async function finalize() {
		if (!location.trim()) return;
		if (
			!(await confirm({
				title: 'Finalize production?',
				body: 'Output quantities and locations are set and assembly genealogy is recorded from the consumed parts.',
				action: 'FINALIZE'
			}))
		)
			return;
		busy = true;
		try {
			await store.finalize(location.trim());
		} catch (e) {
			toastError(e, 'Failed to finalize production');
		} finally {
			busy = false;
		}
	}

	let out = $state<Record<number, { qty: string; loc: string; lot: string; serial: string }>>({});
	const o = (id: number, dflt: number) =>
		(out[id] ??= { qty: String(dflt), loc: '', lot: '', serial: '' });
	async function produce() {
		const items = doc.outputs
			.map((x) => ({ x, v: o(x.part_id, x.quantity) }))
			.filter(({ v }) => Number(v.qty) > 0)
			.map(({ x, v }) => ({
				part_id: x.part_id,
				quantity: Number(v.qty),
				location: v.loc.trim(),
				lot_number: v.lot.trim() || null,
				serial_number: v.serial.trim() || null
			}));
		if (items.some((i) => !i.location)) {
			toastError(new Error('Enter a location for every output'));
			return;
		}
		busy = true;
		try {
			await store.produce(items);
		} catch (e) {
			toastError(e, 'Failed to record output');
		} finally {
			busy = false;
		}
	}
</script>

<div class="grid grid-cols-1 gap-4">
	{#if doc.kit_relevant}
		<Section title="Kit" count={doc.kit.items.length || undefined}>
			{#snippet actions()}
				{#if canConsume && doc.kit.items.some((k) => remaining(k) > 0)}
					<Button size="xs" disabled={busy} onclick={consumeKit}>CONSUME PARTS</Button>
				{/if}
			{/snippet}
			{#if doc.kit.items.length}
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<thead>
							<tr class="border-b border-border bg-muted/60 text-left">
								{#each [['PART', ''], ['REQUIRED', 'text-right'], ['AVAILABLE', 'text-right'], ['CONSUMED', 'text-right'], ['VARIANCE', 'text-right'], ['SOURCE', ''], ['QTY', '']] as [h, c] (h)}
									<th
										class={`h-8 px-3 font-mono text-xs font-medium tracking-wider text-muted-foreground ${c}`}
										>{h}</th
									>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each doc.kit.items as k (k.part_id)}
								{@const it = avail?.items.find((x) => x.part_id === k.part_id)}
								<tr class="border-b border-border align-top">
									<td class="px-3 py-1.5"
										><a class="font-mono text-info hover:underline" href={`/parts/${k.part_id}`}
											>{k.part_number}</a
										>
										{k.part_name}</td
									>
									<td class="px-3 py-1.5 text-right font-mono">{qty(k.qty_required)}</td>
									<td
										class="px-3 py-1.5 text-right font-mono {it &&
										it.quantity_available < remaining(k)
											? 'text-error'
											: ''}">{it ? qty(it.quantity_available) : '—'}</td
									>
									<td class="px-3 py-1.5 text-right font-mono">{qty(k.qty_consumed)}</td>
									<td
										class="px-3 py-1.5 text-right font-mono {k.variance > 0
											? 'text-warn'
											: k.variance < 0
												? 'text-error'
												: ''}">{k.variance > 0 ? '+' : ''}{qty(k.variance)}</td
									>
									<td class="px-3 py-1.5">
										{#if canConsume && remaining(k) > 0}
											<NativeSelect
												class="w-full min-w-48"
												size="sm"
												aria-label={`Source for ${k.part_name}`}
												value={pick[k.part_id]?.record ?? ''}
												onchange={(e) =>
													(pick[k.part_id] = { ...pick[k.part_id], record: e.currentTarget.value })}
											>
												{#if !it}<option value="">Loading…</option>
												{:else if !it.available_locations.length}<option value="">No stock</option>
												{:else}
													{#each it.available_locations as l (l.inventory_record_id)}
														<option value={String(l.inventory_record_id)}>{label(l, it.uom)}</option
														>
													{/each}
												{/if}
											</NativeSelect>
										{:else}<span class="text-muted-foreground">—</span>{/if}
									</td>
									<td class="px-3 py-1.5">
										{#if canConsume && remaining(k) > 0}
											<Input
												type="number"
												min="0"
												step="any"
												class="h-7 w-24 font-mono"
												aria-label={`Quantity of ${k.part_name}`}
												value={pick[k.part_id]?.qty ?? ''}
												oninput={(e) =>
													(pick[k.part_id] = { ...pick[k.part_id], qty: e.currentTarget.value })}
											/>
										{:else}<span class="text-muted-foreground">—</span>{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<EmptyLine label="Kit" />
			{/if}
			{#if doc.kit.unplanned.length}
				<div class="border-t border-border">
					<div class="label px-3 py-1.5 text-warn">Unplanned consumption</div>
					<table class="w-full border-collapse text-sm">
						<tbody>
							{#each doc.kit.unplanned as u (u.part_id)}
								<tr class="border-t border-border">
									<td class="px-3 py-1"
										><a class="font-mono text-info hover:underline" href={`/parts/${u.part_id}`}
											>{u.part_number ?? '—'}</a
										>
										{u.part_name}</td
									>
									<td class="px-3 py-1 text-right font-mono">{qty(u.qty_consumed)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Section>

		<Section title="Consumed" count={doc.consumptions.length || undefined}>
			<DataTable
				rows={doc.consumptions}
				columns={consumedCols}
				emptyLabel="Consumed"
				key={(r) => r.id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'part_number'}
						<a class="text-info hover:underline" href={`/parts/${r.part_id}`}
							>{r.part_number ?? '—'}</a
						>
					{:else if col.key === 'opal_number'}
						{#if r.opal_number}<a
								class="text-info hover:underline"
								href={`/inventory/opal/${r.opal_number}`}>{r.opal_number}</a
							>{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'quantity'}
						{qty(r.quantity)}
					{:else if col.key === 'usage_type'}
						<State value={r.usage_type} tone={r.usage_type === 'tooling' ? 'info' : 'muted'} />
					{:else}
						{@const v = (r as unknown as Record<string, unknown>)[col.key]}
						{#if v === null || v === undefined || v === ''}<span class="text-muted-foreground"
								>—</span
							>{:else}{v}{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}

	{#if doc.productions.length}
		<Section title="Production" count={doc.productions.length}>
			<DataTable
				rows={doc.productions}
				columns={prodCols}
				emptyLabel="Production"
				key={(r) => r.id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'part'}
						<a class="font-mono text-info hover:underline" href={`/parts/${r.part_id}`}
							>{r.part_number}</a
						>
						{r.part_name}
					{:else if col.key === 'opal_number'}
						{#if r.opal_number}<a
								class="text-info hover:underline"
								href={`/inventory/opal/${r.opal_number}`}>{r.opal_number}</a
							>{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'quantity'}
						{r.status === 'completed' ? qty(r.quantity) : `(${qty(r.quantity)})`}
					{:else if col.key === 'status'}
						<State
							value={r.status}
							tone={r.status === 'completed' ? 'ok' : r.status === 'wip' ? 'info' : 'muted'}
						/>
					{:else}
						{@const v = (r as unknown as Record<string, unknown>)[col.key]}
						{#if v === null || v === undefined || v === ''}<span class="text-muted-foreground"
								>—</span
							>{:else}{v}{/if}
					{/if}
				{/snippet}
			</DataTable>
			{#if doc.can_finalize}
				<form
					class="flex flex-wrap items-end gap-3 border-t border-border p-3"
					onsubmit={(e) => {
						e.preventDefault();
						finalize();
					}}
				>
					<label class="grid grid-cols-1 gap-1">
						<span class="label">Storage location <span class="text-error">*</span></span>
						<Input bind:value={location} class="w-64 font-mono" placeholder="SHELF-A1" required />
					</label>
					<Button type="submit" disabled={busy || !location.trim()}>FINALIZE PRODUCTION</Button>
				</form>
			{/if}
		</Section>
	{:else if doc.outputs.length}
		<Section title="Assembly output" count={doc.outputs.length}>
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60 text-left">
						{#each ['PART', 'EXPECTED', 'QTY', 'LOCATION', 'LOT', 'SERIAL'] as h (h)}
							<th
								class="h-8 px-3 font-mono text-xs font-medium tracking-wider text-muted-foreground"
								>{h}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each doc.outputs as x (x.part_id)}
						{@const v = o(x.part_id, x.quantity)}
						<tr class="border-b border-border">
							<td class="px-3 py-1.5"
								><a class="font-mono text-info hover:underline" href={`/parts/${x.part_id}`}
									>{x.part_number}</a
								>
								{x.part_name}</td
							>
							<td class="px-3 py-1.5 font-mono">{qty(x.quantity)}</td>
							<td class="px-3 py-1.5"
								><Input
									type="number"
									min="0"
									step="any"
									class="h-7 w-24 font-mono"
									bind:value={v.qty}
									aria-label="Quantity"
								/></td
							>
							<td class="px-3 py-1.5"
								><Input class="h-7 w-36 font-mono" bind:value={v.loc} aria-label="Location" /></td
							>
							<td class="px-3 py-1.5"
								><Input class="h-7 w-28 font-mono" bind:value={v.lot} aria-label="Lot" /></td
							>
							<td class="px-3 py-1.5"
								><Input class="h-7 w-32 font-mono" bind:value={v.serial} aria-label="Serial" /></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if canConsume}
				<div class="border-t border-border p-3">
					<Button disabled={busy} onclick={produce}>RECORD OUTPUT</Button>
				</div>
			{/if}
		</Section>
	{/if}

	{#if !doc.material_relevant}
		<EmptyLine label="Material" />
	{/if}
</div>
