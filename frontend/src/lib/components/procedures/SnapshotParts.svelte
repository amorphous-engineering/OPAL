<script lang="ts">
	// A published version's kit or outputs: part, name and quantity as frozen at publish.
	import { DataTable, EmptyLine, Section } from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import type { VersionPart } from '@opal/shared';

	interface PartRow {
		partId: number;
		quantity: string;
	}

	let {
		title,
		rows,
		parts,
		qtyLabel
	}: { title: string; rows: PartRow[]; parts: VersionPart[]; qtyLabel: string } = $props();

	const partById = $derived(new Map(parts.map((p) => [p.id, p])));
	const columns = $derived<Column<PartRow>[]>([
		{ key: 'pn', label: 'PN', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'quantity', label: qtyLabel, align: 'right', width: '8rem', mono: true }
	]);
</script>

{#if rows.length === 0}
	<EmptyLine label={title} />
{:else}
	<Section {title} count={rows.length}>
		<DataTable {rows} {columns} emptyLabel={title} dense key={(r) => r.partId}>
			{#snippet cell(r, col)}
				{#if col.key === 'pn'}
					<a href={`/parts/${r.partId}`} class="text-info hover:underline"
						>{partById.get(r.partId)?.internalPn ?? '—'}</a
					>
				{:else if col.key === 'name'}
					{partById.get(r.partId)?.name ?? '—'}
				{:else}
					{qty(r.quantity, partById.get(r.partId)?.unitOfMeasure)}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{/if}
