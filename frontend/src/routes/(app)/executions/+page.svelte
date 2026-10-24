<script lang="ts">
	import { page } from '$app/state';
	import {
		Avatar,
		DataTable,
		FilterBar,
		FilterSelect,
		FilterToggle,
		ListFrame,
		PageHeader,
		Pagination,
		SearchInput,
		State,
		Timestamp,
		hasParams,
		setQuery,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import type { OverviewRow } from '#lib/execution/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const overview = $derived(data.overview);

	const sort = urlSort({ key: 'created', dir: 'desc' });
	const status = $derived(page.url.searchParams.get('status') ?? 'active');
	const counts = $derived(overview.counts);
	const FILTERS = ['q', 'procedure', 'mine', 'held'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS) || status !== 'active';
	});

	const chips = $derived([
		{ id: 'active', label: 'Active', n: counts.cut + counts.in_work },
		{ id: 'cut', label: 'Cut', n: counts.cut },
		{ id: 'in_work', label: 'In work', n: counts.in_work },
		{ id: 'completed', label: 'Completed', n: counts.completed },
		{ id: 'aborted', label: 'Aborted', n: counts.aborted },
		{ id: 'all', label: 'All', n: counts.cut + counts.in_work + counts.completed + counts.aborted }
	]);

	const columns: Column<OverviewRow>[] = [
		{ key: 'work_order', label: 'Work order', sortable: true, width: '9rem' },
		{ key: 'procedure', label: 'Procedure', sortable: true },
		{ key: 'status', label: 'Status', sortable: true, width: '7rem' },
		{ key: 'progress', label: 'Progress', width: '10rem' },
		{ key: 'working', label: 'Working' },
		{ key: 'held_by', label: 'Held by', width: '10rem' },
		{ key: 'created', label: 'Cut', sortable: true, width: '5rem', align: 'right' },
		{ key: 'target', label: 'Target', sortable: true, width: '8rem' }
	];
</script>

<PageHeader title="Executions">
	{#snippet meta()}
		<span class="mono">{overview.total} work {overview.total === 1 ? 'order' : 'orders'}</span>
	{/snippet}
	{#snippet actions()}
		<Button size="sm" href="/executions/new">+ CUT WO</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={[...FILTERS, 'status']}>
		<SearchInput label="Search executions" placeholder="Work order, template number or name" />
		<div class="flex" role="group" aria-label="Status">
			{#each chips as c (c.id)}
				<button
					type="button"
					class={cn(
						'-ml-px inline-flex h-7 items-center gap-1.5 border border-border px-2.5 font-mono text-xs font-medium tracking-wider uppercase first:ml-0 first:rounded-l-md last:rounded-r-md hover:bg-accent',
						status === c.id && 'bg-primary text-primary-foreground hover:bg-primary'
					)}
					aria-pressed={status === c.id}
					onclick={() => setQuery({ status: c.id === 'active' ? null : c.id })}
				>
					{c.label}<span class={status === c.id ? '' : 'text-muted-foreground'}>{c.n}</span>
				</button>
			{/each}
		</div>
		<FilterSelect
			param="procedure"
			label="Procedure"
			allLabel="All procedures"
			options={data.procedures.map((p) => ({
				value: String(p.id),
				label: `${p.template_number} ${p.name}`
			}))}
		/>
		<FilterToggle param="mine" label="Mine" />
		<FilterToggle param="held" label="Held" />
	</FilterBar>

	<DataTable
		rows={overview.items}
		{columns}
		bind:sort={() => sort.value, sort.set}
		serverSort
		href={(r) => `/executions/${r.id}`}
		key={(r) => r.id}
		emptyLabel="EXECUTIONS"
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/executions/new" class="font-medium text-info hover:underline">+ CUT WO</a>
			{/if}
		{/snippet}
		{#snippet cell(r, col)}
			{#if col.key === 'work_order'}
				<span class="font-mono font-medium text-info">{r.work_order_number ?? '—'}</span>
				{#if r.priority > 0}
					<State
						value="priority"
						tone={r.priority > 1 ? 'error' : 'warn'}
						label={r.priority > 1 ? 'URGENT' : 'HIGH'}
						class="ml-1.5"
					/>
				{/if}
			{:else if col.key === 'procedure'}
				<span class="font-mono text-muted-foreground">{r.procedure_template_number}</span>
				{r.procedure_name}
				<span class="font-mono text-muted-foreground">v{r.version_number}</span>
			{:else if col.key === 'status'}
				<State value={r.status} />
			{:else if col.key === 'progress'}
				<span class="flex items-center gap-2">
					<span class="h-1.5 w-16 bg-border" aria-hidden="true"
						><span
							class="block h-full bg-ok"
							style:width={`${r.progress_total ? (r.progress_done / r.progress_total) * 100 : 0}%`}
						></span></span
					>
					<span class="font-mono text-xs tabular-nums">{r.progress_done}/{r.progress_total}</span>
				</span>
			{:else if col.key === 'working'}
				{#if r.working.length}
					<span class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
						{#each r.working as w (w.user_id)}
							<span class="inline-flex items-center gap-1.5">
								<Avatar
									user={{ id: w.user_id, name: w.name, avatar_url: w.avatar_url }}
									size="xs"
								/>
								{w.name ?? '?'}{#if w.step_number}<span class="text-muted-foreground">
										OP {w.step_number}</span
									>{/if}
							</span>
						{/each}
					</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'held_by'}
				{#if r.held_by.length}
					<span class="font-mono text-xs text-warn">{r.held_by.join(', ')}</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'created'}
				<Timestamp value={r.created_at} relative />
			{:else if col.key === 'target'}
				<Timestamp value={r.target_completion_at} dateOnly />
			{/if}
		{/snippet}
	</DataTable>
	<Pagination total={overview.total} pageSize={overview.page_size} />
</ListFrame>
