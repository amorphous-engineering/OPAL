<script lang="ts">
	import {
		ActionLink,
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
		setQuery,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { date, qty } from '#lib/format.js';
	import {
		sourceLabel,
		type InventoryItem,
		type StockByPart
	} from '#lib/components/inventory/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Sort defaults depend on the view; the URL carries only a deviation.
	const sorter = $derived(
		urlSort(
			data.view === 'parts' ? { key: 'part', dir: 'asc' } : { key: 'created_at', dir: 'desc' }
		)
	);

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

	const filtered = $derived(
		!!(data.q || data.partId || data.location || data.source || data.flag || data.depleted)
	);
</script>

<PageHeader title="Stock">
	{#snippet meta()}<span class="mono"
			>{data.total} {data.view === 'parts' ? 'parts' : 'records'}</span
		>{/snippet}
	{#snippet actions()}
		<Button size="sm" href="/inventory/new">+ RECEIVE STOCK</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={['q', 'part_id', 'location', 'source', 'flag', 'depleted']}>
		<SearchInput label="Search stock" placeholder="OPAL number, part, lot, location" />

		{#if data.partId}
			<span class="flex h-7 items-center gap-2 border border-border px-2 font-mono text-xs">
				<span class="text-muted-foreground uppercase">Part</span>
				{data.records[0]?.part_internal_pn ?? data.parts[0]?.internal_pn ?? 'selected'}
				<button
					type="button"
					class="text-info hover:underline"
					onclick={() => setQuery({ part_id: null })}>ALL</button
				>
			</span>
		{/if}

		<div class="flex" role="group" aria-label="View">
			<Button
				size="xs"
				variant={data.view === 'records' ? 'default' : 'outline'}
				aria-pressed={data.view === 'records'}
				onclick={() => setQuery({ view: null, sort: null, dir: null })}>RECORDS</Button
			>
			<Button
				size="xs"
				variant={data.view === 'parts' ? 'default' : 'outline'}
				aria-pressed={data.view === 'parts'}
				onclick={() => setQuery({ view: 'parts', sort: null, dir: null })}>BY PART</Button
			>
		</div>

		<FilterSelect
			param="location"
			label="Location"
			allLabel="All locations"
			options={data.locations
				.filter((l) => l.location)
				.map((l) => ({ value: l.location as string, label: l.location as string }))}
		/>

		{#if data.view === 'records'}
			<FilterSelect
				param="source"
				label="Source"
				allLabel="All sources"
				options={[
					{ value: 'purchase', label: 'Purchase' },
					{ value: 'production', label: 'Produced' },
					{ value: 'manual', label: 'Manual' },
					{ value: 'transfer', label: 'Moved' }
				]}
			/>
		{/if}

		<FilterSelect
			param="flag"
			label="Flag"
			allLabel="All stock"
			options={[
				{ value: 'low', label: 'Low stock' },
				...(data.view === 'records'
					? [
							{ value: 'attention', label: 'Needs attention' },
							{ value: 'expired', label: 'Expired' },
							{ value: 'expiring', label: 'Expiring in 30 days' },
							{ value: 'calibration', label: 'Calibration overdue' }
						]
					: [])
			]}
		/>

		{#if data.view === 'records'}
			<FilterToggle param="depleted" label="Include depleted" />
		{/if}
		{#if data.view === 'records' && pickedOpals.length}
			<ActionLink href={`/label?inventory=${pickedOpals.join(',')}`} class="ml-2"
				>PRINT {pickedOpals.length === 1 ? 'LABEL' : `${pickedOpals.length} LABELS`}</ActionLink
			>
			<ActionLink onclick={() => (picked = [])}>CLEAR SELECTION</ActionLink>
		{/if}
	</FilterBar>

	{#if data.error}
		<p
			role="alert"
			class="m-4 border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
		>
			{data.error}
		</p>
	{:else if data.view === 'records'}
		<DataTable
			rows={data.records}
			columns={recordColumns}
			serverSort
			bind:sort={() => sorter.value, sorter.set}
			bind:selected={picked}
			href={(r) => (r.opal_number ? `/inventory/opal/${r.opal_number}` : null)}
			emptyLabel={filtered ? 'Stock matching these filters' : 'Stock'}
			key={(r) => r.opal_number ?? r.id}
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
			bind:sort={() => sorter.value, sorter.set}
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

	<Pagination total={data.total} pageSize={data.pageSize} />
</ListFrame>
