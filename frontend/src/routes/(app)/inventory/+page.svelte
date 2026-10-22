<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import {
		ActionLink,
		DataTable,
		Pager,
		PageHeader,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { date, qty } from '#lib/format.js';
	import {
		sourceLabel,
		type InventoryItem,
		type StockByPart
	} from '#lib/components/inventory/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Filters and sort live in the URL; everything below derives from `data`.
	function go(patch: Record<string, string | null>, keepFocus = false) {
		const url = new URL(page.url.href);
		for (const [k, v] of Object.entries(patch)) {
			if (v === null || v === '') url.searchParams.delete(k);
			else url.searchParams.set(k, v);
		}
		if (!('page' in patch)) url.searchParams.delete('page');
		goto(url, { reset: false, replace: keepFocus });
	}

	let search = $derived(data.q);
	let timer: ReturnType<typeof setTimeout> | undefined;
	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => go({ q: search.trim() || null }, true), 250);
	}
	onDestroy(() => clearTimeout(timer));

	const sort = $derived({ key: data.sort, dir: data.order });
	function setSort(v: { key: string; dir: 'asc' | 'desc' } | null) {
		go({ sort: v ? v.key : null, order: v ? v.dir : null });
	}

	function pageHref(n: number): string {
		const url = new URL(page.url.href);
		if (n <= 1) url.searchParams.delete('page');
		else url.searchParams.set('page', String(n));
		return url.pathname + url.search;
	}

	const recordColumns: Column<InventoryItem>[] = [
		{ key: 'opal_number', label: 'OPAL', sortable: true, mono: true, width: '9rem' },
		{ key: 'part', label: 'Part', sortable: true },
		{ key: 'location', label: 'Location', sortable: true, mono: true, class: 'whitespace-nowrap' },
		{
			key: 'quantity',
			label: 'Qty',
			sortable: true,
			align: 'right',
			mono: true,
			class: 'whitespace-nowrap'
		},
		{ key: 'lot_number', label: 'Lot', sortable: true, mono: true, class: 'whitespace-nowrap' },
		{ key: 'source_type', label: 'Source' },
		{ key: 'expiration_date', label: 'Expires', sortable: true, mono: true },
		{ key: 'calibration_due_at', label: 'Cal due', mono: true },
		{ key: 'created_at', label: 'Received', sortable: true }
	];

	const partColumns: Column<StockByPart>[] = [
		{ key: 'part', label: 'Part', sortable: true },
		{ key: 'quantity', label: 'On hand', sortable: true, align: 'right', mono: true },
		{ key: 'reorder_point', label: 'Reorder at', align: 'right', mono: true },
		{ key: 'record_count', label: 'Records', sortable: true, align: 'right', mono: true },
		{ key: 'locations', label: 'Locations', mono: true }
	];

	// Batch labels: records picked on any page this visit.
	let picked = $state<(string | number)[]>([]);
	const pickedOpals = $derived(picked.filter((k): k is string => typeof k === 'string'));

	const filtered = $derived(!!(data.q || data.location || data.source || data.flag));
</script>

<PageHeader title="Stock">
	{#snippet actions()}
		<Button size="sm" href="/inventory/new">+ RECEIVE STOCK</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
	<Input
		type="search"
		class="h-7 w-64"
		placeholder="OPAL number, part, lot, location"
		aria-label="Search stock"
		bind:value={search}
		oninput={onSearch}
	/>

	<div class="flex" role="group" aria-label="View">
		<Button
			size="sm"
			variant={data.view === 'records' ? 'default' : 'outline'}
			onclick={() => go({ view: null, sort: null, order: null })}>RECORDS</Button
		>
		<Button
			size="sm"
			variant={data.view === 'parts' ? 'default' : 'outline'}
			onclick={() => go({ view: 'parts', sort: null, order: null })}>BY PART</Button
		>
	</div>

	<NativeSelect
		size="sm"
		aria-label="Location"
		value={data.location}
		onchange={(e) => go({ location: e.currentTarget.value })}
	>
		<option value="">All locations</option>
		{#each data.locations.filter((l) => l.location) as l (l.location)}
			<option value={l.location}>{l.location}</option>
		{/each}
	</NativeSelect>

	{#if data.view === 'records'}
		<NativeSelect
			size="sm"
			aria-label="Source"
			value={data.source}
			onchange={(e) => go({ source: e.currentTarget.value })}
		>
			<option value="">All sources</option>
			<option value="purchase">Purchase</option>
			<option value="production">Produced</option>
			<option value="manual">Manual</option>
			<option value="transfer">Moved</option>
		</NativeSelect>
	{/if}

	<NativeSelect
		size="sm"
		aria-label="Flag"
		value={data.flag}
		onchange={(e) => go({ flag: e.currentTarget.value })}
	>
		<option value="">All stock</option>
		<option value="low">Low stock</option>
		{#if data.view === 'records'}
			<option value="expired">Expired</option>
			<option value="expiring">Expiring in 30 days</option>
			<option value="calibration">Calibration overdue</option>
		{/if}
	</NativeSelect>

	{#if data.view === 'records'}
		<label class="flex items-center gap-1.5 text-xs">
			<Checkbox
				checked={data.depleted}
				onCheckedChange={(v) => go({ depleted: v ? '1' : null })}
				aria-label="Include depleted records"
			/>
			Include depleted
		</label>
	{/if}

	{#if filtered}
		<Button
			size="sm"
			variant="ghost"
			onclick={() => go({ q: null, location: null, source: null, flag: null })}>CLEAR</Button
		>
	{/if}

	{#if data.view === 'records' && pickedOpals.length}
		<ActionLink href={`/label?inventory=${pickedOpals.join(',')}`} class="ml-2"
			>PRINT {pickedOpals.length === 1 ? 'LABEL' : `${pickedOpals.length} LABELS`}</ActionLink
		>
		<ActionLink onclick={() => (picked = [])}>CLEAR SELECTION</ActionLink>
	{/if}
</div>

{#if data.error}
	<p role="alert" class="m-4 border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
		{data.error}
	</p>
{:else if data.view === 'records'}
	<DataTable
		rows={data.records}
		columns={recordColumns}
		serverSort
		bind:sort={() => sort, setSort}
		href={(r) => (r.opal_number ? `/inventory/opal/${r.opal_number}` : null)}
		emptyLabel={filtered ? 'Stock matching these filters' : 'Stock'}
		key={(r) => r.opal_number ?? r.id}
		bind:selected={picked}
	>
		{#snippet emptyAction()}
			<a href="/inventory/new" class="font-medium text-info hover:underline">+ RECEIVE</a>
		{/snippet}
		{#snippet cell(r, col)}
			{#if col.key === 'opal_number'}
				<span class="font-semibold text-info">{r.opal_number ?? '—'}</span>
			{:else if col.key === 'part'}
				<a href="/parts/{r.part_id}" class="hover:underline">
					<span class="font-mono text-info">{r.part_internal_pn ?? '—'}</span>
					<span class="ml-1.5">{r.part_name}</span>
				</a>
			{:else if col.key === 'location'}
				{#if r.location}{r.location}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'quantity'}
				<span class={Number(r.quantity) === 0 ? 'text-muted-foreground' : ''}
					>{qty(r.quantity, r.part_uom)}</span
				>
			{:else if col.key === 'lot_number'}
				{#if r.lot_number}{r.lot_number}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'source_type'}
				<span class="font-mono text-xs text-muted-foreground">{sourceLabel(r.source_type)}</span>
			{:else if col.key === 'expiration_date'}
				{#if r.expiration_date}
					{date(r.expiration_date)}
					{#if r.is_expired}<State value="expired" tone="error" label="EXPIRED" class="ml-1" />
					{:else if r.days_until_expiration !== null && r.days_until_expiration <= 30}<State
							value="expiring"
							tone="warn"
							label="{r.days_until_expiration}D"
							class="ml-1"
						/>{/if}
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'calibration_due_at'}
				{#if r.part_is_tooling && r.calibration_due_at}
					{date(r.calibration_due_at)}
					{#if r.calibration_status === 'overdue'}<State
							value="overdue"
							tone="error"
							label="OVERDUE"
							class="ml-1"
						/>
					{:else if r.calibration_status === 'due_soon'}<State
							value="due"
							tone="warn"
							label="DUE"
							class="ml-1"
						/>{/if}
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'created_at'}
				<Timestamp value={r.created_at} dateOnly />
			{/if}
		{/snippet}
	</DataTable>
{:else}
	<DataTable
		rows={data.parts}
		columns={partColumns}
		serverSort
		bind:sort={() => sort, setSort}
		href={(r) => `/inventory?q=${encodeURIComponent(r.internal_pn ?? r.name)}`}
		emptyLabel={filtered ? 'Parts matching these filters' : 'Stock'}
		key={(r) => r.part_id}
	>
		{#snippet cell(r, col)}
			{#if col.key === 'part'}
				<a href="/parts/{r.part_id}" class="hover:underline">
					<span class="font-mono text-info">{r.internal_pn ?? '—'}</span>
					<span class="ml-1.5">{r.name}</span>
				</a>
			{:else if col.key === 'quantity'}
				{qty(r.quantity, r.unit_of_measure)}
				{#if r.is_low_stock}<State value="low" tone="warn" label="LOW" class="ml-1" />{/if}
			{:else if col.key === 'reorder_point'}
				{#if r.reorder_point !== null}{qty(r.reorder_point)}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			{:else if col.key === 'record_count'}
				{r.record_count}
			{:else if col.key === 'locations'}
				{#if r.locations.length}{r.locations.join(', ')}{:else}<span class="text-muted-foreground"
						>—</span
					>{/if}
			{/if}
		{/snippet}
	</DataTable>
{/if}

{#if data.total > 0}
	<Pager total={data.total} page={data.page} pageSize={data.pageSize} href={(n) => pageHref(n)} />
{/if}
