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
		ISSUE_TYPES,
		PRIORITIES,
		STATE_FILTER_DEFAULT,
		TICKET_STATES,
		TYPE_ABBREV,
		priorityTone,
		ticketLabel,
		ticketTone,
		type Issue
	} from '#lib/components/issues/issues.js';
	import { session } from '#lib/session.svelte.js';
	import { stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	const PAGE_SIZE = 50;
	let { data }: PageProps = $props();

	// The API's default order (blocking first) applies until a header is clicked.
	const sort = urlSort(null);
	const FILTERS = [
		'q',
		'type',
		'status',
		'state',
		'priority',
		'assignee',
		'part',
		'procedure',
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
			sortValue: (i) => i.issue_number
		},
		{ key: 'title', label: 'Title', sortable: true, sortValue: (i) => i.title },
		{ key: 'type', label: 'Type', width: '5rem', sortable: true, sortValue: (i) => i.issue_type },
		{
			key: 'state',
			label: 'State',
			width: '9rem',
			sortable: true,
			sortValue: (i) => i.ticket_state
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
			sortValue: (i) => i.created_at
		}
	];
</script>

<PageHeader title="Issues">
	{#snippet meta()}
		<span class="mono">{data.issues.total} {data.issues.total === 1 ? 'issue' : 'issues'}</span>
	{/snippet}
	{#snippet actions()}
		<Button href="/issues/new" size="sm">+ NEW ISSUE</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search issues" placeholder="Search number or title" />
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
			options={PRIORITIES.map((p) => ({ value: p, label: stateLabel(p) }))}
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
				<span class="text-info">{i.issue_number}</span>
			{:else if col.key === 'title'}
				{i.title}
			{:else if col.key === 'type'}
				<span class="font-mono text-xs">{TYPE_ABBREV[i.issue_type] ?? i.issue_type}</span>
			{:else if col.key === 'state'}
				<State
					value={i.ticket_state}
					label={ticketLabel(i.ticket_state)}
					tone={ticketTone(i.ticket_state)}
				/>
			{:else if col.key === 'priority'}
				<State value={i.priority} tone={priorityTone(i.priority)} />
			{:else if col.key === 'assignee'}
				{#if i.assigned_to_name}{i.assigned_to_name}{:else}<span class="text-muted-foreground"
						>—</span
					>{/if}
			{:else if col.key === 'links'}
				{#if i.part_number || i.work_order_number || i.procedure_name}
					<span class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
						{#if i.part_number}<a href={`/parts/${i.part_id}`} class="text-info hover:underline"
								>{i.part_number}</a
							>{/if}
						{#if i.work_order_number}<a
								href={`/executions/${i.procedure_instance_id}`}
								class="text-info hover:underline">{i.work_order_number}</a
							>{/if}
						{#if i.procedure_name && !i.work_order_number}<a
								href={`/procedures/${i.procedure_id}`}
								class="text-info hover:underline">{i.procedure_name}</a
							>{/if}
					</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'created'}
				<Timestamp value={i.created_at} />
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
