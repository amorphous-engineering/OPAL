<script lang="ts">
	import { page } from '$app/state';
	import {
		DataTable,
		FilterBar,
		FilterDate,
		FilterSelect,
		FilterToggle,
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
	import { money, stateLabel } from '#lib/format.js';
	import {
		LIST_PAGE_SIZE,
		PURCHASE_STATUSES,
		type PurchaseListItem
	} from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort(null);
	const FILTERS = ['q', 'status', 'supplier_id', 'overdue', 'target_from', 'target_to'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<PurchaseListItem>[] = [
		{ key: 'reference', label: 'Reference', sortable: true, mono: true },
		{ key: 'supplier', label: 'Supplier', sortable: true },
		{ key: 'status', label: 'Status', sortable: true },
		{ key: 'targetDate', label: 'Target', sortable: true, mono: true },
		{ key: 'lines', label: 'Lines received', align: 'right', mono: true },
		{ key: 'totalCost', label: 'Total', align: 'right', mono: true },
		{ key: 'orderedAt', label: 'Ordered', sortable: true }
	];
</script>

<PageHeader title="Purchases">
	{#snippet meta()}
		<span class="mono">{data.total} {data.total === 1 ? 'purchase' : 'purchases'}</span>
	{/snippet}
	{#snippet actions()}
		<Button size="sm" href="/purchases/new">+ NEW PURCHASE</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search purchases" placeholder="Reference or supplier" />
		<FilterSelect
			param="status"
			label="Status"
			allLabel="All statuses"
			options={[
				{ value: 'open', label: 'OPEN' },
				{ value: 'awaiting', label: 'AWAITING RECEIPT' },
				...PURCHASE_STATUSES.map((s) => ({ value: s, label: stateLabel(s) }))
			]}
		/>
		<FilterSelect
			param="supplier_id"
			label="Supplier"
			allLabel="All suppliers"
			options={data.suppliers.map((s) => ({ value: String(s.id), label: s.name }))}
		/>
		<FilterDate
			param="target_from"
			label="Target from"
			max={page.url.searchParams.get('target_to') ?? undefined}
		/>
		<FilterDate
			param="target_to"
			label="Target to"
			min={page.url.searchParams.get('target_from') ?? undefined}
		/>
		<FilterToggle param="overdue" label="Overdue" />
	</FilterBar>

	<DataTable
		rows={data.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		serverSort
		href={(r) => `/purchases/${r.id}`}
		key={(r) => r.id}
		emptyLabel="PURCHASES"
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/purchases/new" class="font-medium text-info hover:underline">+ NEW PURCHASE</a>
			{/if}
		{/snippet}
		{#snippet cell(r, col)}
			{#if col.key === 'reference'}
				<span class="text-info">{r.reference ?? '—'}</span>
			{:else if col.key === 'supplier'}
				{r.supplierName}
			{:else if col.key === 'status'}
				<State value={r.status} />
				{#if r.isOverdue}<State value="overdue" tone="error" badge class="ml-2" />{/if}
			{:else if col.key === 'targetDate'}
				{#if r.targetDate}
					<span class={r.isOverdue ? 'text-error' : ''}>{r.targetDate}</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'lines'}
				{#if r.totalLines === 0}<span class="text-muted-foreground">—</span
					>{:else}{r.linesComplete}/{r.totalLines}{/if}
			{:else if col.key === 'totalCost'}
				{money(r.totalCost)}
			{:else if col.key === 'orderedAt'}
				<Timestamp value={r.orderedAt} dateOnly />
			{/if}
		{/snippet}
	</DataTable>

	<Pagination total={data.total} pageSize={LIST_PAGE_SIZE} />
</ListFrame>
