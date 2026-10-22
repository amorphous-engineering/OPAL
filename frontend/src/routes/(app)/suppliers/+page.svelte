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
		hasParams,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { LIST_PAGE_SIZE, type Supplier } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort(null);
	const FILTERS = ['q', 'active'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<Supplier>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'code', label: 'Code', sortable: true, mono: true },
		{ key: 'email', label: 'Email' },
		{ key: 'phone', label: 'Phone', mono: true },
		{ key: 'part_count', label: 'Parts', align: 'right', mono: true },
		{ key: 'purchase_count', label: 'Purchases', align: 'right', mono: true },
		{ key: 'is_active', label: 'Status' }
	];
</script>

<PageHeader title="Suppliers">
	{#snippet meta()}
		<span class="mono">{data.total} {data.total === 1 ? 'supplier' : 'suppliers'}</span>
	{/snippet}
	{#snippet actions()}
		<Button size="sm" href="/suppliers/new">+ NEW SUPPLIER</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search suppliers" placeholder="Name, code or email" />
		<FilterSelect
			param="active"
			label="Status"
			allLabel="All statuses"
			options={[
				{ value: 'true', label: 'ACTIVE' },
				{ value: 'false', label: 'INACTIVE' }
			]}
		/>
	</FilterBar>

	<DataTable
		rows={data.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		serverSort
		href={(s) => `/suppliers/${s.id}`}
		key={(s) => s.id}
		emptyLabel="SUPPLIERS"
		emptyAction={addAction}
	>
		{#snippet cell(s, col)}
			{#if col.key === 'name'}
				<span class="text-info">{s.name}</span>
			{:else if col.key === 'is_active'}
				{#if !s.is_active}<State value="inactive" tone="muted" badge />{/if}
			{:else}
				{@const v = (s as unknown as Record<string, unknown>)[col.key]}
				{#if v === null || v === undefined || v === ''}<span class="text-muted-foreground">—</span
					>{:else}{v}{/if}
			{/if}
		{/snippet}
	</DataTable>

	<Pagination total={data.total} pageSize={LIST_PAGE_SIZE} />
</ListFrame>

{#snippet addAction()}
	{#if filtered}
		<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
	{:else}
		<a href="/suppliers/new" class="font-medium text-info hover:underline">+ NEW SUPPLIER</a>
	{/if}
{/snippet}
