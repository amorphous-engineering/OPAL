<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		DataTable,
		PageHeader,
		Section,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import type { EventSummary } from '#lib/components/requirements/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const columns: Column<EventSummary>[] = [
		{ key: 'created_at', label: 'When', sortable: true, width: '11rem' },
		{ key: 'label', label: 'Label', sortable: true },
		{ key: 'locked', label: 'Locked', mono: true, sortable: true, align: 'right', width: '6rem' },
		{
			key: 'revised',
			label: 'Revisions',
			mono: true,
			sortable: true,
			align: 'right',
			width: '6rem'
		},
		{ key: 'signed_by', label: 'Signed by', sortable: true, width: '12rem' },
		{ key: 'note', label: 'Note' }
	];
	let sort = $state<{ key: string; dir: 'asc' | 'desc' } | null>({
		key: 'created_at',
		dir: 'desc'
	});
</script>

<PageHeader
	title="Baselines"
	crumbs={[{ label: 'Requirements', href: '/requirements' }, { label: 'Baselines' }]}
>
	{#snippet actions()}
		<Button size="sm" variant="outline" href="/requirements">REQUIREMENTS</Button>
	{/snippet}
</PageHeader>

<div class="p-4">
	<Section title="BASELINE EVENTS" count={data.events.length}>
		<DataTable
			rows={data.events}
			{columns}
			bind:sort
			href={(e) => `/requirements/baselines/${e.id}`}
			key={(e) => e.id}
			emptyLabel="Baseline events"
			dense
		>
			{#snippet cell(e, col)}
				{#if col.key === 'created_at'}<Timestamp value={e.created_at} />
				{:else if col.key === 'label'}<span class="mono">{e.label ?? '—'}</span>
				{:else if col.key === 'note'}<span class="line-clamp-1 text-xs">{e.note ?? '—'}</span>
				{:else}{(e as unknown as Record<string, unknown>)[col.key] ?? '—'}{/if}
			{/snippet}
		</DataTable>
	</Section>
</div>
