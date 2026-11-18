<script lang="ts">
	// A unit's work orders: the ones that named it, and the ones that named an assembly it was in
	// at the time. Completed ones count, per procedure. Derived on the server; nothing is stored.
	import type { UnitWorkOrder, UseCount } from '@opal/shared';
	import { DataTable, Section, State, Timestamp } from '#lib/components/opal/index.js';
	import { stateLabel } from '#lib/format.js';

	let { uses, workOrders }: { uses: UseCount[]; workOrders: UnitWorkOrder[] } = $props();
</script>

{#if workOrders.length}
	<Section title="Work orders" count={workOrders.length}>
		{#snippet actions()}
			<span class="font-mono text-xs text-muted-foreground">
				{#each uses as u, n (u.procedureId)}{#if n > 0}<span> · </span>{/if}<span
						title={u.procedureNumber}>{u.procedureName.toUpperCase()} {u.count}</span
					>{/each}
			</span>
		{/snippet}
		<DataTable
			rows={workOrders}
			columns={[
				{ key: 'woNumber', label: 'WO', mono: true },
				{ key: 'procedure', label: 'Procedure' },
				{ key: 'slot', label: 'As' },
				{ key: 'status', label: 'Status' },
				{ key: 'at', label: 'Completed' }
			]}
			href={(r) => `/executions/${r.executionId}`}
			emptyLabel="Work orders"
			key={(r) => r.executionId}
		>
			{#snippet cell(r, col)}
				{#if col.key === 'woNumber'}
					<span class="font-semibold text-info">{r.woNumber}</span>
				{:else if col.key === 'procedure'}
					<span class="font-mono">{r.procedureNumber}</span> {r.procedureName}
				{:else if col.key === 'slot'}
					{#if r.viaOpal}<span class="text-muted-foreground">in</span>
						<a href={`/inventory/opal/${r.viaOpal}`} class="font-mono text-info hover:underline"
							>{r.viaOpal}</a
						>{:else}{r.slotLabel ?? '—'}{/if}
				{:else if col.key === 'status'}
					<State
						value={r.status}
						tone={r.counted
							? 'ok'
							: r.status === 'void' || r.status === 'closed_short'
								? 'muted'
								: 'warn'}
						label={stateLabel(r.status).toUpperCase()}
					/>
				{:else}
					<Timestamp value={r.completedAt} />
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{/if}
