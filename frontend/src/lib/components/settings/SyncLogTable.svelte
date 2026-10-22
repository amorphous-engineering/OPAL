<script lang="ts">
	import { DataTable, State, Timestamp, type Column } from '#lib/components/opal/index.js';
	import type { SyncLog } from './types.js';

	let { logs, emptyLabel = 'SYNC LOG' }: { logs: SyncLog[]; emptyLabel?: string } = $props();

	const columns: Column<SyncLog>[] = [
		{ key: 'started_at', label: 'Started', class: 'whitespace-nowrap' },
		{ key: 'direction', label: 'Dir' },
		{ key: 'trigger', label: 'Trigger' },
		{ key: 'status', label: 'Status' },
		{ key: 'parts', label: 'Parts +/~', align: 'right', mono: true },
		{ key: 'bom', label: 'BOM +/~/-', align: 'right', mono: true },
		{ key: 'summary', label: 'Summary' }
	];

	const tone = (s: string) =>
		s === 'success' ? 'ok' : s === 'partial' ? 'warn' : s === 'error' ? 'error' : 'muted';
</script>

<DataTable rows={logs} {columns} key={(l) => l.id} {emptyLabel} dense>
	{#snippet cell(l, col)}
		{#if col.key === 'started_at'}
			<Timestamp value={l.started_at} />
		{:else if col.key === 'direction'}
			<span class="font-mono text-xs uppercase">{l.direction}</span>
		{:else if col.key === 'trigger'}
			<span class="font-mono text-xs">{l.trigger}</span>
		{:else if col.key === 'status'}
			<State
				value={l.status}
				tone={tone(l.status)}
				label={l.status === 'success' ? 'OK' : undefined}
			/>
		{:else if col.key === 'parts'}
			{l.parts_created}/{l.parts_updated}
		{:else if col.key === 'bom'}
			{l.bom_lines_created}/{l.bom_lines_updated}/{l.bom_lines_removed}
		{:else}
			<span class="whitespace-pre-line text-muted-foreground">{l.summary ?? '—'}</span>
		{/if}
	{/snippet}
</DataTable>
