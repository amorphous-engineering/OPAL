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
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { PROJECT_STATES, type Project } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort({ key: 'code', dir: 'asc' });
	const FILTERS = ['q', 'state'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<Project>[] = [
		{ key: 'code', label: 'Code', mono: true, sortable: true, width: '8rem' },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'description', label: 'Description' },
		{ key: 'state', label: 'State', sortable: true, width: '6rem' },
		{ key: 'createdAt', label: 'Created', width: '10rem' }
	];
</script>

<PageHeader title="Projects">
	{#snippet meta()}
		<span class="mono"
			>{data.projects.length} {data.projects.length === 1 ? 'project' : 'projects'}</span
		>
	{/snippet}
	{#snippet actions()}
		<Button href="/projects/new" size="sm">+ NEW PROJECT</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search projects" placeholder="Search code or name" />
		<FilterSelect
			param="state"
			label="State"
			allLabel="All states"
			options={PROJECT_STATES.map((s) => ({ value: s, label: s.toUpperCase() }))}
		/>
	</FilterBar>

	<DataTable
		rows={data.projects}
		{columns}
		bind:sort={() => sort.value, sort.set}
		href={(p) => `/projects/${p.id}`}
		key={(p) => p.id}
		emptyLabel="PROJECTS"
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/projects/new" class="font-medium text-info hover:underline">+ NEW PROJECT</a>
			{/if}
		{/snippet}
		{#snippet cell(p, col)}
			{#if col.key === 'code'}
				<span class="font-mono text-info">{p.code}</span>
			{:else if col.key === 'description'}
				{#if p.description}<span class="line-clamp-1 text-muted-foreground">{p.description}</span
					>{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'state'}
				{#if p.state === 'archived'}<State value="archived" tone="warn" />{:else}<span
						class="font-mono text-xs text-muted-foreground">ACTIVE</span
					>{/if}
			{:else if col.key === 'createdAt'}
				<Timestamp value={p.createdAt} />
			{:else}
				{(p as unknown as Record<string, unknown>)[col.key] ?? '—'}
			{/if}
		{/snippet}
	</DataTable>
</ListFrame>
