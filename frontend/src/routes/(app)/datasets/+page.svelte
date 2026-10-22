<script lang="ts">
	import { page } from '$app/state';
	import {
		DataTable,
		FilterBar,
		FilterSelect,
		ListFrame,
		PageHeader,
		Pagination,
		SearchInput,
		Timestamp,
		hasParams,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { DatasetSummary } from '#lib/components/datasets/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The API lists newest first and has no sort; headers sort the rows shown.
	const sort = urlSort(null);
	const FILTERS = ['q', 'procedure'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<DatasetSummary>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'procedure_name', label: 'Procedure', sortable: true },
		{
			key: 'fields',
			label: 'Fields',
			align: 'right',
			mono: true,
			sortValue: (r) => r.schema.fields?.length ?? 0
		},
		{ key: 'point_count', label: 'Points', align: 'right', mono: true, sortable: true },
		{ key: 'updated_at', label: 'Updated', sortable: true }
	];
</script>

<PageHeader title="Datasets">
	{#snippet meta()}
		<span class="mono"
			>{data.datasets.total} {data.datasets.total === 1 ? 'dataset' : 'datasets'}</span
		>
	{/snippet}
	{#snippet actions()}
		<Button href="/datasets/new" size="sm">+ NEW DATASET</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search datasets" placeholder="Search name" />
		<FilterSelect
			param="procedure"
			label="Procedure"
			allLabel="All procedures"
			options={data.procedures.map((p) => ({ value: String(p.id), label: p.name }))}
		/>
	</FilterBar>

	<DataTable
		rows={data.datasets.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		href={(r) => `/datasets/${r.id}`}
		emptyLabel="DATASETS"
		key={(r) => r.id}
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/datasets/new" class="font-medium text-info hover:underline">+ NEW DATASET</a>
			{/if}
		{/snippet}
		{#snippet cell(row, col)}
			{#if col.key === 'name'}
				<span class="font-medium">{row.name}</span>
			{:else if col.key === 'procedure_name'}
				{#if row.procedure_id}
					<a href={`/procedures/${row.procedure_id}`} class="text-info hover:underline"
						>{row.procedure_name}</a
					>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'fields'}
				{row.schema.fields?.length ?? 0}
			{:else if col.key === 'point_count'}
				{row.point_count}
			{:else if col.key === 'updated_at'}
				<Timestamp value={row.updated_at} />
			{/if}
		{/snippet}
	</DataTable>
	<Pagination total={data.datasets.total} pageSize={50} />
</ListFrame>
