<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { DataTable, PageHeader, State, type Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { qty, stateLabel } from '#lib/format.js';
	import { PARTS_PAGE_SIZE, type Part } from '#lib/components/parts/types.js';
	import ReserveDialog from '#lib/components/parts/ReserveDialog.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const q = $derived(data.query);

	// Sort lives in the URL; the table reports clicks, the URL answers.
	let sort = $derived<{ key: string; dir: 'asc' | 'desc' } | null>({ key: q.sort, dir: q.dir });
	let search = $derived(q.q);
	let reserving = $state(false);
	let searchEl = $state<HTMLInputElement | null>(null);

	type Patch = Partial<Record<string, string | number | boolean | null>>;

	function navigate(patch: Patch) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, not reactive state
		const next = new URLSearchParams(page.url.searchParams.toString());
		for (const [k, v] of Object.entries(patch)) {
			if (v === null || v === '' || v === false || v === undefined) next.delete(k);
			else next.set(k, v === true ? '1' : String(v));
		}
		if (!('page' in patch)) next.delete('page');
		const qs = next.toString();
		goto(qs ? `?${qs}` : page.url.pathname, { reset: 'page' in patch });
	}

	$effect(() => {
		const s = sort ?? { key: 'internal_pn', dir: 'asc' };
		if (s.key !== q.sort || s.dir !== q.dir) {
			const isDefault = s.key === 'internal_pn' && s.dir === 'asc';
			navigate(isDefault ? { sort: null, dir: null } : { sort: s.key, dir: s.dir });
		}
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (search.trim() !== q.q) navigate({ q: search.trim() });
		}, 250);
	}

	const filtered = $derived(
		!!(q.q || q.tier || q.category || q.procurement || q.state || q.parent || q.low || q.tooling)
	);

	const total = $derived(data.list.total);
	const pageCount = $derived(Math.max(1, Math.ceil(total / PARTS_PAGE_SIZE)));
	const from = $derived(total === 0 ? 0 : (q.page - 1) * PARTS_PAGE_SIZE + 1);
	const to = $derived(Math.min(total, q.page * PARTS_PAGE_SIZE));

	const columns: Column<Part>[] = [
		{ key: 'internal_pn', label: 'PN', sortable: true, mono: true, width: '9rem' },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'external_pn', label: 'External PN', sortable: true, mono: true, width: '16rem' },
		{ key: 'category', label: 'Category', sortable: true, width: '9rem' },
		{ key: 'procurement', label: 'Proc', sortable: true, width: '4.5rem' },
		{ key: 'state', label: 'State', sortable: true, width: '5.5rem' },
		{ key: 'stock', label: 'Stock', sortable: true, align: 'right', mono: true, width: '8rem' }
	];

	function onkeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (e.key === '/' && !t.closest('input, textarea, select, [contenteditable]')) {
			e.preventDefault();
			searchEl?.focus();
		}
	}
</script>

<svelte:window {onkeydown} />

<PageHeader title="Parts">
	{#snippet meta()}
		<span class="mono">{total} {total === 1 ? 'part' : 'parts'}</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={() => (reserving = true)}>RESERVE PNs</Button>
		<Button variant="outline" size="sm" href="/parts/import">IMPORT CSV</Button>
		<Button size="sm" href="/parts/new">+ NEW PART</Button>
	{/snippet}
</PageHeader>

<div class="p-4">
	<div class="border border-border bg-card">
		<div class="flex flex-wrap items-center gap-2 border-b border-border p-2">
			<Input
				bind:ref={searchEl}
				bind:value={search}
				oninput={onSearch}
				type="search"
				placeholder="Search name, PN, description    /"
				aria-label="Search parts"
				class="h-7 w-72"
			/>
			<NativeSelect.Root
				size="sm"
				aria-label="Tier"
				value={q.tier}
				onchange={(e) => navigate({ tier: e.currentTarget.value })}
			>
				<NativeSelect.Option value="">All tiers</NativeSelect.Option>
				{#each data.schema.tiers as t (t.level)}
					<NativeSelect.Option value={String(t.level)}
						>T{t.level} {t.name.toUpperCase()}</NativeSelect.Option
					>
				{/each}
			</NativeSelect.Root>
			<NativeSelect.Root
				size="sm"
				aria-label="Category"
				value={q.category}
				onchange={(e) => navigate({ category: e.currentTarget.value })}
			>
				<NativeSelect.Option value="">All categories</NativeSelect.Option>
				{#each data.schema.categories as c (c)}
					<NativeSelect.Option value={c}>{c}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			<NativeSelect.Root
				size="sm"
				aria-label="Procurement"
				value={q.procurement}
				onchange={(e) => navigate({ procurement: e.currentTarget.value })}
			>
				<NativeSelect.Option value="">Make / buy</NativeSelect.Option>
				<NativeSelect.Option value="make">MAKE</NativeSelect.Option>
				<NativeSelect.Option value="buy">BUY</NativeSelect.Option>
				<NativeSelect.Option value="both">BOTH</NativeSelect.Option>
			</NativeSelect.Root>
			<NativeSelect.Root
				size="sm"
				aria-label="Lifecycle state"
				value={q.state}
				onchange={(e) => navigate({ state: e.currentTarget.value })}
			>
				<NativeSelect.Option value="">All states</NativeSelect.Option>
				<NativeSelect.Option value="draft">DRAFT</NativeSelect.Option>
				<NativeSelect.Option value="active">ACTIVE</NativeSelect.Option>
			</NativeSelect.Root>
			<NativeSelect.Root
				size="sm"
				aria-label="Assembly level"
				value={q.parent}
				onchange={(e) => navigate({ parent: e.currentTarget.value })}
			>
				<NativeSelect.Option value="">All levels</NativeSelect.Option>
				<NativeSelect.Option value="top">Top-level</NativeSelect.Option>
				<NativeSelect.Option value="sub">Sub-components</NativeSelect.Option>
			</NativeSelect.Root>
			<NativeSelect.Root
				size="sm"
				aria-label="Tooling"
				value={q.tooling}
				onchange={(e) => navigate({ tooling: e.currentTarget.value })}
			>
				<NativeSelect.Option value="">Tooling</NativeSelect.Option>
				<NativeSelect.Option value="yes">TOOLING ONLY</NativeSelect.Option>
				<NativeSelect.Option value="no">NO TOOLING</NativeSelect.Option>
			</NativeSelect.Root>
			<label class="flex items-center gap-1.5 text-xs">
				<Checkbox checked={q.low} onCheckedChange={(v) => navigate({ low: v === true })} />
				<span class="label">Low stock</span>
			</label>
			{#if filtered}
				<a
					href={page.url.pathname}
					class="font-mono text-xs font-medium text-info hover:underline"
					onclick={() => (search = '')}>CLEAR</a
				>
			{/if}
		</div>

		<DataTable
			rows={data.list.items}
			{columns}
			bind:sort
			serverSort
			key={(r) => r.id}
			href={(r) => `/parts/${r.id}`}
			emptyLabel="PARTS"
		>
			{#snippet emptyAction()}
				{#if filtered}
					<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a
					>
				{:else}
					<a href="/parts/new" class="font-medium text-info hover:underline">+ NEW PART</a>
				{/if}
			{/snippet}
			{#snippet cell(row, col)}
				{#if col.key === 'internal_pn'}
					<a href={`/parts/${row.id}`} class="text-info hover:underline">{row.internal_pn ?? '—'}</a
					>
				{:else if col.key === 'name'}
					{row.name}{#if row.is_tooling}<span class="label ml-2">Tool</span>{/if}
				{:else if col.key === 'external_pn'}
					{#if row.external_pn}{row.external_pn}{:else}<span class="text-muted-foreground">—</span
						>{/if}
				{:else if col.key === 'category'}
					{#if row.category}{row.category}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'procurement'}
					<span class="font-mono text-xs text-muted-foreground">{stateLabel(row.procurement)}</span>
				{:else if col.key === 'state'}
					{#if row.lifecycle_state === 'draft'}
						<State value="draft" tone="warn" badge />
					{:else}
						<span class="font-mono text-xs text-muted-foreground">ACTIVE</span>
					{/if}
				{:else if col.key === 'stock'}
					<span class="inline-flex items-center justify-end gap-2">
						{#if row.is_low_stock}<span title={`Reorder point ${qty(row.reorder_point)}`}
								><State value="low" tone="warn" badge label="LOW" /></span
							>{/if}
						<span class={Number(row.total_quantity) === 0 ? 'text-muted-foreground' : ''}
							>{qty(row.total_quantity, row.unit_of_measure)}</span
						>
					</span>
				{/if}
			{/snippet}
		</DataTable>

		{#if total > 0}
			<div
				class="flex items-center gap-3 border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground"
			>
				<span class="tabular-nums">{from}–{to} of {total}</span>
				<div class="ml-auto flex items-center gap-2">
					<Button
						variant="outline"
						size="xs"
						disabled={q.page <= 1}
						onclick={() => navigate({ page: q.page - 1 })}>← PREV</Button
					>
					<span class="tabular-nums">PAGE {q.page}/{pageCount}</span>
					<Button
						variant="outline"
						size="xs"
						disabled={q.page >= pageCount}
						onclick={() => navigate({ page: q.page + 1 })}>NEXT →</Button
					>
				</div>
			</div>
		{/if}
	</div>
</div>

<ReserveDialog tiers={data.schema.tiers} bind:open={reserving} />
