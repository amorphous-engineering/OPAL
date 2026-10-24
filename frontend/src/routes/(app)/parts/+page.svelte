<script lang="ts">
	import { page } from '$app/state';
	import {
		ActionLink,
		DataTable,
		FilterBar,
		FilterSelect,
		ListFrame,
		PageHeader,
		SearchInput,
		State,
		hasParams,
		setQuery,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { stateLabel } from '#lib/format.js';
	import ReserveDialog from '#lib/components/parts/ReserveDialog.svelte';
	import type { Part } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const q = $derived(data.query);

	let picked = $state<(string | number)[]>([]);
	let reserving = $state(false);

	const FILTERS = ['q', 'state', 'tier', 'category', 'procurement', 'tooling', 'structure'];
	const filtered = $derived(!!(q.q || q.state) || hasParams(FILTERS));
	const shown = $derived(data.list.items.length);
	const sort = urlSort({ key: 'id', dir: 'desc' });

	const columns: Column<Part>[] = [
		{ key: 'internalPn', label: 'PN', mono: true, width: '9rem', sortable: true },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'externalPn', label: 'External PN', mono: true, width: '16rem', sortable: true },
		{ key: 'category', label: 'Category', width: '9rem', sortable: true },
		{ key: 'tier', label: 'Tier', width: '5.5rem', sortable: true },
		{ key: 'procurement', label: 'Proc', width: '4.5rem', sortable: true },
		{ key: 'state', label: 'State', width: '5.5rem', sortable: true }
	];
</script>

<PageHeader title="Parts">
	{#snippet meta()}
		<span class="mono">{shown}{data.list.next ? '+' : ''} {shown === 1 ? 'part' : 'parts'}</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={() => (reserving = true)}>RESERVE NUMBERS</Button>
		<Button variant="outline" size="sm" href="/parts/import">IMPORT CSV</Button>
		<Button size="sm" href="/parts/new">+ NEW PART</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search parts" placeholder="Search name, PN, description" />
		<FilterSelect
			param="state"
			label="Lifecycle state"
			allLabel="All states"
			options={[
				{ value: 'draft', label: 'DRAFT' },
				{ value: 'active', label: 'ACTIVE' },
				{ value: 'obsolete', label: 'OBSOLETE' }
			]}
		/>
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
			allLabel="All procurement"
			options={[
				{ value: 'make', label: 'MAKE' },
				{ value: 'buy', label: 'BUY' },
				{ value: 'both', label: 'BOTH' }
			]}
		/>
		<FilterSelect
			param="structure"
			label="Structure"
			allLabel="All structure"
			options={[
				{ value: 'top', label: 'IN NO BOM' },
				{ value: 'components', label: 'COMPONENTS' }
			]}
		/>
		<FilterSelect
			param="tooling"
			label="Tooling"
			allLabel="Tooling and other"
			options={[
				{ value: 'true', label: 'TOOLING' },
				{ value: 'false', label: 'NOT TOOLING' }
			]}
		/>
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
		bind:selected={picked}
		bind:sort={() => sort.value, sort.set}
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
			{#if col.key === 'internalPn'}
				<a href={`/parts/${row.id}`} class="text-info hover:underline">{row.internalPn}</a>
			{:else if col.key === 'name'}
				{row.name}{#if row.isTooling}<span class="label ml-2">Tool</span>{/if}
			{:else if col.key === 'externalPn'}
				{#if row.externalPn}{row.externalPn}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'category'}
				{#if row.category}{row.category}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'tier'}
				<span class="font-mono text-xs">T{row.tier}{#if row.tierName} {row.tierName.toUpperCase()}{/if}</span>
			{:else if col.key === 'procurement'}
				<span class="font-mono text-xs text-muted-foreground">{stateLabel(row.procurement)}</span>
			{:else if col.key === 'state'}
				{#if row.state === 'draft'}
					<State value="draft" tone="warn" badge />
				{:else if row.state === 'obsolete'}
					<State value="obsolete" tone="error" badge />
				{:else}
					<span class="font-mono text-xs text-muted-foreground">ACTIVE</span>
				{/if}
			{/if}
		{/snippet}
	</DataTable>

	{#if q.page > 1 || data.list.next}
		<nav
			aria-label="Pages"
			class="flex items-center gap-3 border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground"
		>
			<span class="tabular-nums">PAGE {q.page}</span>
			<div class="ml-auto flex items-center gap-2">
				<Button
					variant="outline"
					size="xs"
					disabled={q.page <= 1}
					onclick={() => setQuery({ page: null, cursor: null })}>← FIRST</Button
				>
				<Button
					variant="outline"
					size="xs"
					disabled={!data.list.next}
					onclick={() => setQuery({ page: q.page + 1, cursor: data.list.next })}>NEXT →</Button
				>
			</div>
		</nav>
	{/if}
</ListFrame>

<ReserveDialog tiers={data.schema.tiers} bind:open={reserving} />
