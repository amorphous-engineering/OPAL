<script lang="ts">
	import { PageHeader, State } from '#lib/components/opal/index.js';
	import { opalHref } from '#lib/opal/link.js';

	// Prototype data. In use, the plugin lists flights with their OPAL work orders.
	interface Row {
		number: string;
		vehicle: string;
		motor: string;
		date: string;
		apogee: string | null;
		state: string;
		execution: string;
		href: string | null;
	}
	const rows: Row[] = [
		{
			number: 'FLT-0007',
			execution: 'WO-0041',
			vehicle: 'Kestrel IV',
			motor: 'AT-H128W',
			date: 'Today',
			apogee: null,
			state: 'counting',
			href: '/flights/7'
		},
		{
			number: 'FLT-0006',
			execution: 'WO-0038',
			vehicle: 'Kestrel IV',
			motor: 'AT-H128W',
			date: '2026-10-18',
			apogee: '642',
			state: 'completed',
			href: null
		},
		{
			number: 'FLT-0005',
			execution: 'WO-0033',
			vehicle: 'Kestrel III',
			motor: 'CTI-G79',
			date: '2026-09-27',
			apogee: null,
			state: 'scrubbed',
			href: null
		},
		{
			number: 'FLT-0004',
			execution: 'WO-0029',
			vehicle: 'Kestrel III',
			motor: 'CTI-G79',
			date: '2026-09-06',
			apogee: '411',
			state: 'completed',
			href: null
		}
	];

	const th = 'label px-3 py-1.5 text-left font-normal';
</script>

<PageHeader title="Flights">
	{#snippet meta()}
		<span class="mono text-quiet">{rows.length}</span>
	{/snippet}
</PageHeader>

<div class="p-3">
	<div class="overflow-x-auto border border-border bg-card">
		<table class="w-full border-collapse text-sm">
			<thead class="border-b border-border bg-muted/60">
				<tr>
					<th class={th}>Number</th>
					<th class={th}>Vehicle</th>
					<th class={th}>Motor</th>
					<th class={th}>Work order</th>
					<th class={th}>Date</th>
					<th class="{th} text-right">Apogee</th>
					<th class={th}>State</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.number)}
					<tr class="border-b border-border last:border-b-0">
						<td class="px-3 py-1.5 font-mono whitespace-nowrap">
							{#if r.href}<a class="text-info hover:underline" href={r.href}>{r.number}</a
								>{:else}<span class="text-info">{r.number}</span>{/if}
						</td>
						<td class="px-3 py-1.5">{r.vehicle}</td>
						<td class="px-3 py-1.5 font-mono">{r.motor}</td>
						<td class="px-3 py-1.5 font-mono">
							<a
								class="text-info hover:underline"
								href={opalHref(`/executions?q=${r.execution}`)}
								target="_blank"
								rel="noopener">{r.execution}</a
							>
						</td>
						<td class="px-3 py-1.5 font-mono whitespace-nowrap text-quiet">{r.date}</td>
						<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap"
							>{#if r.apogee}{r.apogee} m{:else}<span class="text-quiet">—</span>{/if}</td
						>
						<td class="px-3 py-1.5"><State value={r.state} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
