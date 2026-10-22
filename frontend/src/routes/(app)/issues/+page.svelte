<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		DataTable,
		PageHeader,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import {
		ISSUE_TYPES,
		PRIORITIES,
		STATES,
		TYPE_ABBREV,
		priorityTone,
		stateTone,
		type Issue
	} from '#lib/components/issues/issues.js';
	import { session } from '#lib/session.svelte.js';
	import { stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	const PAGE_SIZE = 50;
	let { data }: PageProps = $props();

	const params = $derived(page.url.searchParams);
	const sort = $derived.by(() => {
		const key = params.get('sort');
		return key
			? { key, dir: (params.get('dir') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc' }
			: null;
	});
	const pageNo = $derived(Number(params.get('page') ?? 1));
	const pages = $derived(Math.max(1, Math.ceil(data.issues.total / PAGE_SIZE)));
	const filtered = $derived(
		['q', 'type', 'state', 'priority', 'assignee', 'part', 'procedure', 'execution'].some((k) =>
			params.get(k)
		)
	);

	let search = $state(page.url.searchParams.get('q') ?? '');
	let timer: ReturnType<typeof setTimeout> | undefined;

	function setParams(changes: Record<string, string | null>, keepPage = false) {
		const next = new SvelteURLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(changes)) {
			if (v) next.set(k, v);
			else next.delete(k);
		}
		if (!keepPage) next.delete('page');
		const qs = next.toString();
		goto(`/issues${qs ? `?${qs}` : ''}`, { replace: true });
	}

	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => setParams({ q: search.trim() || null }), 250);
	}

	function onSort(next: { key: string; dir: 'asc' | 'desc' } | null) {
		setParams({ sort: next?.key ?? null, dir: next?.dir ?? null });
	}

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
		{ key: 'state', label: 'State', width: '9rem', sortable: true, sortValue: (i) => i.disp_state },
		{ key: 'priority', label: 'Pri', width: '6rem', sortable: true, sortValue: (i) => i.priority },
		{ key: 'assignee', label: 'Assignee', width: '10rem' },
		{ key: 'links', label: 'Linked' },
		{
			key: 'created',
			label: 'Age',
			width: '4.5rem',
			align: 'right',
			sortable: true,
			sortValue: (i) => i.created_at
		}
	];
</script>

<PageHeader title="Issues" crumbs={[{ label: 'Quality' }, { label: 'Issues' }]}>
	{#snippet meta()}<span class="mono">{data.issues.total}</span> shown by current filters{/snippet}
	{#snippet actions()}
		<Button href="/issues/new" size="sm">+ NEW ISSUE</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
	<Input
		type="search"
		class="w-64"
		placeholder="Search number or title"
		aria-label="Search issues"
		bind:value={search}
		oninput={onSearch}
	/>
	<NativeSelect
		size="sm"
		aria-label="Filter by type"
		value={params.get('type') ?? ''}
		onchange={(e) => setParams({ type: e.currentTarget.value || null })}
	>
		<NativeSelectOption value="">All types</NativeSelectOption>
		{#each ISSUE_TYPES as t (t)}<NativeSelectOption value={t}>{stateLabel(t)}</NativeSelectOption
			>{/each}
	</NativeSelect>
	<NativeSelect
		size="sm"
		aria-label="Filter by state"
		value={params.get('state') ?? ''}
		onchange={(e) => setParams({ state: e.currentTarget.value || null })}
	>
		<NativeSelectOption value="">All states</NativeSelectOption>
		{#each STATES as s (s)}<NativeSelectOption value={s}>{stateLabel(s)}</NativeSelectOption>{/each}
	</NativeSelect>
	<NativeSelect
		size="sm"
		aria-label="Filter by priority"
		value={params.get('priority') ?? ''}
		onchange={(e) => setParams({ priority: e.currentTarget.value || null })}
	>
		<NativeSelectOption value="">All priorities</NativeSelectOption>
		{#each PRIORITIES as p (p)}<NativeSelectOption value={p}>{stateLabel(p)}</NativeSelectOption
			>{/each}
	</NativeSelect>
	<NativeSelect
		size="sm"
		aria-label="Filter by assignee"
		value={params.get('assignee') ?? ''}
		onchange={(e) => setParams({ assignee: e.currentTarget.value || null })}
	>
		<NativeSelectOption value="">Anyone</NativeSelectOption>
		{#if session.user}
			<NativeSelectOption value={String(session.user.id)}>Me</NativeSelectOption>
		{/if}
		{#each data.assignees.filter((a) => a.id !== session.user?.id) as a (a.id)}
			<NativeSelectOption value={String(a.id)}>{a.name}</NativeSelectOption>
		{/each}
	</NativeSelect>
	{#if filtered}
		<Button
			size="sm"
			variant="outline"
			onclick={() => {
				search = '';
				goto('/issues', { replace: true });
			}}>CLEAR</Button
		>
	{/if}
</div>

<DataTable
	rows={data.issues.items}
	{columns}
	bind:sort={() => sort, onSort}
	serverSort
	href={(i) => `/issues/${i.id}`}
	key={(i) => i.id}
	emptyLabel={filtered ? 'Matching issues' : 'Issues'}
>
	{#snippet cell(i, col)}
		{#if col.key === 'number'}
			<span class="text-info">{i.issue_number}</span>
		{:else if col.key === 'title'}
			{i.title}
		{:else if col.key === 'type'}
			<span class="font-mono text-xs">{TYPE_ABBREV[i.issue_type] ?? i.issue_type}</span>
		{:else if col.key === 'state'}
			<State value={i.disp_state} tone={stateTone(i.disp_state)} />
		{:else if col.key === 'priority'}
			<State value={i.priority} tone={priorityTone(i.priority)} />
		{:else if col.key === 'assignee'}
			{#if i.assigned_to_name}{i.assigned_to_name}{:else}<span class="text-muted-foreground">—</span
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
			<Timestamp value={i.created_at} relative />
		{/if}
	{/snippet}
	{#snippet emptyAction()}
		<a href="/issues/new" class="font-medium text-info hover:underline">+ NEW ISSUE</a>
	{/snippet}
</DataTable>

{#if pages > 1}
	<div class="flex items-center gap-3 border-b border-border px-4 py-2 font-mono text-xs">
		<Button
			size="xs"
			variant="outline"
			disabled={pageNo <= 1}
			onclick={() => setParams({ page: String(pageNo - 1) }, true)}>PREV</Button
		>
		<span class="tabular-nums">PAGE {pageNo} OF {pages}</span>
		<Button
			size="xs"
			variant="outline"
			disabled={pageNo >= pages}
			onclick={() => setParams({ page: String(pageNo + 1) }, true)}>NEXT</Button
		>
	</div>
{/if}
