<script lang="ts">
	// Stock: on-hand summarised by location, each row linking into inventory.
	// Always relevant (empty = one line). Receiving is a commitment, so a draft
	// part offers no add: the draft banner carries the remedy.
	import { onMount } from 'svelte';
	import { DataTable, EmptyLine, Section, State, type Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import { qty } from '#lib/format.js';
	import ActionLink from './ActionLink.svelte';
	import FormField from './FormField.svelte';
	import { act } from './actions.js';
	import type { PartDetail, StockRecord } from './types.js';

	let { detail }: { detail: PartDetail } = $props();
	const part = $derived(detail.part);
	const isDraft = $derived(part.lifecycle_state === 'draft');

	interface Group {
		location: string;
		records: StockRecord[];
		quantity: number;
	}
	const groups = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not reactive state
		const map = new Map<string, Group>();
		for (const r of detail.stock) {
			const g = map.get(r.location) ?? { location: r.location, records: [], quantity: 0 };
			g.records.push(r);
			g.quantity += Number(r.quantity);
			map.set(r.location, g);
		}
		return [...map.values()];
	});

	const columns: Column<Group>[] = [
		{ key: 'location', label: 'Location' },
		{ key: 'opal', label: 'OPAL #', width: '12rem', mono: true },
		{ key: 'lot', label: 'Lot', width: '9rem', mono: true },
		{ key: 'status', label: 'Status', width: '8rem' },
		{ key: 'qty', label: 'Qty', width: '7rem', align: 'right', mono: true }
	];
	const showStatus = $derived(
		detail.stock.some(
			(r) =>
				r.is_expired || r.calibration_status === 'overdue' || r.calibration_status === 'due_soon'
		)
	);
	const visible = $derived(showStatus ? columns : columns.filter((c) => c.key !== 'status'));

	function status(g: Group): { label: string; tone: 'error' | 'warn' } | null {
		if (g.records.some((r) => r.is_expired)) return { label: 'EXPIRED', tone: 'error' };
		if (g.records.some((r) => r.calibration_status === 'overdue'))
			return { label: 'CAL OVERDUE', tone: 'error' };
		if (g.records.some((r) => r.calibration_status === 'due_soon'))
			return { label: 'CAL DUE', tone: 'warn' };
		return null;
	}

	function lots(g: Group): string[] {
		return [...new Set(g.records.map((r) => r.lot_number).filter((l): l is string => !!l))];
	}

	let adding = $state(false);
	let rQty = $state('');
	let rLocation = $state('');
	let rLot = $state('');
	let busy = $state(false);
	let locations = $state<string[]>([]);

	onMount(() => {
		api
			.get<{ location: string }[]>('/inventory/locations')
			.then((r) => (locations = r.map((l) => l.location)))
			.catch(() => {});
	});

	async function receive(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await act(
			() =>
				api.post('/inventory', {
					part_id: part.id,
					quantity: Number(rQty),
					location: rLocation.trim(),
					lot_number: rLot.trim() || null
				}),
			'Stock received'
		);
		busy = false;
		if (ok) {
			rQty = '';
			rLot = '';
			adding = false;
		}
	}

	const total = $derived(detail.stock.reduce((s, r) => s + Number(r.quantity), 0));
	const inventoryHref = $derived(`/inventory?part_id=${part.id}`);
</script>

{#snippet receiveForm()}
	<form
		class="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-2"
		onsubmit={receive}
	>
		<FormField label="Qty" for="rs-qty" class="w-24">
			<Input id="rs-qty" type="number" min="0" step="any" bind:value={rQty} required />
		</FormField>
		<FormField label="Location" for="rs-location" class="w-48">
			<Input
				id="rs-location"
				class="font-mono"
				list="rs-locations"
				bind:value={rLocation}
				required
			/>
			<datalist id="rs-locations">
				{#each locations as l (l)}<option value={l}></option>{/each}
			</datalist>
		</FormField>
		<FormField label="Lot" for="rs-lot" class="w-40">
			<Input id="rs-lot" class="font-mono" bind:value={rLot} />
		</FormField>
		<Button type="submit" size="sm" disabled={busy}>RECEIVE</Button>
		<a
			href={`/inventory/new?part_id=${part.id}`}
			class="pb-2 font-mono text-xs font-medium text-info hover:underline">RECEIVE STOCK</a
		>
	</form>
{/snippet}

{#if detail.stock.length}
	<Section title="Stock" count={`${qty(total, part.unit_of_measure)} · ${detail.stock.length} rec`}>
		{#snippet actions()}
			{#if part.is_low_stock}
				<span title={`Reorder point ${qty(part.reorder_point)}`}
					><State value="low" tone="warn" badge label="LOW" /></span
				>
			{/if}
			<ActionLink href={inventoryHref} class="mr-2">INVENTORY →</ActionLink>
			<ActionLink
				onclick={() => (adding = !adding)}
				disabled={isDraft}
				title={isDraft ? 'Draft part: activate to receive stock' : undefined}
				>{adding ? 'CANCEL' : '+ ADD'}</ActionLink
			>
		{/snippet}
		<DataTable
			rows={groups}
			columns={visible}
			key={(g) => g.location}
			href={(g) =>
				g.records.length === 1 && g.records[0].opal_number
					? `/inventory/opal/${g.records[0].opal_number}`
					: `/inventory?part_id=${part.id}&location=${encodeURIComponent(g.location)}`}
			emptyLabel="STOCK"
		>
			{#snippet cell(g, col)}
				{#if col.key === 'location'}
					{g.location}
					{#if g.records.length > 1}<span class="mono ml-2 text-xs text-muted-foreground"
							>{g.records.length} rec</span
						>{/if}
				{:else if col.key === 'opal'}
					{#if g.records.length === 1 && g.records[0].opal_number}
						<a
							href={`/inventory/opal/${g.records[0].opal_number}`}
							class="text-info hover:underline">{g.records[0].opal_number}</a
						>
					{:else}
						<span class="text-muted-foreground">{g.records.length} records</span>
					{/if}
				{:else if col.key === 'lot'}
					{@const l = lots(g)}
					{#if l.length === 1}{l[0]}{:else if l.length > 1}<span class="text-muted-foreground"
							>{l.length} lots</span
						>{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'status'}
					{@const s = status(g)}
					{#if s}<State value={s.label} tone={s.tone} label={s.label} />{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				{:else}
					{qty(g.quantity)}
				{/if}
			{/snippet}
		</DataTable>
		{#if adding}{@render receiveForm()}{/if}
	</Section>
{:else}
	<div>
		<EmptyLine label="STOCK" onadd={isDraft ? undefined : () => (adding = true)} />
		{#if adding}{@render receiveForm()}{/if}
	</div>
{/if}
