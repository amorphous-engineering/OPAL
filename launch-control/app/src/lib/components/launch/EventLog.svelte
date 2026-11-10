<script lang="ts">
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import ActionLink from '#lib/components/opal/ActionLink.svelte';
	import EmptyLine from '#lib/components/opal/EmptyLine.svelte';
	import Section from '#lib/components/opal/Section.svelte';

	let { sim }: { sim: LaunchSim } = $props();

	const cell = (s: string) => `"${s.replaceAll('"', '""')}"`;

	function exportCsv() {
		const head = ['UTC', 'T-time', 'Actor', 'Level', 'Event'];
		const lines = sim.log.map((e) =>
			[e.utc, e.t, e.actor, e.level ?? '', e.text].map(cell).join(',')
		);
		const blob = new Blob([[head.join(','), ...lines].join('\r\n') + '\r\n'], {
			type: 'text/csv;charset=utf-8'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'FLT-0007-events.csv';
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<Section title="Event log" count={sim.log.length}>
	{#snippet actions()}
		<ActionLink onclick={exportCsv} disabled={sim.log.length === 0}>EXPORT CSV</ActionLink>
	{/snippet}
	{#if sim.log.length === 0}
		<EmptyLine label="Events" />
	{:else}
		<div class="max-h-56 overflow-y-auto">
			<table class="w-full text-xs">
				<thead class="sticky top-0 bg-card">
					<tr class="border-b border-border text-left">
						<th class="label px-3 py-1 font-normal">UTC</th>
						<th class="label px-3 py-1 font-normal">T-time</th>
						<th class="label px-3 py-1 font-normal">Actor</th>
						<th class="label w-full px-3 py-1 font-normal">Event</th>
					</tr>
				</thead>
				<tbody>
					{#each sim.log as e, i (e.utc + i)}
						<tr class="border-b border-dotted border-border align-top last:border-b-0">
							<td class="mono px-3 py-1 whitespace-nowrap text-quiet">{e.utc.slice(11, 19)}Z</td>
							<td class="mono px-3 py-1 whitespace-nowrap">{e.t}</td>
							<td class="px-3 py-1 whitespace-nowrap">{e.actor}</td>
							<td class={['px-3 py-1', !e.level && 'text-quiet']}>
								{#if e.level === 'warning'}<span class="mono font-semibold text-error">WARNING</span
									>
								{:else if e.level === 'caution'}<span class="mono font-semibold text-warn"
										>CAUTION</span
									>
								{/if}
								{e.text}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</Section>
