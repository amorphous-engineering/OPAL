<script lang="ts">
	import { page } from '$app/state';
	import {
		ActionLink,
		DataTable,
		FilterBar,
		FilterSelect,
		FilterToggle,
		ListFrame,
		PageHeader,
		Pagination,
		SearchInput,
		State,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { qty, stateLabel } from '#lib/format.js';
	import { PARTS_PAGE_SIZE, type Part } from '#lib/components/parts/types.js';
	import ReserveDialog from '#lib/components/parts/ReserveDialog.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const q = $derived(data.query);

	const sort = urlSort({ key: 'internal_pn', dir: 'asc' });
	let reserving = $state(false);
	let picked = $state<(string | number)[]>([]);

	const FILTERS = ['q', 'tier', 'category', 'procurement', 'state', 'parent', 'low', 'tooling'];
	const filtered = $derived(
		!!(q.q || q.tier || q.category || q.procurement || q.state || q.parent || q.low || q.tooling)
	);
	const total = $derived(data.list.total);

	const columns: Column<Part>[] = [
		{ key: 'internal_pn', label: 'PN', sortable: true, mono: true, width: '9rem' },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'external_pn', label: 'External PN', sortable: true, mono: true, width: '16rem' },
		{ key: 'category', label: 'Category', sortable: true, width: '9rem' },
		{ key: 'procurement', label: 'Proc', sortable: true, width: '4.5rem' },
		{ key: 'state', label: 'State', sortable: true, width: '5.5rem' },
		{ key: 'stock', label: 'Stock', sortable: true, align: 'right', mono: true, width: '8rem' }
	];
</script>

<PageHeader title="Parts">
	{#snippet meta()}
		<span class="mono">{total} {total === 1 ? 'part' : 'parts'}</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={() => (reserving = true)}>RESERVE PNs</Button>
		<Button variant="outline" size="sm" href="/parts/import">IMPORT CSV</Button>
		<Button size="sm" href="/parts/new">+ NEW PART</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search parts" placeholder="Search name, PN, description" />
		<FilterSelect
			param="tier"
			label="Tier"
			allLabel="All tiers"
			options={data.schema.tiers.map((t) => ({
				value: String(t.level),
				label: `T${t.level} ${t.name.toUpperCase()}`
			}))}
		/>
		<FilterSelect
			param="category"
			label="Category"
			allLabel="All categories"
			options={data.schema.categories.map((c) => ({ value: c, label: c }))}
		/>
		<FilterSelect
			param="procurement"
			label="Procurement"
			allLabel="Make / buy"
			options={[
				{ value: 'make', label: 'MAKE' },
				{ value: 'buy', label: 'BUY' },
				{ value: 'both', label: 'BOTH' }
			]}
		/>
		<FilterSelect
			param="state"
			label="Lifecycle state"
			allLabel="All states"
			options={[
				{ value: 'draft', label: 'DRAFT' },
				{ value: 'active', label: 'ACTIVE' }
			]}
		/>
		<FilterSelect
			param="parent"
			label="Assembly level"
			allLabel="All levels"
			options={[
				{ value: 'top', label: 'Top-level' },
				{ value: 'sub', label: 'Sub-components' }
			]}
		/>
		<FilterSelect
			param="tooling"
			label="Tooling"
			allLabel="Tooling"
			options={[
				{ value: 'yes', label: 'TOOLING ONLY' },
				{ value: 'no', label: 'NO TOOLING' }
			]}
		/>
		<FilterToggle param="low" label="Low stock" />
		{#if picked.length}
			<ActionLink href={`/label?part=${picked.join(',')}`} class="ml-2"
				>PRINT {picked.length === 1 ? 'LABEL' : `${picked.length} LABELS`}</ActionLink
			>
			<ActionLink onclick={() => (picked = [])}>CLEAR SELECTION</ActionLink>
		{/if}
	</FilterBar>

	<DataTable
		rows={data.list.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		bind:selected={picked}
		serverSort
		key={(r) => r.id}
		href={(r) => `/parts/${r.id}`}
		emptyLabel="PARTS"
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/parts/new" class="font-medium text-info hover:underline">+ NEW PART</a>
			{/if}
		{/snippet}
		{#snippet cell(row, col)}
			{#if col.key === 'internal_pn'}
				<a href={`/parts/${row.id}`} class="text-info hover:underline">{row.internal_pn ?? '—'}</a>
			{:else if col.key === 'name'}
				{row.name}{#if row.is_tooling}<span class="label ml-2">Tool</span>{/if}
			{:else if col.key === 'external_pn'}
				{#if row.external_pn}{row.external_pn}{:else}<span class="text-muted-foreground">—</span
					>{/if}
			{:else if col.key === 'category'}
				{#if row.category}{row.category}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'procurement'}
				<span class="font-mono text-xs text-muted-foreground">{stateLabel(row.procurement)}</span>
			{:else if col.key === 'state'}
				{#if row.lifecycle_state === 'draft'}
					<State value="draft" tone="warn" badge />
				{:else}
					<span class="font-mono text-xs text-muted-foreground">ACTIVE</span>
				{/if}
			{:else if col.key === 'stock'}
				<span class="inline-flex items-center justify-end gap-2">
					{#if row.is_low_stock}<span title={`Reorder point ${qty(row.reorder_point)}`}
							><State value="low" tone="warn" badge label="LOW" /></span
						>{/if}
					<span class={Number(row.total_quantity) === 0 ? 'text-muted-foreground' : ''}
						>{qty(row.total_quantity, row.unit_of_measure)}</span
					>
				</span>
			{/if}
		{/snippet}
	</DataTable>

	<Pagination {total} pageSize={PARTS_PAGE_SIZE} />
</ListFrame>

<ReserveDialog tiers={data.schema.tiers} bind:open={reserving} />
