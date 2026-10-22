<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		PageHeader,
		DataTable,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { money } from '#lib/format.js';
	import ListPager from '#lib/components/purchasing/ListPager.svelte';
	import {
		LIST_PAGE_SIZE,
		PURCHASE_STATUSES,
		type PurchaseListItem
	} from '#lib/components/purchasing/types.js';
	import { stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const params = $derived(page.url.searchParams);
	let q = $state(page.url.searchParams.get('q') ?? '');

	/** Merge changes into the query string; empty values drop out. Filter changes reset paging. */
	function urlWith(changes: Record<string, string | null>, keepPage = false): string {
		const next = new SvelteURLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') next.delete(k);
			else next.set(k, v);
		}
		if (!keepPage && !('page' in changes)) next.delete('page');
		const qs = next.toString();
		return qs ? `?${qs}` : page.url.pathname;
	}

	const apply = (changes: Record<string, string | null>) =>
		goto(urlWith(changes), { reset: false });

	// Debounced search box -> URL
	$effect(() => {
		const value = q.trim();
		if (value === (page.url.searchParams.get('q') ?? '')) return;
		const t = setTimeout(() => apply({ q: value || null }), 250);
		return () => clearTimeout(t);
	});

	const sort = $derived({
		key: params.get('sort') ?? '',
		dir: (params.get('dir') ?? 'asc') as 'asc' | 'desc'
	});

	const columns: Column<PurchaseListItem>[] = [
		{ key: 'reference', label: 'Reference', sortable: true, mono: true },
		{ key: 'supplier', label: 'Supplier', sortable: true },
		{ key: 'status', label: 'Status', sortable: true },
		{ key: 'target_date', label: 'Target', sortable: true, mono: true },
		{ key: 'lines', label: 'Lines received', align: 'right', mono: true },
		{ key: 'total_cost', label: 'Total', align: 'right', mono: true },
		{ key: 'ordered_at', label: 'Ordered', sortable: true }
	];

	let tableSort = $derived<{ key: string; dir: 'asc' | 'desc' } | null>(
		sort.key ? { key: sort.key, dir: sort.dir } : null
	);
	function onSort(next: { key: string; dir: 'asc' | 'desc' } | null) {
		if ((next?.key ?? '') === sort.key && (next?.dir ?? 'asc') === sort.dir) return;
		apply({ sort: next?.key ?? null, dir: next?.dir ?? null });
	}
	$effect(() => onSort(tableSort));

	const filtered = $derived(
		['q', 'status', 'supplier_id', 'overdue', 'target_from', 'target_to'].some((k) => params.get(k))
	);
</script>

<PageHeader title="Purchases" crumbs={[{ label: 'Purchases' }]}>
	{#snippet actions()}
		<Button href="/purchases/new">+ NEW PURCHASE</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border px-4 py-2">
	<div class="grid gap-1">
		<Label for="f-q" class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
			>Search</Label
		>
		<Input id="f-q" bind:value={q} placeholder="Reference or supplier" class="h-7 w-52 text-xs" />
	</div>
	<div class="grid gap-1">
		<Label
			for="f-status"
			class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">Status</Label
		>
		<NativeSelect
			id="f-status"
			size="sm"
			value={params.get('status') ?? ''}
			onchange={(e) => apply({ status: e.currentTarget.value || null })}
		>
			<option value="">ALL</option>
			<option value="open">OPEN</option>
			{#each PURCHASE_STATUSES as s (s)}<option value={s}>{stateLabel(s)}</option>{/each}
		</NativeSelect>
	</div>
	<div class="grid gap-1">
		<Label
			for="f-supplier"
			class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">Supplier</Label
		>
		<NativeSelect
			id="f-supplier"
			size="sm"
			value={params.get('supplier_id') ?? ''}
			onchange={(e) => apply({ supplier_id: e.currentTarget.value || null })}
		>
			<option value="">ALL</option>
			{#each data.suppliers as s (s.id)}<option value={String(s.id)}>{s.name}</option>{/each}
		</NativeSelect>
	</div>
	<div class="grid gap-1">
		<Label for="f-from" class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
			>Target from</Label
		>
		<Input
			id="f-from"
			type="date"
			class="h-7 w-36 font-mono text-xs"
			value={params.get('target_from') ?? ''}
			onchange={(e) => apply({ target_from: e.currentTarget.value || null })}
		/>
	</div>
	<div class="grid gap-1">
		<Label for="f-to" class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
			>Target to</Label
		>
		<Input
			id="f-to"
			type="date"
			class="h-7 w-36 font-mono text-xs"
			value={params.get('target_to') ?? ''}
			onchange={(e) => apply({ target_to: e.currentTarget.value || null })}
		/>
	</div>
	<div class="flex h-7 items-center gap-2">
		<Checkbox
			id="f-overdue"
			checked={!!params.get('overdue')}
			onCheckedChange={(v) => apply({ overdue: v ? '1' : null })}
		/>
		<Label for="f-overdue" class="text-xs">Overdue</Label>
	</div>
	{#if filtered}
		<Button
			size="sm"
			variant="ghost"
			onclick={() => {
				q = '';
				goto(page.url.pathname, { reset: false });
			}}>CLEAR</Button
		>
	{/if}
</div>

<DataTable
	rows={data.items}
	{columns}
	bind:sort={tableSort}
	serverSort
	href={(r) => `/purchases/${r.id}`}
	key={(r) => r.id}
	emptyLabel={filtered ? 'Purchases matching these filters' : 'Purchases'}
>
	{#snippet cell(r, col)}
		{#if col.key === 'reference'}
			<span class="text-info">{r.reference ?? '—'}</span>
		{:else if col.key === 'supplier'}
			{r.supplier_name ?? r.supplier}
		{:else if col.key === 'status'}
			<State value={r.status} />
			{#if r.is_overdue}<State value="overdue" tone="error" badge class="ml-2" />{/if}
		{:else if col.key === 'target_date'}
			{#if r.target_date}
				<span class={r.is_overdue ? 'text-error' : ''}>{r.target_date}</span>
			{:else}<span class="text-muted-foreground">—</span>{/if}
		{:else if col.key === 'lines'}
			{#if r.total_lines === 0}<span class="text-muted-foreground">—</span
				>{:else}{r.lines_complete}/{r.total_lines}{/if}
		{:else if col.key === 'total_cost'}
			{money(r.total_cost)}
		{:else if col.key === 'ordered_at'}
			<Timestamp value={r.ordered_at} dateOnly />
		{/if}
	{/snippet}
</DataTable>

{#if data.total > 0}
	<ListPager
		total={data.total}
		page={data.page}
		pageSize={LIST_PAGE_SIZE}
		href={(n) => urlWith({ page: n === 1 ? null : String(n) }, true)}
	/>
{/if}
