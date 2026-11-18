<script lang="ts">
	// As-run report: each unit the work order named, and each component taken out of one.
	import type { ComponentRemoval, ExecUnit } from '@opal/shared';
	import { datetime, qtyUnit } from '#lib/format.js';

	let { units, removals }: { units: ExecUnit[]; removals: ComponentRemoval[] } = $props();
	const ts = (v: string | null) => (v ? datetime(v) : '—');
</script>

<table class="dense">
	<thead
		><tr><th>OP</th><th>As</th><th>Part</th><th>OPAL #</th><th>Serial</th><th>Named by</th></tr></thead
	>
	<tbody>
		{#each units as u (u.id)}
			<tr>
				<td>{u.stepNumber}</td>
				<td>{u.slotLabel ?? '—'}</td>
				{#if u.borrowed}
					<td>{u.borrowed.name} (borrowed{u.borrowed.lentBy ? ` from ${u.borrowed.lentBy}` : ''})</td>
					<td>—</td>
					<td>{u.borrowed.serial ?? '—'}</td>
				{:else}
					<td>{u.partNumber} {u.partName}</td>
					<td>{u.opalNumber}</td>
					<td>{u.serialNumber ?? '—'}</td>
				{/if}
				<td>{u.recordedBy ?? '—'} <span class="whitespace-nowrap">{ts(u.recordedAt)}</span></td>
			</tr>
		{/each}
	</tbody>
</table>
{#if removals.length}
	<table class="dense mt-2">
		<thead
			><tr
				><th>Step</th><th>Removed</th><th>OPAL #</th><th>Qty</th><th>From</th><th>To</th><th>By</th
				></tr
			></thead
		>
		<tbody>
			{#each removals as r (r.id)}
				<tr>
					<td>{r.stepNumber}</td>
					<td>{r.partNumber} {r.partName}{r.notes ? ` · ${r.notes}` : ''}</td>
					<td>{r.opalNumber}</td>
					<td class="text-right">{qtyUnit(r.quantity, r.uom)}</td>
					<td>{r.assemblyOpal}</td>
					<td>{r.disposition === 'stock' ? `stock, ${r.location}` : 'scrap'}</td>
					<td>{r.removedBy ?? '—'} <span class="whitespace-nowrap">{ts(r.at)}</span></td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
