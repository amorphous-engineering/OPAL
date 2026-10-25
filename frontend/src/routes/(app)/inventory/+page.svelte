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
		type Column,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { date, qty } from '#lib/format.js';
	import { sourceLabel } from '#lib/components/inventory/types.js';
	import type { StockByPart, StockRecord } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Sort defaults depend on the view; the URL carries only a deviation.
	const sorter = $derived(
		urlSort(data.view === 'parts' ? { key: 'part', dir: 'asc' } : { key: 'createdAt', dir: 'desc' })
	);

	const recordColumns: Column<StockRecord>[] = [
		{ key: 'opalNumber', label: 'OPAL', sortable: true, mono: true, width: '9rem' },
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
		{
			key: 'lotNumber',
			label: 'Lot / serial',
			sortable: true,
			mono: true,
			class: 'whitespace-nowrap'
		},
		{ key: 'sourceType', label: 'Source' },
		{ key: 'expirationDate', label: 'Expires', sortable: true, mono: true },
		{ key: 'calibrationDueAt', label: 'Cal due', mono: true },
		{ key: 'createdAt', label: 'Received', sortable: true }
	];

	const partColumns: Column<StockByPart>[] = [
		{ key: 'part', label: 'Part', sortable: true },
		{ key: 'quantity', label: 'On hand', sortable: true, align: 'right', mono: true },
		{ key: 'reorderPoint', label: 'Reorder at', align: 'right', mono: true },
		{ key: 'recordCount', label: 'Records', sortable: true, align: 'right', mono: true },
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
			<span
				class="flex h-7 items-center gap-2 rounded-md border border-border px-2 font-mono text-xs"
			>
				<span class="text-muted-foreground uppercase">Part</span>
				{data.records[0]?.partInternalPn ?? data.parts[0]?.internalPn ?? 'selected'}
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
				variant={data.view === 'parts' ? 'default' : 'outline'}
				aria-pressed={data.view === 'parts'}
				onclick={() => setQuery({ view: 'parts', sort: null, dir: null })}>BY PART</Button
			>
			<Button
				size="xs"
				variant={data.view === 'records' ? 'default' : 'outline'}
				aria-pressed={data.view === 'records'}
				onclick={() => setQuery({ view: 'records', sort: null, dir: null })}>RECORDS</Button
			>
		</div>

		<FilterSelect
			param="location"
			label="Location"
			allLabel="All locations"
			options={data.locations.map((l) => ({ value: l.location, label: l.location }))}
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
		<ErrorBanner message={data.error} class="m-4" />
	{:else if data.view === 'records'}
		<DataTable
			rows={data.records}
			columns={recordColumns}
			serverSort
			bind:sort={() => sorter.value, sorter.set}
			bind:selected={picked}
			href={(r) => `/inventory/opal/${r.opalNumber}`}
			emptyLabel={filtered ? 'Stock matching these filters' : 'Stock'}
			key={(r) => r.opalNumber}
		>
			{#snippet emptyAction()}
				<a href="/inventory/new" class="font-medium text-info hover:underline">+ RECEIVE</a>
			{/snippet}
			{#snippet cell(r, col)}
				{#if col.key === 'opalNumber'}
					<span class="font-semibold text-info">{r.opalNumber}</span>
				{:else if col.key === 'part'}
					<a href="/parts/{r.partId}" class="hover:underline">
						<span class="font-mono text-info">{r.partInternalPn}</span>
						<span class="ml-1.5">{r.partName}</span>
					</a>
				{:else if col.key === 'location'}
					{#if r.location}{r.location}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'quantity'}
					<span class={Number(r.balance) === 0 ? 'text-muted-foreground' : ''}
						>{qty(r.balance, r.partUom)}</span
					>
				{:else if col.key === 'lotNumber'}
					{@const lot = r.serialNumber ?? r.lotNumber}
					{#if lot}{lot}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'sourceType'}
					<span class="font-mono text-xs text-muted-foreground">{sourceLabel(r.sourceType)}</span>
				{:else if col.key === 'expirationDate'}
					{#if r.expirationDate}
						{date(r.expirationDate)}
						{#if r.isExpired}<State value="expired" tone="error" label="EXPIRED" class="ml-1" />
						{:else if r.daysUntilExpiration !== null && r.daysUntilExpiration <= 30}<State
								value="expiring"
								tone="warn"
								label="{r.daysUntilExpiration}D"
								class="ml-1"
							/>{/if}
					{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'calibrationDueAt'}
					{#if r.partIsTooling && r.calibrationDueAt}
						{date(r.calibrationDueAt)}
						{#if r.calibrationStatus === 'overdue'}<State
								value="overdue"
								tone="error"
								label="OVERDUE"
								class="ml-1"
							/>
						{:else if r.calibrationStatus === 'due_soon'}<State
								value="due"
								tone="warn"
								label="DUE"
								class="ml-1"
							/>{/if}
					{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'createdAt'}
					<Timestamp value={r.createdAt} dateOnly />
				{/if}
			{/snippet}
		</DataTable>
	{:else}
		<DataTable
			rows={data.parts}
			columns={partColumns}
			serverSort
			bind:sort={() => sorter.value, sorter.set}
			href={(r) => `/inventory?part_id=${r.partId}`}
			emptyLabel={filtered ? 'Parts matching these filters' : 'Stock'}
			key={(r) => r.partId}
		>
			{#snippet cell(r, col)}
				{#if col.key === 'part'}
					<a href="/parts/{r.partId}" class="hover:underline">
						<span class="font-mono text-info">{r.internalPn}</span>
						<span class="ml-1.5">{r.name}</span>
					</a>
				{:else if col.key === 'quantity'}
					{qty(r.balance, r.unitOfMeasure)}
					{#if r.isLowStock}<State value="low" tone="warn" label="LOW" class="ml-1" />{/if}
				{:else if col.key === 'reorderPoint'}
					{#if r.reorderPoint !== null}{qty(r.reorderPoint)}{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				{:else if col.key === 'recordCount'}
					{r.recordCount}
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
