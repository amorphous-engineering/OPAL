<script lang="ts">
	// The variant family: the parts that share this part's base number. The server sends the
	// base and the members ready to show; the page never parses a number.
	import {
		DataTable,
		DetailRow,
		DetailTable,
		Section,
		State,
		type Column
	} from '#lib/components/opal/index.js';
	import type { PartDetail } from '@opal/shared';

	let { detail }: { detail: PartDetail } = $props();
	const family = $derived(detail.family);
	type Member = PartDetail['family']['members'][number];

	const columns: Column<Member>[] = [
		{ key: 'pn', label: 'PN', width: '11rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'state', label: 'Status', width: '7rem' }
	];
</script>

{#if family.variants || family.members.length > 1}
	<Section title="Variants" count={family.members.length}>
		<DetailTable>
			<DetailRow label="Base PN" mono>
				<a
					href={`/parts?q=${encodeURIComponent(family.baseNumber)}`}
					class="text-info hover:underline">{family.baseNumber}</a
				>
			</DetailRow>
		</DetailTable>
		<div class="border-t border-border">
			<DataTable
				rows={family.members}
				{columns}
				key={(m) => m.id}
				href={(m) => (m.id === detail.part.id ? null : `/parts/${m.id}`)}
				rowClass={(m) => (m.id === detail.part.id ? 'bg-muted/40' : undefined)}
				emptyLabel="VARIANTS"
				dense
			>
				{#snippet cell(m, col)}
					{#if col.key === 'pn'}
						{#if m.id === detail.part.id}
							{m.internalPn}
						{:else}
							<a href={`/parts/${m.id}`} class="text-info hover:underline">{m.internalPn}</a>
						{/if}
					{:else if col.key === 'name'}
						{m.name}
					{:else if m.state === 'draft'}
						<State value="draft" tone="warn" badge />
					{:else if m.state === 'obsolete'}
						<State value="obsolete" tone="error" />
					{:else}
						<State value="active" tone="muted" />
					{/if}
				{/snippet}
			</DataTable>
		</div>
	</Section>
{/if}
