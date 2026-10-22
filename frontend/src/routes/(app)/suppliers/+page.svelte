<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { PageHeader, DataTable, State, type Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import ListPager from '#lib/components/purchasing/ListPager.svelte';
	import { LIST_PAGE_SIZE, type Supplier } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const params = $derived(page.url.searchParams);
	let q = $state(page.url.searchParams.get('q') ?? '');

	function urlWith(changes: Record<string, string | null>, keepPage = false): string {
		const next = new SvelteURLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null || v === '') next.delete(k);
			else next.set(k, v);
		}
		if (!keepPage) next.delete('page');
		const qs = next.toString();
		return qs ? `?${qs}` : page.url.pathname;
	}
	const apply = (changes: Record<string, string | null>) =>
		goto(urlWith(changes), { reset: false });

	$effect(() => {
		const value = q.trim();
		if (value === (page.url.searchParams.get('q') ?? '')) return;
		const t = setTimeout(() => apply({ q: value || null }), 250);
		return () => clearTimeout(t);
	});

	const columns: Column<Supplier>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'code', label: 'Code', sortable: true, mono: true },
		{ key: 'email', label: 'Email' },
		{ key: 'phone', label: 'Phone', mono: true },
		{ key: 'part_count', label: 'Parts', align: 'right', mono: true },
		{ key: 'purchase_count', label: 'Purchases', align: 'right', mono: true },
		{ key: 'is_active', label: 'Status' }
	];

	let tableSort = $derived<{ key: string; dir: 'asc' | 'desc' } | null>(
		params.get('sort')
			? { key: params.get('sort')!, dir: (params.get('dir') ?? 'asc') as 'asc' | 'desc' }
			: null
	);
	$effect(() => {
		const cur = page.url.searchParams;
		if (
			(tableSort?.key ?? '') === (cur.get('sort') ?? '') &&
			(tableSort?.dir ?? 'asc') === (cur.get('dir') ?? 'asc')
		)
			return;
		apply({ sort: tableSort?.key ?? null, dir: tableSort?.dir ?? null });
	});

	const filtered = $derived(!!(params.get('q') || params.get('active')));
</script>

<PageHeader title="Suppliers" crumbs={[{ label: 'Suppliers' }]}>
	{#snippet actions()}
		<Button href="/suppliers/new">+ NEW SUPPLIER</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border px-4 py-2">
	<div class="grid gap-1">
		<Label for="f-q" class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
			>Search</Label
		>
		<Input id="f-q" bind:value={q} placeholder="Name, code or email" class="h-7 w-56 text-xs" />
	</div>
	<div class="grid gap-1">
		<Label
			for="f-active"
			class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">Status</Label
		>
		<NativeSelect
			id="f-active"
			size="sm"
			value={params.get('active') ?? ''}
			onchange={(e) => apply({ active: e.currentTarget.value || null })}
		>
			<option value="">ALL</option>
			<option value="true">ACTIVE</option>
			<option value="false">INACTIVE</option>
		</NativeSelect>
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
	href={(s) => `/suppliers/${s.id}`}
	key={(s) => s.id}
	emptyLabel={filtered ? 'Suppliers matching these filters' : 'Suppliers'}
	emptyAction={filtered ? undefined : addAction}
>
	{#snippet cell(s, col)}
		{#if col.key === 'name'}
			<span class="text-info">{s.name}</span>
		{:else if col.key === 'is_active'}
			{#if !s.is_active}<State value="inactive" tone="muted" badge />{/if}
		{:else}
			{@const v = (s as unknown as Record<string, unknown>)[col.key]}
			{#if v === null || v === undefined || v === ''}<span class="text-muted-foreground">—</span
				>{:else}{v}{/if}
		{/if}
	{/snippet}
</DataTable>

{#snippet addAction()}
	<a href="/suppliers/new" class="font-medium text-info hover:underline">+ ADD</a>
{/snippet}

{#if data.total > 0}
	<ListPager
		total={data.total}
		page={data.page}
		pageSize={LIST_PAGE_SIZE}
		href={(n) => urlWith({ page: n === 1 ? null : String(n) }, true)}
	/>
{/if}
