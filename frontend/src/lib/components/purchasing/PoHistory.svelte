<script lang="ts">
	// Every change since the order was placed, from the audit log: old, new, who, when, why.
	import { DataTable, Section, Timestamp, type Column } from '#lib/components/opal/index.js';
	import { changeValue, fieldLabel, type PurchaseChange } from './types.js';

	let { changes }: { changes: PurchaseChange[] } = $props();

	const columns: Column<PurchaseChange>[] = [
		{ key: 'at', label: 'When' },
		{ key: 'userName', label: 'By' },
		{ key: 'what', label: 'Change' },
		{ key: 'old', label: 'Was' },
		{ key: 'new', label: 'Now' },
		{ key: 'reason', label: 'Reason' }
	];
	// Newest first, as the other history lists read.
	const rows = $derived([...changes].reverse());
</script>

<Section title="HISTORY" count={changes.length}>
	<DataTable {rows} {columns} emptyLabel="History" key={(c) => `${c.at}-${c.lineId}-${c.field}`}>
		{#snippet cell(c, col)}
			{#if col.key === 'at'}
				<Timestamp value={c.at} />
			{:else if col.key === 'userName'}
				{c.userName ?? '—'}
			{:else if col.key === 'what'}
				{fieldLabel(c.field)}
				{#if c.partInternalPn}<span class="ml-1 font-mono text-xs text-muted-foreground"
						>{c.partInternalPn}</span
					>{/if}
			{:else if col.key === 'old'}
				<span class="font-mono text-xs {c.old ? 'line-through' : 'text-muted-foreground'}"
					>{c.field === 'line' ? '—' : changeValue(c, c.old)}</span
				>
			{:else if col.key === 'new'}
				<span class="font-mono text-xs">{changeValue(c, c.new)}</span>
			{:else if c.reason}
				{c.reason}
			{:else}
				<span class="text-quiet">—</span>
			{/if}
		{/snippet}
	</DataTable>
</Section>
