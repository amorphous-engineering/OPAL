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
		setQuery,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { stateLabel } from '#lib/format.js';
	import type { Part } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const q = $derived(data.query);

	let picked = $state<(string | number)[]>([]);

	const FILTERS = ['q', 'state'];
	const filtered = $derived(!!(q.q || q.state));
	const shown = $derived(data.list.items.length);

	const columns: Column<Part>[] = [
		{ key: 'internalPn', label: 'PN', mono: true, width: '9rem' },
		{ key: 'name', label: 'Name' },
		{ key: 'externalPn', label: 'External PN', mono: true, width: '16rem' },
		{ key: 'category', label: 'Category', width: '9rem' },
		{ key: 'procurement', label: 'Proc', width: '4.5rem' },
		{ key: 'state', label: 'State', width: '5.5rem' }
	];
</script>

<PageHeader title="Parts">
	{#snippet meta()}
		<span class="mono">{shown}{data.list.next ? '+' : ''} {shown === 1 ? 'part' : 'parts'}</span>
	{/snippet}
	{#snippet actions()}
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
