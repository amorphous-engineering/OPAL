<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { DataTable, PageHeader, State, Timestamp } from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { cn } from '#lib/utils.js';
	import type { OverviewRow } from '#lib/execution/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const overview = $derived(data.overview);

	const sp = $derived(page.url.searchParams);
	const status = $derived(sp.get('status') ?? 'active');
	const counts = $derived(overview.counts);
	const pages = $derived(Math.max(1, Math.ceil(overview.total / overview.page_size)));

	/** Navigate with the given query changes; filters reset to page 1. */
	function go(changes: Record<string, string | null>, keepPage = false) {
		const url = new URL(page.url.href);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		if (!keepPage) url.searchParams.delete('page');
		goto(url, { reset: false });
	}

	const chips = $derived([
		{ id: 'active', label: 'Active', n: counts.cut + counts.in_work },
		{ id: 'cut', label: 'Cut', n: counts.cut },
		{ id: 'in_work', label: 'In work', n: counts.in_work },
		{ id: 'completed', label: 'Completed', n: counts.completed },
		{ id: 'aborted', label: 'Aborted', n: counts.aborted },
		{ id: 'all', label: 'All', n: counts.cut + counts.in_work + counts.completed + counts.aborted }
	]);

	let search = $state(page.url.searchParams.get('q') ?? '');
	let sort = $state<{ key: string; dir: 'asc' | 'desc' } | null>({
		key: page.url.searchParams.get('sort') ?? 'created',
		dir: (page.url.searchParams.get('dir') as 'asc' | 'desc') ?? 'desc'
	});

	// Header clicks arrive through the bound sort; the URL is the source of truth.
	$effect(() => {
		const key = sort?.key ?? 'created';
		const dir = sort?.dir ?? 'desc';
		if (key !== (sp.get('sort') ?? 'created') || dir !== (sp.get('dir') ?? 'desc')) {
			go({ sort: key === 'created' ? null : key, dir: dir === 'desc' ? null : dir });
		}
	});

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

<PageHeader title="Executions" crumbs={[{ label: 'Executions' }]}>
	{#snippet actions()}
		<Button size="sm" href="/executions/new">+ CUT WO</Button>
	{/snippet}
</PageHeader>

<div class="grid gap-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<div class="flex" role="group" aria-label="Status">
			{#each chips as c (c.id)}
				<button
					type="button"
					class={cn(
						'-ml-px inline-flex h-7 items-center gap-1.5 border border-border px-2.5 font-mono text-[11px] font-medium tracking-wider uppercase first:ml-0 hover:bg-accent',
						status === c.id && 'bg-primary text-primary-foreground hover:bg-primary'
					)}
					aria-pressed={status === c.id}
					onclick={() => go({ status: c.id === 'active' ? null : c.id })}
				>
					{c.label}<span class={status === c.id ? '' : 'text-muted-foreground'}>{c.n}</span>
				</button>
			{/each}
		</div>
		<NativeSelect
			size="sm"
			class="w-56"
			aria-label="Procedure"
			value={sp.get('procedure') ?? ''}
			onchange={(e) => go({ procedure: e.currentTarget.value || null })}
		>
			<option value="">All procedures</option>
			{#each data.procedures as p (p.id)}<option value={String(p.id)}>{p.name}</option>{/each}
		</NativeSelect>
		<form
			class="flex"
			onsubmit={(e) => {
				e.preventDefault();
				go({ q: search.trim() || null });
			}}
		>
			<Input
				bind:value={search}
				type="search"
				placeholder="Work order or procedure"
				aria-label="Search"
				class="h-7 w-56"
			/>
		</form>
		<Button
			size="sm"
			variant={sp.get('mine') === '1' ? 'default' : 'outline'}
			aria-pressed={sp.get('mine') === '1'}
			title="Cut by, claimed by, or worked by me"
			onclick={() => go({ mine: sp.get('mine') === '1' ? null : '1' })}>MINE</Button
		>
		<Button
			size="sm"
			variant={sp.get('held') === '1' ? 'default' : 'outline'}
			aria-pressed={sp.get('held') === '1'}
			onclick={() => go({ held: sp.get('held') === '1' ? null : '1' })}>HELD</Button
		>
	</div>

	<div class="border border-border bg-card">
		<DataTable
			rows={overview.items}
			{columns}
			bind:sort
			serverSort
			href={(r) => `/executions/${r.id}`}
			key={(r) => r.id}
			emptyLabel="Executions"
		>
			{#snippet emptyAction()}
				<a href="/executions/new" class="font-medium text-info hover:underline">+ CUT WO</a>
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
						<span class="font-mono text-xs">
							{#each r.working as w, i (w.user_id)}{#if i > 0},
								{/if}{w.name ?? '?'}{#if w.step_number}<span class="text-muted-foreground">
										@{w.step_number}</span
									>{/if}{/each}
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
	</div>

	<div class="flex items-center gap-3 font-mono text-xs text-muted-foreground">
		<span>{overview.total} work order{overview.total === 1 ? '' : 's'}</span>
		{#if pages > 1}
			<span class="ml-auto flex items-center gap-2">
				<Button
					size="xs"
					variant="outline"
					disabled={overview.page <= 1}
					onclick={() => go({ page: String(overview.page - 1) }, true)}>PREV</Button
				>
				<span>{overview.page} / {pages}</span>
				<Button
					size="xs"
					variant="outline"
					disabled={overview.page >= pages}
					onclick={() => go({ page: String(overview.page + 1) }, true)}>NEXT</Button
				>
			</span>
		{/if}
	</div>
</div>
