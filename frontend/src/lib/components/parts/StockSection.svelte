<script lang="ts">
	// Stock: on-hand by location, each row linking into its record. Always relevant (empty is
	// one line). Receiving is a commitment, so a draft part offers no add.
	import {
		ActionLink,
		DataTable,
		EmptyLine,
		Section,
		State,
		type Column
	} from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import type { PartDetail, StockRecord } from '@opal/shared';

	let { detail, records }: { detail: PartDetail; records: StockRecord[] } = $props();
	const part = $derived(detail.part);
	const receiveHref = $derived(
		part.state === 'active' ? `/inventory/new?part_id=${part.id}` : undefined
	);

	const total = $derived(records.reduce((s, r) => s + Number(r.balance), 0));
	const low = $derived(part.reorderPoint !== null && total < Number(part.reorderPoint));
	const showStatus = $derived(records.some((r) => status(r) !== null));

	const columns: Column<StockRecord>[] = [
		{ key: 'opal', label: 'OPAL #', width: '9rem', mono: true },
		{ key: 'location', label: 'Location', mono: true },
		{ key: 'lot', label: 'Lot / serial', width: '12rem', mono: true },
		{ key: 'status', label: 'Status', width: '8rem' },
		{ key: 'qty', label: 'Qty', width: '8rem', align: 'right', mono: true }
	];
	const visible = $derived(showStatus ? columns : columns.filter((c) => c.key !== 'status'));

	function status(r: StockRecord): { label: string; tone: 'error' | 'warn' } | null {
		if (r.isExpired) return { label: 'EXPIRED', tone: 'error' };
		if (r.calibrationStatus === 'overdue') return { label: 'CAL OVERDUE', tone: 'error' };
		if (r.calibrationStatus === 'due_soon') return { label: 'CAL DUE', tone: 'warn' };
		return null;
	}
</script>

{#if records.length}
	<Section title="Stock" count={records.length}>
		{#snippet actions()}
			{#if low}<State value="low" tone="warn" badge label="LOW" />{/if}
			<ActionLink href={`/inventory?part_id=${part.id}`} class="mr-2">INVENTORY →</ActionLink>
			{#if receiveHref}<ActionLink href={receiveHref}>+ RECEIVE</ActionLink>{/if}
		{/snippet}
		<DataTable
			rows={records}
			columns={visible}
			key={(r) => r.id}
			href={(r) => `/inventory/opal/${r.opalNumber}`}
			emptyLabel="STOCK"
		>
			{#snippet cell(r, col)}
				{#if col.key === 'opal'}
					<a href={`/inventory/opal/${r.opalNumber}`} class="text-info hover:underline"
						>{r.opalNumber}</a
					>
				{:else if col.key === 'location'}
					{r.location}
				{:else if col.key === 'lot'}
					{r.serialNumber ?? r.lotNumber ?? '—'}
				{:else if col.key === 'status'}
					{@const s = status(r)}
					{#if s}<State value={s.label} tone={s.tone} label={s.label} />{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				{:else}
					{qty(r.balance, part.unitOfMeasure)}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{:else}
	<EmptyLine label="STOCK" addHref={receiveHref} addLabel="+ RECEIVE" />
{/if}
