<script lang="ts">
	// What was consumed of this part, newest first, with the work order behind each move.
	import {
		DataTable,
		EmptyLine,
		Section,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { qtyUnit, stateLabel } from '#lib/format.js';
	import type { PartConsumption } from '@opal/shared';

	let { items, total }: { items: PartConsumption[]; total: number } = $props();

	const columns: Column<PartConsumption>[] = [
		{ key: 'at', label: 'Consumed', width: '11rem' },
		{ key: 'qty', label: 'Qty', width: '9rem', align: 'right', mono: true },
		{ key: 'opal', label: 'OPAL', width: '9rem', mono: true },
		{ key: 'wo', label: 'Work order', width: '9rem', mono: true },
		{ key: 'by', label: 'By', width: '10rem' },
		{ key: 'notes', label: 'Notes' }
	];
</script>

{#if items.length}
	<Section title="Consumed" count={total > items.length ? `${items.length} of ${total}` : total}>
		<DataTable rows={items} {columns} key={(c) => c.id} emptyLabel="CONSUMED">
			{#snippet cell(c, col)}
				{#if col.key === 'at'}
					<Timestamp value={c.at} />
				{:else if col.key === 'qty'}
					{qtyUnit(c.quantity, c.unitOfMeasure)}
					{#if c.usage === 'tooling'}<span class="ml-1 text-xs text-muted-foreground"
							>{stateLabel(c.usage)}</span
						>{/if}
				{:else if col.key === 'opal'}
					<a href={`/inventory/opal/${c.opalNumber}`} class="text-info hover:underline"
						>{c.opalNumber}</a
					>
				{:else if col.key === 'wo'}
					{#if c.executionId}<a
							href={`/executions/${c.executionId}`}
							class="text-info hover:underline">{c.woNumber}</a
						>{:else}<span class="text-quiet">—</span>{/if}
				{:else if col.key === 'by'}
					{#if c.actorName}{c.actorName}{:else}<span class="text-quiet">—</span>{/if}
				{:else if c.notes}
					{c.notes}
				{:else}
					<span class="text-quiet">—</span>
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{:else}
	<EmptyLine label="CONSUMED" empty="Nothing consumed." />
{/if}
