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
		State,
		Timestamp,
		hasParams,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ProcedureRow } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort({ key: 'updated_at', dir: 'desc' });
	const FILTERS = ['q', 'status', 'type'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<ProcedureRow>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'procedure_type', label: 'Type', sortable: true, width: '6rem', mono: true },
		{ key: 'status', label: 'Status', sortable: true, width: '8rem' },
		{ key: 'current_version_number', label: 'Version', sortable: true, width: '6rem', mono: true },
		{
			key: 'step_count',
			label: 'Steps',
			sortable: true,
			align: 'right',
			width: '5rem',
			mono: true
		},
		{
			key: 'execution_count',
			label: 'Executions',
			sortable: true,
			align: 'right',
			width: '7rem',
			mono: true
		},
		{ key: 'updated_at', label: 'Updated', sortable: true, width: '10rem' }
	];
</script>

<PageHeader title="Templates">
	{#snippet meta()}
		<span class="mono"
			>{data.result.total} {data.result.total === 1 ? 'template' : 'templates'}</span
		>
	{/snippet}
	{#snippet actions()}
		<Button size="sm" href="/procedures/new">+ NEW TEMPLATE</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search templates" placeholder="Search name or description" />
		<FilterSelect
			param="type"
			label="Type"
			allLabel="All types"
			options={[
				{ value: 'op', label: 'OP' },
				{ value: 'build', label: 'BUILD' }
			]}
		/>
		<FilterSelect
			param="status"
			label="Status"
			allLabel="All statuses"
			options={[
				{ value: 'draft', label: 'DRAFT' },
				{ value: 'active', label: 'ACTIVE' },
				{ value: 'deprecated', label: 'DEPRECATED' }
			]}
		/>
	</FilterBar>

	<DataTable
		rows={data.result.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		serverSort
		emptyLabel="TEMPLATES"
		key={(r) => r.id}
		href={(r) => `/procedures/${r.id}`}
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/procedures/new" class="font-medium text-info hover:underline">+ NEW TEMPLATE</a>
			{/if}
		{/snippet}
		{#snippet cell(r, col)}
			{#if col.key === 'name'}
				<a href={`/procedures/${r.id}`} class="font-medium text-info hover:underline">{r.name}</a>
			{:else if col.key === 'procedure_type'}
				{r.procedure_type.toUpperCase()}
			{:else if col.key === 'status'}
				<State value={r.status} />
			{:else if col.key === 'current_version_number'}
				{#if r.current_version_number}v{r.current_version_number}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			{:else if col.key === 'updated_at'}
				<Timestamp value={r.updated_at} />
			{:else}
				{(r as unknown as Record<string, unknown>)[col.key]}
			{/if}
		{/snippet}
	</DataTable>
	<Pagination total={data.result.total} pageSize={data.result.page_size ?? 50} />
</ListFrame>
