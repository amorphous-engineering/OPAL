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
		SearchInput,
		State,
		Timestamp,
		confirm,
		toast,
		toastError,
		setQuery,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Score from '#lib/components/risks/Score.svelte';
	import { SEVERITIES, dispositionTone } from '#lib/components/risks/types.js';
	import { RISK_DISPOSITIONS, type Risk } from '@opal/shared';
	import { opal } from '#lib/api.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(data.query);
	const sort = urlSort({ key: 'score', dir: 'desc' });
	const FILTERS = [
		'q',
		'project', // added by projects
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
			q.q ||
			q.projectId || // added by projects
			q.disposition ||
			q.severity ||
			q.ownerId ||
			q.probability ||
			q.impact ||
			q.residualProbability ||
			q.residualImpact ||
			q.active
		)
	);
	const total = $derived(data.list.total);
	const shown = $derived(data.list.items.length);

	const columns: Column<Risk>[] = [
		{ key: 'riskNumber', label: 'Risk', mono: true, sortable: true, width: '7.5rem' },
		{ key: 'project', label: 'Project', mono: true, width: '7rem' }, // added by projects
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
		if (q.residualProbability) parts.push(`RESIDUAL P${q.residualProbability}`);
		if (q.residualImpact) parts.push(`RESIDUAL I${q.residualImpact}`);
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
			const { page: _p, ...filters } = q;
			const r = await opal.risks.reviewStamp({ ...filters, q: filters.q || undefined });
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
		<Button size="sm" href={q.projectId ? `/risks/new?projectId=${q.projectId}` : '/risks/new'}
			>+ NEW RISK</Button
		>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search risks" placeholder="Search number or title" />
		<!-- added by projects -->
		<FilterSelect
			param="project"
			label="Project"
			allLabel="All projects"
			options={data.projects.map((p) => ({ value: String(p.id), label: p.code }))}
		/>
		<FilterSelect
			param="disposition"
			label="Disposition"
			allLabel="All dispositions"
			options={RISK_DISPOSITIONS.map((d) => ({ value: d, label: d.toUpperCase() }))}
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
			{#if col.key === 'riskNumber'}
				<span class="font-mono text-info">{r.riskNumber}</span>
			{:else if col.key === 'project'}
				{r.projectCode}
			{:else if col.key === 'title'}
				{r.title}
			{:else if col.key === 'asset'}
				{#if r.assetDisplay}<span
						class="block max-w-[32rem] truncate text-muted-foreground"
						title={r.assetDisplay}>{r.assetDisplay}</span
					>{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'disposition'}
				<State value={r.disposition} tone={dispositionTone(r.disposition)} />
			{:else if col.key === 'score'}
				<Score
					score={r.score}
					severity={r.severity}
					residual={r.residualScore}
					residualSeverity={r.residualSeverity}
				/>
			{:else if col.key === 'owner'}
				{#if r.ownerName}{r.ownerName}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'reviewed'}
				<Timestamp value={r.lastReviewedAt} />
			{/if}
		{/snippet}
	</DataTable>
	{#if q.page > 1 || data.list.next}
		<nav
			aria-label="Pages"
			class="flex items-center gap-3 border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground"
		>
			<span class="tabular-nums">PAGE {q.page} · {shown} OF {total}</span>
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
