<script lang="ts">
	// Audit trail excerpt: who changed what, newest first.
	import {
		DataTable,
		EmptyLine,
		Section,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { opal } from '#lib/api.js';
	import { datetime } from '#lib/format.js';
	import { ActionLink } from '#lib/components/opal/index.js';
	import type { PartHistoryEntry as HistoryEntry } from '@opal/shared';

	let { partId, version }: { partId: number; version: string } = $props();

	let items = $state<HistoryEntry[]>([]);
	let total = $state(0);
	let loaded = $state(false);

	// Raw ids are not facts a reader wants.
	const HIDE = new Set(['activatedById', 'obsoletedById']);

	$effect(() => {
		void version;
		opal.parts
			.history({ id: partId, limit: 12 })
			.then((r) => {
				items = r.items;
				total = r.total;
			})
			.catch(() => {})
			.finally(() => (loaded = true));
	});

	const columns: Column<HistoryEntry>[] = [
		{ key: 'when', label: 'When', width: '10rem' },
		{ key: 'who', label: 'By', width: '10rem' },
		{ key: 'action', label: 'Action', width: '6rem' },
		{ key: 'changes', label: 'Changes' }
	];

	const fieldLabel = (f: string) => f.replace(/([A-Z])/g, ' $1').toLowerCase();

	function fmt(v: unknown): string {
		if (v === null || v === undefined || v === '') return '—';
		if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return datetime(v);
		return typeof v === 'object' ? JSON.stringify(v) : String(v);
	}
</script>

{#if !loaded}
	<div class="h-8 animate-pulse rounded-lg border border-border bg-muted/40"></div>
{:else if items.length}
	<Section title="History" count={total > items.length ? `${items.length} of ${total}` : total}>
		{#snippet actions()}
			<ActionLink href={`/audit?entity=part&record=${partId}`}>AUDIT LOG →</ActionLink>
		{/snippet}
		<DataTable rows={items} {columns} key={(h) => h.at + h.action + h.op} emptyLabel="HISTORY">
			{#snippet cell(h, col)}
				{#if col.key === 'when'}
					<Timestamp value={h.at} />
				{:else if col.key === 'who'}
					{#if h.userName}{h.userName}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'action'}
					<span class="font-mono text-xs text-muted-foreground">{h.action.toUpperCase()}</span>
				{:else}
					{@const rows = h.changes.filter((c) => !HIDE.has(c.field))}
					{#if rows.length}
						<ul class="grid grid-cols-1 gap-0.5">
							{#each rows as c (c.field)}
								<li class="text-xs">
									<span class="label mr-2">{fieldLabel(c.field)}</span>
									<span class="mono text-muted-foreground">{fmt(c.old)}</span>
									<span aria-hidden="true">→</span>
									<span class="mono">{fmt(c.new)}</span>
								</li>
							{/each}
						</ul>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{:else}
	<EmptyLine label="HISTORY" />
{/if}
