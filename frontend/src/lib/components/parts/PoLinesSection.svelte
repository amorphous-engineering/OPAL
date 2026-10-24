<script lang="ts">
	// PO lines for this part. Expected on buy|both; renders whenever rows exist.
	import {
		ActionLink,
		DataTable,
		EmptyLine,
		Section,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { qty, unitMoney } from '#lib/format.js';
	import type { PartDetail, PartPoLine } from '@opal/shared';

	let { detail, lines }: { detail: PartDetail; lines: PartPoLine[] } = $props();

	// Context pre-fill: ordering from the part makes it the first line. Drafts cannot be ordered.
	const orderHref = $derived(
		detail.part.state === 'draft' ? undefined : `/purchases/new?part_id=${detail.part.id}`
	);

	const columns: Column<PartPoLine>[] = [
		{ key: 'po', label: 'PO', width: '9rem', mono: true },
		{ key: 'supplier', label: 'Supplier' },
		{ key: 'status', label: 'Status', width: '7rem' },
		{ key: 'received', label: 'Received', width: '7rem', align: 'right', mono: true },
		{ key: 'cost', label: 'Unit cost', width: '7rem', align: 'right', mono: true },
		{ key: 'target', label: 'Target', width: '7rem', mono: true }
	];
</script>

{#if lines.length}
	<Section title="PO lines" count={lines.length}>
		{#snippet actions()}
			{#if orderHref}<ActionLink href={orderHref}>+ ORDER</ActionLink>{/if}
		{/snippet}
		<DataTable
			rows={lines}
			{columns}
			key={(l) => l.lineId}
			href={(l) => `/purchases/${l.purchaseId}`}
			emptyLabel="PO LINES"
		>
			{#snippet cell(l, col)}
				{#if col.key === 'po'}
					<a href={`/purchases/${l.purchaseId}`} class="text-info hover:underline">{l.reference}</a>
				{:else if col.key === 'supplier'}
					{l.supplierName}
				{:else if col.key === 'status'}
					<State value={l.status} />
				{:else if col.key === 'received'}
					{qty(l.qtyReceived)}/{qty(l.qtyOrdered)}
				{:else if col.key === 'cost'}
					{#if l.unitCost === null}<span class="text-muted-foreground">—</span>{:else}{unitMoney(
							l.unitCost
						)}{/if}
				{:else if l.targetDate}
					<Timestamp value={l.targetDate} dateOnly />
				{:else}
					<span class="text-muted-foreground">—</span>
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{:else if detail.expects.poLines}
	<EmptyLine label="PO LINES" addHref={orderHref} addLabel="+ ORDER" />
{/if}
