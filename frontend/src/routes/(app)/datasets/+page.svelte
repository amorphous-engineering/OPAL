<script lang="ts">
	import { page } from '$app/state';
	import {
		DataTable,
		FilterBar,
		FilterSelect,
		ListFrame,
		PageHeader,
		SearchInput,
		State,
		Timestamp,
		hasParams,
		setQuery,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { Dataset } from '#lib/components/datasets/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The API lists newest first and has no sort; headers sort the rows shown.
	const sort = urlSort(null);
	const FILTERS = ['q', 'project', 'procedure', 'state']; // project added by projects
	const procedureName = (id: number | null) => data.procedures.find((p) => p.id === id)?.name ?? `Procedure ${id}`;
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<Dataset>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'project', label: 'Project', mono: true, width: '7rem' }, // added by projects
		{ key: 'procedure', label: 'Procedure', sortValue: (r) => (r.procedureId ? procedureName(r.procedureId) : '') , sortable: true },
		{
			key: 'fields',
			label: 'Fields',
			align: 'right',
			mono: true,
			sortValue: (r) => r.schema.fields.length
		},
		{ key: 'pointCount', label: 'Points', align: 'right', mono: true, sortable: true },
		{ key: 'state', label: 'State', width: '5.5rem', sortable: true },
		{ key: 'updatedAt', label: 'Updated', sortable: true }
	];
</script>

<PageHeader title="Datasets">
	{#snippet meta()}
		{@const shown = data.list.items.length}
		<span class="mono">{shown}{data.list.next ? '+' : ''} {shown === 1 ? 'dataset' : 'datasets'}</span>
	{/snippet}
	{#snippet actions()}
		<Button
			href={page.url.searchParams.get('project')
				? `/datasets/new?projectId=${page.url.searchParams.get('project')}`
				: '/datasets/new'}
			size="sm">+ NEW DATASET</Button
		>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search datasets" placeholder="Search name" />
		<!-- added by projects -->
		<FilterSelect
			param="project"
			label="Project"
			allLabel="All projects"
			options={data.projects.map((p) => ({ value: String(p.id), label: p.code }))}
		/>
		<FilterSelect
			param="state"
			label="State"
			allLabel="All states"
			options={[
				{ value: 'active', label: 'ACTIVE' },
				{ value: 'archived', label: 'ARCHIVED' }
			]}
		/>
		<FilterSelect
			param="procedure"
			label="Procedure"
			allLabel="All procedures"
			options={data.procedures.map((p) => ({ value: String(p.id), label: p.name }))}
		/>
	</FilterBar>

	<DataTable
		rows={data.list.items}
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
			{:else if col.key === 'project'}
				{row.projectCode}
			{:else if col.key === 'procedure'}
				{#if row.procedureId}
					<a href={`/procedures/${row.procedureId}`} class="text-info hover:underline"
						>{procedureName(row.procedureId)}</a
					>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'fields'}
				{row.schema.fields.length}
			{:else if col.key === 'pointCount'}
				{row.pointCount}
			{:else if col.key === 'state'}
				{#if row.state === 'archived'}
					<State value="archived" tone="warn" badge />
				{:else}
					<span class="font-mono text-xs text-muted-foreground">ACTIVE</span>
				{/if}
			{:else if col.key === 'updatedAt'}
				<Timestamp value={row.updatedAt} />
			{/if}
		{/snippet}
	</DataTable>
	{#if data.page > 1 || data.list.next}
		<nav
			aria-label="Pages"
			class="flex items-center gap-3 border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground"
		>
			<span class="tabular-nums">PAGE {data.page}</span>
			<div class="ml-auto flex items-center gap-2">
				<Button
					variant="outline"
					size="xs"
					disabled={data.page <= 1}
					onclick={() => setQuery({ page: null, cursor: null })}>← FIRST</Button
				>
				<Button
					variant="outline"
					size="xs"
					disabled={!data.list.next}
					onclick={() => setQuery({ page: data.page + 1, cursor: data.list.next })}>NEXT →</Button
				>
			</div>
		</nav>
	{/if}
</ListFrame>
