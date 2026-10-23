<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
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
		confirm,
		toast,
		toastError,
		urlSort,
		type Column,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Score from '#lib/components/risks/Score.svelte';
	import {
		DISPOSITIONS,
		SEVERITIES,
		dispositionTone,
		type Risk
	} from '#lib/components/risks/types.js';
	import { api } from '#lib/api.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const PAGE_SIZE = 50;
	const q = $derived(data.query);
	const sort = urlSort({ key: 'score', dir: 'desc' });
	const FILTERS = [
		'q',
		'disposition',
		'severity',
		'owner_id',
		'active',
		'probability',
		'impact',
		'residual_probability',
		'residual_impact'
	];
	const filtered = $derived(
		!!(
			q.search ||
			q.disposition ||
			q.severity ||
			q.owner_id ||
			q.probability ||
			q.impact ||
			q.residual_probability ||
			q.residual_impact ||
			q.active
		)
	);
	const total = $derived(data.list.total);

	const columns: Column<Risk>[] = [
		{ key: 'risk_number', label: 'Risk', mono: true, sortable: true, width: '7.5rem' },
		{ key: 'title', label: 'Title', sortable: true },
		{ key: 'asset', label: 'Asset' },
		{ key: 'disposition', label: 'Disposition', sortable: true, width: '8rem' },
		{ key: 'score', label: 'Score', sortable: true, width: '6rem' },
		{ key: 'owner', label: 'Owner', width: '10rem' },
		{ key: 'reviewed', label: 'Reviewed', sortable: true, width: '10rem' }
	];

	/** Matrix-cell filters have no control in the bar; show them as a clearable line. */
	const cellLabel = $derived.by(() => {
		const parts: string[] = [];
		if (q.probability) parts.push(`P${q.probability}`);
		if (q.impact) parts.push(`I${q.impact}`);
		if (q.residual_probability) parts.push(`RESIDUAL P${q.residual_probability}`);
		if (q.residual_impact) parts.push(`RESIDUAL I${q.residual_impact}`);
		return parts.join(' × ');
	});

	async function stamp() {
		if (!total) return;
		const ok = await confirm({
			title: `Mark ${total} ${total === 1 ? 'risk' : 'risks'} reviewed`,
			body: 'Sets last reviewed to now, by you, on every risk matching the current filters, including other pages.',
			action: 'MARK REVIEWED'
		});
		if (!ok) return;
		try {
			const body: Record<string, unknown> = {
				search: q.search,
				disposition: q.disposition,
				severity: q.severity,
				owner_id: q.owner_id ? Number(q.owner_id) : null,
				probability: q.probability ? Number(q.probability) : null,
				impact: q.impact ? Number(q.impact) : null,
				residual_probability: q.residual_probability ? Number(q.residual_probability) : null,
				residual_impact: q.residual_impact ? Number(q.residual_impact) : null,
				active: q.active === '1' || q.active === 'true'
			};
			const r = await api.post<{ stamped: number }>('/risks/review-stamp', body);
			toast.success(`${r.stamped} marked reviewed`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}
</script>

<PageHeader title="Risks">
	{#snippet meta()}
		<span class="mono">{total} {total === 1 ? 'risk' : 'risks'}</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={stamp} disabled={!total}>MARK REVIEWED</Button>
		<Button variant="outline" size="sm" href="/risks/matrix">MATRIX</Button>
		<Button size="sm" href="/risks/new">+ NEW RISK</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search risks" placeholder="Search number or title" />
		<FilterSelect
			param="disposition"
			label="Disposition"
			allLabel="All dispositions"
			options={DISPOSITIONS.map((d) => ({ value: d, label: d.toUpperCase() }))}
		/>
		<FilterSelect
			param="severity"
			label="Severity"
			allLabel="All severities"
			options={SEVERITIES}
		/>
		<FilterSelect
			param="owner_id"
			label="Owner"
			allLabel="All owners"
			options={data.owners.map((o) => ({ value: String(o.id), label: o.name }))}
		/>
		<FilterToggle param="active" label="Live only" />
	</FilterBar>

	{#if cellLabel}
		<p class="border-b border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
			Matrix cell <span class="text-foreground">{cellLabel}</span> ·
			<a class="text-info hover:underline" href="/risks/matrix">MATRIX</a>
		</p>
	{/if}

	<ErrorBanner message={data.error} class="m-2" />

	<DataTable
		rows={data.list.items}
		{columns}
		serverSort
		bind:sort={() => sort.value, sort.set}
		href={(r) => `/risks/${r.id}`}
		key={(r) => r.id}
		emptyLabel="RISKS"
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/risks/new" class="font-medium text-info hover:underline">+ NEW RISK</a>
			{/if}
		{/snippet}
		{#snippet cell(r, col)}
			{#if col.key === 'risk_number'}
				<span class="font-mono text-info">{r.risk_number}</span>
			{:else if col.key === 'title'}
				{r.title}
			{:else if col.key === 'asset'}
				{#if r.asset_display}<span
						class="block max-w-[32rem] truncate text-muted-foreground"
						title={r.asset_display}>{r.asset_display}</span
					>{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'disposition'}
				<State value={r.disposition} tone={dispositionTone(r.disposition)} />
			{:else if col.key === 'score'}
				<Score
					score={r.score}
					severity={r.severity}
					residual={r.residual_score}
					residualSeverity={r.residual_severity}
				/>
			{:else if col.key === 'owner'}
				{#if r.owner_name}{r.owner_name}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'reviewed'}
				<Timestamp value={r.last_reviewed_at} />
			{/if}
		{/snippet}
	</DataTable>
	<Pagination {total} pageSize={PAGE_SIZE} />
</ListFrame>
