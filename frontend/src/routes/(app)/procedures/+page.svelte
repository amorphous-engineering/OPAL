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
	import { PROCEDURE_STATUS_OPTIONS } from '#lib/components/procedures/types.js';
	import type { Procedure } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort({ key: 'updatedAt', dir: 'desc' });
	const FILTERS = ['q', 'status', 'type', 'project'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	// Column keys are the URL sort keys of the list contract.
	const columns: Column<Procedure>[] = [
		{ key: 'number', label: 'Number', sortable: true, width: '7rem', mono: true },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'project', label: 'Project', width: '8rem', mono: true },
		{ key: 'type', label: 'Type', sortable: true, width: '6rem', mono: true },
		{ key: 'status', label: 'Status', sortable: true, width: '8rem' },
		{ key: 'version', label: 'Version', sortable: true, width: '6rem', mono: true },
		{ key: 'steps', label: 'Steps', sortable: true, align: 'right', width: '5rem', mono: true },
		{
			key: 'executions',
			label: 'Executions',
			sortable: true,
			align: 'right',
			width: '7rem',
			mono: true
		},
		{ key: 'updatedAt', label: 'Updated', sortable: true, width: '10rem' }
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
		<SearchInput label="Search templates" placeholder="Search number, name or description" />
		<FilterSelect
			param="project"
			label="Project"
			allLabel="All projects"
			options={data.projects.map((p) => ({ value: String(p.id), label: p.code }))}
		/>
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
			options={[...PROCEDURE_STATUS_OPTIONS]}
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
			{#if col.key === 'number'}
				<a href={`/procedures/${r.id}`} class="text-info hover:underline">{r.templateNumber}</a>
			{:else if col.key === 'name'}
				<a href={`/procedures/${r.id}`} class="font-medium text-info hover:underline">{r.name}</a>
			{:else if col.key === 'project'}
				{r.projectCode}
			{:else if col.key === 'type'}
				{r.procedureType.toUpperCase()}
			{:else if col.key === 'status'}
				{#if r.status === 'released'}
					<span class="font-mono text-xs text-muted-foreground">RELEASED</span>
				{:else}
					<State value={r.status} tone={r.status === 'draft' ? 'warn' : 'error'} badge />
				{/if}
			{:else if col.key === 'version'}
				{#if r.currentVersionNumber}v{r.currentVersionNumber}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			{:else if col.key === 'steps'}
				{r.stepCount}
			{:else if col.key === 'executions'}
				{r.executionCount}
			{:else if col.key === 'updatedAt'}
				<Timestamp value={r.updatedAt} />
			{/if}
		{/snippet}
	</DataTable>

	{#if data.page > 1 || data.result.next}
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
					disabled={!data.result.next}
					onclick={() => setQuery({ page: data.page + 1, cursor: data.result.next })}>NEXT →</Button
				>
			</div>
		</nav>
	{/if}
</ListFrame>
