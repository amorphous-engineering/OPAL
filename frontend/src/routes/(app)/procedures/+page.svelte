<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		DataTable,
		EmptyLine,
		PageHeader,
		State,
		Timestamp
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import type { ProcedureRow } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const params = $derived(page.url.searchParams);
	const filtered = $derived(!!(params.get('q') || params.get('status') || params.get('type')));

	// API sort name per column key.
	const SORT_KEYS: Record<string, string> = {
		name: 'name',
		procedure_type: 'type',
		status: 'status',
		current_version_number: 'version',
		step_count: 'steps',
		execution_count: 'executions',
		updated_at: 'updated_at',
		created_at: 'created_at'
	};
	const KEY_OF = Object.fromEntries(Object.entries(SORT_KEYS).map(([k, v]) => [v, k]));

	const columns: Column<ProcedureRow>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'procedure_type', label: 'Type', sortable: true, width: '6rem', mono: true },
		{ key: 'status', label: 'Status', sortable: true, width: '8rem' },
		{ key: 'current_version_number', label: 'Version', sortable: true, width: '6rem', mono: true },
		{
			key: 'step_count',
			label: 'Steps',
			sortable: true,
			align: 'right',
			width: '5rem',
			mono: true
		},
		{
			key: 'execution_count',
			label: 'Executions',
			sortable: true,
			align: 'right',
			width: '7rem',
			mono: true
		},
		{ key: 'updated_at', label: 'Updated', sortable: true, width: '10rem' }
	];

	const urlSort = $derived.by(() => {
		const s = params.get('sort') ?? 'updated_at';
		return { key: KEY_OF[s] ?? 'updated_at', dir: (params.get('dir') ?? 'desc') as 'asc' | 'desc' };
	});

	function go(patch: Record<string, string | null>, keepFocus = false) {
		const next = new SvelteURLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(patch)) {
			if (v) next.set(k, v);
			else next.delete(k);
		}
		if (!('page' in patch)) next.delete('page');
		const qs = next.toString();
		goto(qs ? `?${qs}` : page.url.pathname, { reset: !keepFocus, replace: true });
	}

	function setSort(next: { key: string; dir: 'asc' | 'desc' } | null) {
		if (!next) go({ sort: null, dir: null });
		else go({ sort: SORT_KEYS[next.key], dir: next.dir });
	}

	let search = $state(page.url.searchParams.get('q') ?? '');
	let timer: ReturnType<typeof setTimeout> | undefined;
	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => go({ q: search.trim() || null }, true), 250);
	}

	const total = $derived(data.result.total);
	const pageNo = $derived(data.result.page ?? 1);
	const pages = $derived(Math.max(1, Math.ceil(total / (data.result.page_size ?? 50))));
</script>

<PageHeader title="Templates" crumbs={[{ label: 'Manufacturing' }]}>
	{#snippet actions()}
		<Button href="/procedures/new">+ NEW TEMPLATE</Button>
	{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
	<Input
		type="search"
		class="w-64"
		placeholder="Search name or description"
		aria-label="Search templates"
		bind:value={search}
		oninput={onSearch}
	/>
	<NativeSelect
		class="w-36"
		aria-label="Type"
		value={params.get('type') ?? ''}
		onchange={(e) => go({ type: e.currentTarget.value || null })}
	>
		<NativeSelectOption value="">All types</NativeSelectOption>
		<NativeSelectOption value="op">OP</NativeSelectOption>
		<NativeSelectOption value="build">BUILD</NativeSelectOption>
	</NativeSelect>
	<NativeSelect
		class="w-40"
		aria-label="Status"
		value={params.get('status') ?? ''}
		onchange={(e) => go({ status: e.currentTarget.value || null })}
	>
		<NativeSelectOption value="">All statuses</NativeSelectOption>
		<NativeSelectOption value="draft">DRAFT</NativeSelectOption>
		<NativeSelectOption value="active">ACTIVE</NativeSelectOption>
		<NativeSelectOption value="deprecated">DEPRECATED</NativeSelectOption>
	</NativeSelect>
	{#if filtered}
		<Button
			variant="ghost"
			size="sm"
			onclick={() => {
				search = '';
				goto(page.url.pathname, { replace: true });
			}}>CLEAR</Button
		>
	{/if}
	<span class="ml-auto font-mono text-xs text-muted-foreground">{total} TOTAL</span>
</div>

{#if data.result.items.length === 0 && filtered}
	<EmptyLine label="Matching templates" />
{:else}
	<DataTable
		rows={data.result.items}
		{columns}
		bind:sort={() => urlSort, setSort}
		serverSort
		emptyLabel="Templates"
		key={(r) => r.id}
		href={(r) => `/procedures/${r.id}`}
	>
		{#snippet emptyAction()}
			<a href="/procedures/new" class="font-medium text-info hover:underline">+ ADD</a>
		{/snippet}
		{#snippet cell(r, col)}
			{#if col.key === 'name'}
				<a href={`/procedures/${r.id}`} class="font-medium text-info hover:underline">{r.name}</a>
			{:else if col.key === 'procedure_type'}
				{r.procedure_type.toUpperCase()}
			{:else if col.key === 'status'}
				<State value={r.status} />
			{:else if col.key === 'current_version_number'}
				{#if r.current_version_number}v{r.current_version_number}{:else}<span
						class="text-muted-foreground">—</span
					>{/if}
			{:else if col.key === 'updated_at'}
				<Timestamp value={r.updated_at} />
			{:else}
				{(r as unknown as Record<string, unknown>)[col.key]}
			{/if}
		{/snippet}
	</DataTable>
{/if}

{#if pages > 1}
	<div class="flex items-center gap-2 border-t border-border px-4 py-2 font-mono text-xs">
		<Button
			variant="outline"
			size="xs"
			disabled={pageNo <= 1}
			onclick={() => go({ page: String(pageNo - 1) })}>PREV</Button
		>
		<span class="text-muted-foreground">PAGE {pageNo} / {pages}</span>
		<Button
			variant="outline"
			size="xs"
			disabled={pageNo >= pages}
			onclick={() => go({ page: String(pageNo + 1) })}>NEXT</Button
		>
	</div>
{/if}
