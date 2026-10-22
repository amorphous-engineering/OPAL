<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { PageHeader, DataTable, State, type Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { Workcenter } from '#lib/components/workcenters/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let search = $state(data.search);
	let timer: ReturnType<typeof setTimeout>;

	function go(next: { search?: string; status?: string }) {
		const q = new SvelteURLSearchParams();
		const s = next.search ?? data.search;
		const st = next.status ?? data.status;
		if (s) q.set('search', s);
		if (st !== 'active') q.set('status', st);
		goto(`/workcenters${q.size ? `?${q}` : ''}`);
	}

	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => go({ search }), 250);
	}

	const rows = $derived(
		data.workcenters.filter((w) =>
			data.status === 'all' ? true : data.status === 'inactive' ? !w.is_active : w.is_active
		)
	);

	const columns: Column<Workcenter>[] = [
		{ key: 'code', label: 'Code', mono: true, sortable: true, width: '7rem' },
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'location', label: 'Location', sortable: true },
		{
			key: 'default_step_count',
			label: 'Default steps',
			align: 'right',
			mono: true,
			sortable: true
		},
		{ key: 'queued_step_count', label: 'Queued', align: 'right', mono: true, sortable: true },
		{ key: 'is_active', label: 'Status', width: '6rem' }
	];
</script>

<PageHeader title="Workcenters">
	{#snippet actions()}
		<Button href="/workcenters/new" size="sm">+ NEW WORKCENTER</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
	<Input
		class="w-64"
		placeholder="Search code or name"
		aria-label="Search workcenters"
		bind:value={search}
		oninput={onSearch}
	/>
	<NativeSelect
		aria-label="Status"
		value={data.status}
		onchange={(e) => go({ status: e.currentTarget.value })}
	>
		<NativeSelectOption value="active">Active</NativeSelectOption>
		<NativeSelectOption value="inactive">Inactive</NativeSelectOption>
		<NativeSelectOption value="all">All</NativeSelectOption>
	</NativeSelect>
	<span class="ml-auto font-mono text-xs text-muted-foreground">{rows.length}</span>
</div>

<DataTable
	{rows}
	{columns}
	href={(r) => `/workcenters/${r.id}`}
	emptyLabel="Workcenters"
	key={(r) => r.id}
>
	{#snippet emptyAction()}
		<a href="/workcenters/new" class="font-medium text-info hover:underline">+ ADD</a>
	{/snippet}
	{#snippet cell(row, col)}
		{#if col.key === 'code'}
			<span class="text-info">{row.code}</span>
		{:else if col.key === 'is_active'}
			<!-- Active is the norm; only the exception is stated. -->
			{#if !row.is_active}<State value="inactive" tone="muted" />{/if}
		{:else}
			{@const v = (row as unknown as Record<string, string | number | null>)[col.key]}
			{#if v === null || v === ''}<span class="text-muted-foreground">—</span>{:else}{v}{/if}
		{/if}
	{/snippet}
</DataTable>
