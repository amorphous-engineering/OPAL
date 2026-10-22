<script lang="ts">
	import {
		DataTable,
		EmptyLine,
		Section,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import type { ActivityEntry } from './types.js';

	let { entries, userId }: { entries: ActivityEntry[]; userId: number } = $props();

	const columns: Column<ActivityEntry>[] = [
		{ key: 'timestamp', label: 'Time', class: 'whitespace-nowrap' },
		{ key: 'action', label: 'Action', width: '6rem' },
		{ key: 'table', label: 'Record' }
	];

	const label = (t: string) => t.replace(/_/g, ' ');
</script>

{#if entries.length === 0}
	<div class="border border-border bg-card"><EmptyLine label="Activity" /></div>
{:else}
	<Section title="Recent activity" count={entries.length}>
		{#snippet actions()}
			<a
				class="font-mono text-[11px] tracking-wider text-info uppercase hover:underline"
				href={`/audit?user=${userId}`}>AUDIT LOG</a
			>
		{/snippet}
		<DataTable rows={entries} {columns} emptyLabel="ACTIVITY" dense>
			{#snippet cell(e, col)}
				{#if col.key === 'timestamp'}
					<Timestamp value={e.timestamp} />
				{:else if col.key === 'action'}
					<span class="font-mono text-xs uppercase">{e.action}</span>
				{:else}
					<span class="text-muted-foreground">{label(e.table)}</span>
					{#if e.subject}<span class="ml-1 font-mono text-xs">{e.subject}</span>{/if}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{/if}
