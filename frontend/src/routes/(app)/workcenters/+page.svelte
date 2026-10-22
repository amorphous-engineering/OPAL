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
		hasParams,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { Workcenter } from '#lib/components/workcenters/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort(null);
	const FILTERS = ['q', 'status'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const rows = $derived(
		data.workcenters.filter((w) =>
			data.status === 'all' ? true : data.status === 'inactive' ? !w.is_active : w.is_active
		)
	);

	const columns: Column<Workcenter>[] = [
		{ key: 'code', label: 'Code', mono: true, sortable: true, width: '7rem' },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'location', label: 'Location', sortable: true },
		{
			key: 'default_step_count',
			label: 'Default steps',
			align: 'right',
			mono: true,
			sortable: true
		},
		{ key: 'queued_step_count', label: 'Queued', align: 'right', mono: true, sortable: true },
		{ key: 'is_active', label: 'Status', width: '6rem' }
	];
</script>

<PageHeader title="Workcenters">
	{#snippet meta()}
		<span class="mono">{rows.length} {rows.length === 1 ? 'workcenter' : 'workcenters'}</span>
	{/snippet}
	{#snippet actions()}
		<Button href="/workcenters/new" size="sm">+ NEW WORKCENTER</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search workcenters" placeholder="Search code or name" />
		<FilterSelect
			param="status"
			label="Status"
			allLabel=""
			fallback="active"
			options={[
				{ value: 'active', label: 'ACTIVE' },
				{ value: 'inactive', label: 'INACTIVE' },
				{ value: 'all', label: 'ALL' }
			]}
		/>
	</FilterBar>

	<DataTable
		{rows}
		{columns}
		bind:sort={() => sort.value, sort.set}
		href={(r) => `/workcenters/${r.id}`}
		emptyLabel="WORKCENTERS"
		key={(r) => r.id}
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/workcenters/new" class="font-medium text-info hover:underline">+ NEW WORKCENTER</a
				>
			{/if}
		{/snippet}
		{#snippet cell(row, col)}
			{#if col.key === 'code'}
				<span class="text-info">{row.code}</span>
			{:else if col.key === 'is_active'}
				<!-- Active is the norm; only the exception is stated. -->
				{#if !row.is_active}<State value="inactive" tone="muted" />{/if}
			{:else}
				{@const v = (row as unknown as Record<string, string | number | null>)[col.key]}
				{#if v === null || v === ''}<span class="text-muted-foreground">—</span>{:else}{v}{/if}
			{/if}
		{/snippet}
	</DataTable>
</ListFrame>
