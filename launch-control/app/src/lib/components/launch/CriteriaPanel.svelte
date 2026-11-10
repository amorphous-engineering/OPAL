<script lang="ts">
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import Section from '#lib/components/opal/Section.svelte';
	import State from '#lib/components/opal/State.svelte';

	let { sim }: { sim: LaunchSim } = $props();
</script>

<Section title="Launch commit criteria">
	{#snippet actions()}
		{#if sim.stale}
			<span
				class="mono inline-flex h-5 items-center border border-dotted border-foreground px-1.5 text-xs font-medium tracking-wide"
				>STALE {(sim.packetAge / 1000).toFixed(1)} s</span
			>
		{/if}
	{/snippet}
	<table class="w-full border-collapse text-sm">
		<thead>
			<tr class="border-b border-border text-left">
				<th class="label px-3 py-1 font-normal text-quiet">Criterion</th>
				<th class="label px-3 py-1 font-normal text-quiet">Value · limit</th>
				<th class="label px-3 py-1 text-right font-normal text-quiet">State</th>
			</tr>
		</thead>
		<tbody>
			{#each sim.criteria as c (c.id)}
				<tr class="border-b border-dotted border-border">
					<td class="px-3 py-1.5">{c.label}</td>
					<td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap tabular-nums">
						<div class={c.met ? '' : 'font-bold text-error'}>{c.value}</div>
						<div class="text-quiet">{c.limit}</div>
					</td>
					<td class="px-3 py-1.5 text-right">
						{#if c.met}
							<State value="MET" tone="ok" />
						{:else}
							<State value="VIOLATED" tone="error" badge />
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</Section>
