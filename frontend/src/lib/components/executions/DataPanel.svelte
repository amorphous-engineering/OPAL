<script lang="ts">
	// Everything captured on the work order, one row per field, with who and when.
	import { DataTable, Timestamp } from '#lib/components/opal/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import type { DataRow } from '#lib/execution/types.js';

	let { store }: { store: ExecutionStore } = $props();
	const rows = $derived(store.doc!.data_rows);

	const columns: Column<DataRow>[] = [
		{ key: 'step_number', label: 'Step', mono: true, width: '5rem' },
		{ key: 'field', label: 'Field' },
		{ key: 'value', label: 'Value', mono: true },
		{ key: 'spec', label: 'Spec', mono: true },
		{ key: 'unit', label: 'Unit', mono: true, width: '5rem' },
		{ key: 'by', label: 'By', width: '12rem' },
		{ key: 'at', label: 'At', width: '10rem' }
	];
</script>

<DataTable {rows} {columns} emptyLabel="Captured data" key={(r) => `${r.step_order}-${r.field}`}>
	{#snippet cell(r, col)}
		{#if col.key === 'at'}
			<Timestamp value={r.at} />
		{:else if col.key === 'value' && r.out_of_spec}
			<span class="whitespace-pre-wrap">{r.value}</span>
			<Badge
				variant="outline"
				class="ml-2 border-error/50 bg-error-muted font-mono tracking-wider text-error"
				>OUT OF SPEC</Badge
			>
		{:else}
			{@const v = (r as unknown as Record<string, unknown>)[col.key]}
			{#if v === null || v === undefined || v === ''}<span class="text-muted-foreground">—</span
				>{:else}<span class="whitespace-pre-wrap">{v}</span>{/if}
		{/if}
	{/snippet}
</DataTable>
