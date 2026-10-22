<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		DataTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp,
		confirm,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
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

	let search = $state(page.url.searchParams.get('search') ?? '');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	/** Merge `patch` into the query string (null clears a key); filter changes return to page 1. */
	function setParams(patch: Record<string, string | null>) {
		const params = new SvelteURLSearchParams(page.url.searchParams.toString());
		for (const [k, v] of Object.entries(patch)) {
			if (v === null || v === '') params.delete(k);
			else params.set(k, v);
		}
		if (!('page' in patch)) params.delete('page');
		const qs = params.toString();
		goto(qs ? `?${qs}` : page.url.pathname, { replace: true, reset: false });
	}

	function onSearch() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => setParams({ search: search.trim() || null }), 300);
	}

	const columns: Column<Risk>[] = [
		{ key: 'risk_number', label: 'Risk', mono: true, sortable: true, width: '7.5rem' },
		{ key: 'title', label: 'Title', sortable: true },
		{ key: 'asset', label: 'Asset' },
		{ key: 'disposition', label: 'Disposition', sortable: true, width: '8rem' },
		{ key: 'score', label: 'Score', sortable: true, width: '6rem' },
		{ key: 'owner', label: 'Owner', width: '10rem' },
		{ key: 'reviewed', label: 'Reviewed', sortable: true, width: '6rem' }
	];

	const sort = $derived({ key: q.sort, dir: q.dir as 'asc' | 'desc' });
	function setSort(v: { key: string; dir: 'asc' | 'desc' } | null) {
		if (!v) setParams({ sort: null, dir: null });
		else setParams({ sort: v.key, dir: v.dir });
	}

	const total = $derived(data.list.total);
	const pageNo = $derived(Number(q.page) || 1);
	const first = $derived(total ? (pageNo - 1) * PAGE_SIZE + 1 : 0);
	const last = $derived(Math.min(total, pageNo * PAGE_SIZE));

	const hasFilters = $derived(
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

	/** Matrix-cell and live-only filters have no control in the toolbar; show them as a clearable line. */
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
	{#snippet actions()}
		<Button variant="outline" onclick={stamp} disabled={!total}>MARK REVIEWED</Button>
		<Button variant="outline" href="/risks/matrix">MATRIX</Button>
		<Button href="/risks/new">+ NEW RISK</Button>
	{/snippet}
</PageHeader>

<div class="grid gap-3 p-4">
	<div class="flex flex-wrap items-center gap-2">
		<Input
			class="w-64"
			type="search"
			placeholder="Search number or title"
			aria-label="Search risks"
			bind:value={search}
			oninput={onSearch}
		/>
		<NativeSelect
			aria-label="Disposition"
			value={q.disposition ?? ''}
			onchange={(e) => setParams({ disposition: e.currentTarget.value })}
		>
			<NativeSelectOption value="">All dispositions</NativeSelectOption>
			{#each DISPOSITIONS as d (d)}<NativeSelectOption value={d}
					>{d.toUpperCase()}</NativeSelectOption
				>{/each}
		</NativeSelect>
		<NativeSelect
			aria-label="Severity"
			value={q.severity ?? ''}
			onchange={(e) => setParams({ severity: e.currentTarget.value })}
		>
			<NativeSelectOption value="">All severities</NativeSelectOption>
			{#each SEVERITIES as s (s.value)}<NativeSelectOption value={s.value}
					>{s.label}</NativeSelectOption
				>{/each}
		</NativeSelect>
		<NativeSelect
			aria-label="Owner"
			value={q.owner_id ?? ''}
			onchange={(e) => setParams({ owner_id: e.currentTarget.value })}
		>
			<NativeSelectOption value="">All owners</NativeSelectOption>
			{#each data.owners as o (o.id)}<NativeSelectOption value={String(o.id)}
					>{o.name}</NativeSelectOption
				>{/each}
		</NativeSelect>
		<div class="flex items-center gap-1.5">
			<Checkbox
				id="live-only"
				checked={q.active === '1'}
				onCheckedChange={(v) => setParams({ active: v ? '1' : null })}
			/>
			<Label for="live-only">Live only</Label>
		</div>
		{#if hasFilters}
			<Button
				variant="ghost"
				size="sm"
				onclick={() => {
					search = '';
					goto(page.url.pathname, { replace: true, reset: false });
				}}>CLEAR FILTERS</Button
			>
		{/if}
	</div>

	{#if cellLabel}
		<p class="font-mono text-xs text-muted-foreground">
			Matrix cell <span class="text-foreground">{cellLabel}</span> ·
			<a class="text-info hover:underline" href="/risks/matrix">MATRIX</a>
		</p>
	{/if}

	{#if data.error}
		<p role="alert" class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
			{data.error}
		</p>
	{/if}

	{#if total === 0}
		<div class="border border-border bg-card">
			<EmptyLine label={hasFilters ? 'Matching risks' : 'Risks'}>
				{#snippet action()}
					{#if hasFilters}
						<a class="font-medium text-info hover:underline" href="/risks">CLEAR FILTERS</a>
					{:else}
						<a class="font-medium text-info hover:underline" href="/risks/new">+ ADD</a>
					{/if}
				{/snippet}
			</EmptyLine>
		</div>
	{:else}
		<Section title="Risk register" count={total}>
			<DataTable
				rows={data.list.items}
				{columns}
				serverSort
				bind:sort={() => sort, setSort}
				href={(r) => `/risks/${r.id}`}
				key={(r) => r.id}
				emptyLabel={hasFilters ? 'Matching risks' : 'Risks'}
			>
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
						<Timestamp value={r.last_reviewed_at} relative />
					{/if}
				{/snippet}
			</DataTable>
			{#if total > PAGE_SIZE}
				<div class="flex items-center gap-2 border-t border-border px-3 py-1.5 font-mono text-xs">
					<span class="text-muted-foreground">{first}–{last} of {total}</span>
					<div class="ml-auto flex gap-1">
						<Button
							variant="outline"
							size="xs"
							disabled={pageNo <= 1}
							onclick={() => setParams({ page: String(pageNo - 1) })}>PREV</Button
						>
						<Button
							variant="outline"
							size="xs"
							disabled={last >= total}
							onclick={() => setParams({ page: String(pageNo + 1) })}>NEXT</Button
						>
					</div>
				</div>
			{/if}
		</Section>
	{/if}
</div>
