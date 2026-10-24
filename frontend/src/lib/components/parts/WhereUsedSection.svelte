<script lang="ts">
	// The assemblies that use this part. Always rendered: an unused part is information.
	import { DataTable, EmptyLine, Section, type Column } from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import type { BomLine, PartDetail } from '@opal/shared';

	let { detail }: { detail: PartDetail } = $props();
	const lines = $derived(detail.whereUsed);

	const columns: Column<BomLine>[] = [
		{ key: 'pn', label: 'PN', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'qty', label: 'Qty', width: '5rem', align: 'right', mono: true },
		{ key: 'ref', label: 'Refdes', width: '8rem', mono: true }
	];
</script>

{#if lines.length}
	<Section title="Where used" count={lines.length}>
		<DataTable
			rows={lines}
			{columns}
			key={(l) => l.id}
			href={(l) => `/parts/${l.assemblyId}`}
			emptyLabel="WHERE USED"
		>
			{#snippet cell(l, col)}
				{#if col.key === 'pn'}
					<a href={`/parts/${l.assemblyId}`} class="text-info hover:underline">{l.assemblyPn}</a>
				{:else if col.key === 'name'}
					{l.assemblyName}
				{:else if col.key === 'qty'}
					{qty(l.quantity)}
				{:else if l.referenceDesignator}
					{l.referenceDesignator}
				{:else}
					<span class="text-muted-foreground">—</span>
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{:else}
	<EmptyLine label="WHERE USED" empty="Not used in any assembly." />
{/if}
