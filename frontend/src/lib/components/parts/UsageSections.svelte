<script lang="ts">
	// Where the part stands in purchasing and where it is used: PO lines
	// (expected on buy|both), where-used, procedure use, consumption.
	import {
		DataTable,
		EmptyLine,
		Section,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { money, qty, stateLabel } from '#lib/format.js';
	import type { BomLine, Consumption, PartDetail, PoLine, ProcedureUse } from './types.js';

	let { detail, group }: { detail: PartDetail; group: 'purchasing' | 'usage' } = $props();

	const dash = '—';

	const poColumns: Column<PoLine>[] = [
		{ key: 'po', label: 'PO', width: '9rem', mono: true },
		{ key: 'supplier', label: 'Supplier' },
		{ key: 'status', label: 'Status', width: '7rem' },
		{ key: 'received', label: 'Received', width: '7rem', align: 'right', mono: true },
		{ key: 'cost', label: 'Unit cost', width: '7rem', align: 'right', mono: true },
		{ key: 'target', label: 'Target', width: '7rem', mono: true }
	];
	const usedColumns: Column<BomLine>[] = [
		{ key: 'pn', label: 'PN', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'qty', label: 'Qty', width: '5rem', align: 'right', mono: true },
		{ key: 'ref', label: 'Refdes', width: '8rem', mono: true }
	];
	const procColumns: Column<ProcedureUse>[] = [
		{ key: 'name', label: 'Procedure' },
		{ key: 'step', label: 'Step', width: '5rem', mono: true },
		{ key: 'role', label: 'Role', width: '7rem' },
		{ key: 'qty', label: 'Qty', width: '5rem', align: 'right', mono: true },
		{ key: 'status', label: 'Status', width: '7rem' }
	];
	const consColumns: Column<Consumption>[] = [
		{ key: 'date', label: 'Consumed', width: '10rem' },
		{ key: 'qty', label: 'Qty', width: '5rem', align: 'right', mono: true },
		{ key: 'opal', label: 'OPAL #', width: '11rem', mono: true },
		{ key: 'source', label: 'Source', width: '9rem', mono: true },
		{ key: 'notes', label: 'Notes' }
	];
</script>

{#snippet muted(text?: string | null)}
	{#if text}{text}{:else}<span class="text-muted-foreground">{dash}</span>{/if}
{/snippet}

<!-- PO LINES -->
{#if group === 'purchasing'}
	{#if detail.po_lines.length}
		<Section title="PO lines" count={detail.po_lines.length}>
			<DataTable
				rows={detail.po_lines}
				columns={poColumns}
				key={(l) => l.line_id}
				href={(l) => `/purchases/${l.purchase_id}`}
				emptyLabel="PO LINES"
			>
				{#snippet cell(l, col)}
					{#if col.key === 'po'}
						<a href={`/purchases/${l.purchase_id}`} class="text-info hover:underline"
							>{l.reference ?? dash}</a
						>
					{:else if col.key === 'supplier'}
						{l.supplier}
					{:else if col.key === 'status'}
						<State value={l.status} />
					{:else if col.key === 'received'}
						{qty(l.qty_received)}/{qty(l.qty_ordered)}
					{:else if col.key === 'cost'}
						{@render muted(l.unit_cost === null ? null : money(l.unit_cost))}
					{:else}
						{#if l.target_date}<Timestamp
								value={l.target_date}
								dateOnly
							/>{:else}{@render muted()}{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else if detail.expects.po_lines}
		<EmptyLine label="PO LINES" />
	{/if}
{:else}
	<!-- WHERE USED -->
	{#if detail.where_used.length}
		<Section title="Where used" count={detail.where_used.length}>
			<DataTable
				rows={detail.where_used}
				columns={usedColumns}
				key={(l) => l.id}
				href={(l) => `/parts/${l.assembly_id}`}
				emptyLabel="WHERE USED"
			>
				{#snippet cell(l, col)}
					{#if col.key === 'pn'}
						<a href={`/parts/${l.assembly_id}`} class="text-info hover:underline"
							>{l.assembly_internal_pn ?? dash}</a
						>
					{:else if col.key === 'name'}
						{l.assembly_name}
					{:else if col.key === 'qty'}
						{qty(l.quantity)}
					{:else}
						{@render muted(l.reference_designator)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine label="WHERE USED" />
	{/if}

	<!-- PROCEDURE USE -->
	{#if detail.procedure_use.length}
		<Section title="Procedure use" count={detail.procedure_use.length}>
			<DataTable
				rows={detail.procedure_use}
				columns={procColumns}
				key={(u) => `${u.procedure_id}-${u.role}-${u.step_number}`}
				href={(u) => `/procedures/${u.procedure_id}`}
				emptyLabel="PROCEDURE USE"
			>
				{#snippet cell(u, col)}
					{#if col.key === 'name'}
						<a href={`/procedures/${u.procedure_id}`} class="text-info hover:underline"
							>{u.procedure_name}</a
						>
					{:else if col.key === 'step'}
						{@render muted(u.step_number)}
					{:else if col.key === 'role'}
						<span class="font-mono text-xs text-muted-foreground">{stateLabel(u.role)}</span>
					{:else if col.key === 'qty'}
						{qty(u.quantity)}
					{:else}
						<State value={u.procedure_status} />
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine label="PROCEDURE USE" />
	{/if}

	<!-- CONSUMED -->
	{#if detail.consumption.length}
		<Section
			title="Consumed"
			count={`${detail.consumption.length}${detail.consumption_truncated ? '+' : ''}`}
		>
			<DataTable
				rows={detail.consumption}
				columns={consColumns}
				key={(c) => c.id}
				emptyLabel="CONSUMED"
			>
				{#snippet cell(c, col)}
					{#if col.key === 'date'}
						<Timestamp value={c.consumed_at} />
					{:else if col.key === 'qty'}
						{qty(c.quantity)}
					{:else if col.key === 'opal'}
						{#if c.opal_number}<a
								href={`/inventory/opal/${c.opal_number}`}
								class="text-info hover:underline">{c.opal_number}</a
							>{:else}{@render muted()}{/if}
					{:else if col.key === 'source'}
						{#if c.execution_id}<a
								href={`/executions/${c.execution_id}`}
								class="text-info hover:underline">{c.work_order_number ?? 'EXECUTION'}</a
							>{:else}<span class="text-muted-foreground">MANUAL</span>{/if}
					{:else}
						{@render muted(c.notes)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine label="CONSUMED" />
	{/if}
{/if}
