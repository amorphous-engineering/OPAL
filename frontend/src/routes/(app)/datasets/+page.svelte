<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { PageHeader, DataTable, Timestamp, type Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { DatasetSummary } from '#lib/components/datasets/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let search = $state(data.search);
	let timer: ReturnType<typeof setTimeout>;

	function go(next: { search?: string; procedure?: string; page?: number }) {
		const q = new SvelteURLSearchParams();
		const s = next.search ?? data.search;
		const p = next.procedure ?? data.procedure;
		if (s) q.set('search', s);
		if (p) q.set('procedure', p);
		if (next.page && next.page > 1) q.set('page', String(next.page));
		goto(`/datasets${q.size ? `?${q}` : ''}`);
	}

	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => go({ search, page: 1 }), 250);
	}

	const columns: Column<DatasetSummary>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'procedure_name', label: 'Procedure', sortable: true },
		{
			key: 'fields',
			label: 'Fields',
			align: 'right',
			mono: true,
			sortValue: (r) => r.schema.fields?.length ?? 0
		},
		{ key: 'point_count', label: 'Points', align: 'right', mono: true, sortable: true },
		{ key: 'updated_at', label: 'Updated', sortable: true }
	];

	const pages = $derived(Math.max(1, Math.ceil(data.datasets.total / 50)));
</script>

<PageHeader title="Datasets">
	{#snippet actions()}
		<Button href="/datasets/new" size="sm">+ NEW DATASET</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
	<Input
		class="w-64"
		placeholder="Search name"
		aria-label="Search datasets"
		bind:value={search}
		oninput={onSearch}
	/>
	<NativeSelect
		aria-label="Procedure"
		value={data.procedure}
		onchange={(e) => go({ procedure: e.currentTarget.value, page: 1 })}
	>
		<NativeSelectOption value="">All procedures</NativeSelectOption>
		{#each data.procedures as p (p.id)}
			<NativeSelectOption value={String(p.id)}>{p.name}</NativeSelectOption>
		{/each}
	</NativeSelect>
	<span class="ml-auto font-mono text-xs text-muted-foreground">{data.datasets.total}</span>
</div>

<DataTable
	rows={data.datasets.items}
	{columns}
	href={(r) => `/datasets/${r.id}`}
	emptyLabel="Datasets"
	key={(r) => r.id}
>
	{#snippet emptyAction()}
		<a href="/datasets/new" class="font-medium text-info hover:underline">+ ADD</a>
	{/snippet}
	{#snippet cell(row, col)}
		{#if col.key === 'name'}
			<span class="font-medium">{row.name}</span>
		{:else if col.key === 'procedure_name'}
			{#if row.procedure_id}
				<a href={`/procedures/${row.procedure_id}`} class="text-info hover:underline"
					>{row.procedure_name}</a
				>
			{:else}<span class="text-muted-foreground">—</span>{/if}
		{:else if col.key === 'fields'}
			{row.schema.fields?.length ?? 0}
		{:else if col.key === 'point_count'}
			{row.point_count}
		{:else if col.key === 'updated_at'}
			<Timestamp value={row.updated_at} />
		{/if}
	{/snippet}
</DataTable>

{#if pages > 1}
	<div class="flex items-center gap-2 border-t border-border px-4 py-2 font-mono text-xs">
		<Button
			variant="outline"
			size="sm"
			disabled={data.page <= 1}
			onclick={() => go({ page: data.page - 1 })}>PREV</Button
		>
		<span>{data.page} / {pages}</span>
		<Button
			variant="outline"
			size="sm"
			disabled={data.page >= pages}
			onclick={() => go({ page: data.page + 1 })}>NEXT</Button
		>
	</div>
{/if}
