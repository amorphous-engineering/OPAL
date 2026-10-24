<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
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
	import {
		STATE_FILTER_DEFAULT,
		TYPE_ABBREV,
		priorityTone,
		ticketLabel,
		ticketTone
	} from '#lib/components/issues/issues.js';
	import { ISSUE_PRIORITIES, ISSUE_TYPES, TICKET_STATES, type Issue } from '@opal/shared';
	import { session } from '#lib/session.svelte.js';
	import { stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	const PAGE_SIZE = 50;
	let { data }: PageProps = $props();

	// The API's default order (blocking first) applies until a header is clicked.
	const sort = urlSort(null);
	const FILTERS = [
		'q',
		'project', // added by projects
		'type',
		'status',
		'state',
		'priority',
		'assignee',
		'part',
		'execution'
	];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<Issue>[] = [
		{
			key: 'number',
			label: 'Issue',
			mono: true,
			width: '7rem',
			sortable: true,
			sortValue: (i) => i.issueNumber
		},
		{ key: 'project', label: 'Project', mono: true, width: '7rem' }, // added by projects
		{ key: 'title', label: 'Title', sortable: true, sortValue: (i) => i.title },
		{ key: 'type', label: 'Type', width: '5rem', sortable: true, sortValue: (i) => i.issueType },
		{
			key: 'state',
			label: 'State',
			width: '9rem',
			sortable: true,
			sortValue: (i) => i.ticketState
		},
		{ key: 'priority', label: 'Pri', width: '6rem', sortable: true, sortValue: (i) => i.priority },
		{ key: 'assignee', label: 'Assignee', width: '10rem' },
		{ key: 'links', label: 'Linked' },
		{
			key: 'created',
			label: 'Created',
			width: '10rem',
			align: 'right',
			sortable: true,
			sortValue: (i) => i.createdAt
		}
	];
</script>

<PageHeader title="Issues">
	{#snippet meta()}
		<span class="mono">{data.issues.total} {data.issues.total === 1 ? 'issue' : 'issues'}</span>
	{/snippet}
	{#snippet actions()}
		<Button
			href={page.url.searchParams.get('project')
				? `/issues/new?projectId=${page.url.searchParams.get('project')}`
				: '/issues/new'}
			size="sm">+ NEW ISSUE</Button
		>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search issues" placeholder="Search number or title" />
		<!-- added by projects -->
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
			options={ISSUE_TYPES.map((t) => ({ value: t, label: stateLabel(t) }))}
		/>
		<FilterSelect
			param="state"
			label="State"
			allLabel=""
			fallback={STATE_FILTER_DEFAULT}
			options={[
				{ value: STATE_FILTER_DEFAULT, label: 'NOT DONE' },
				{ value: 'all', label: 'ALL STATES' },
				...TICKET_STATES.map((s) => ({ value: s, label: ticketLabel(s) }))
			]}
		/>
		<FilterSelect
			param="priority"
			label="Priority"
			allLabel="All priorities"
			options={ISSUE_PRIORITIES.map((p) => ({ value: p, label: stateLabel(p) }))}
		/>
		<FilterSelect
			param="assignee"
			label="Assignee"
			allLabel="Anyone"
			options={[
				...(session.user ? [{ value: 'me', label: 'Me' }] : []),
				...data.assignees
					.filter((a) => a.id !== session.user?.id)
					.map((a) => ({ value: String(a.id), label: a.name }))
			]}
		/>
	</FilterBar>

	<DataTable
		rows={data.issues.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		serverSort
		href={(i) => `/issues/${i.id}`}
		key={(i) => i.id}
		emptyLabel="ISSUES"
	>
		{#snippet cell(i, col)}
			{#if col.key === 'number'}
				<span class="text-info">{i.issueNumber}</span>
			{:else if col.key === 'project'}
				{i.projectCode}
			{:else if col.key === 'title'}
				{i.title}
			{:else if col.key === 'type'}
				<span class="font-mono text-xs">{TYPE_ABBREV[i.issueType] ?? i.issueType}</span>
			{:else if col.key === 'state'}
				{#if i.status === 'void'}
					<State value="void" label="VOID" tone="muted" />
				{:else}
					<State
						value={i.ticketState}
						label={ticketLabel(i.ticketState)}
						tone={ticketTone(i.ticketState)}
					/>
				{/if}
			{:else if col.key === 'priority'}
				<State value={i.priority} tone={priorityTone(i.priority)} />
			{:else if col.key === 'assignee'}
				{#if i.assignedTo}{i.assignedTo.name}{:else}<span class="text-muted-foreground"
						>—</span
					>{/if}
			{:else if col.key === 'links'}
				{#if i.links.length || i.execution}
					<span class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
						{#each i.links as l (l.id)}
							<a href={l.href} class="text-info hover:underline">{l.label}</a>
						{/each}
						{#if i.execution}
							<a href={`/executions/${i.execution.id}`} class="text-info hover:underline"
								>{i.execution.label ?? 'Work order'}</a
							>
						{/if}
					</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'created'}
				<Timestamp value={i.createdAt} />
			{/if}
		{/snippet}
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/issues/new" class="font-medium text-info hover:underline">+ NEW ISSUE</a>
			{/if}
		{/snippet}
	</DataTable>
	<Pagination total={data.issues.total} pageSize={PAGE_SIZE} />
</ListFrame>
