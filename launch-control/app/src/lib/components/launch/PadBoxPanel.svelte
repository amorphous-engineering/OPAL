<script lang="ts">
	// Structure: launch control hardware at the pad. The key is physical; this panel only mirrors it.
	import ActionLink from '#lib/components/opal/ActionLink.svelte';
	import DetailRow from '#lib/components/opal/DetailRow.svelte';
	import DetailTable from '#lib/components/opal/DetailTable.svelte';
	import Section from '#lib/components/opal/Section.svelte';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	const BATT_MIN = 11.5;

	const v = $derived(sim.stale ? 'text-quiet' : '');
	const igniter = $derived(
		sim.igniterOhm >= 99 ? 'open' : sim.igniterOhm >= 0.5 && sim.igniterOhm <= 5 ? 'cont' : 'high'
	);
	const battLow = $derived(sim.padBatt < BATT_MIN);
	// A test current through an armed circuit is a hazard, and flight has nothing left to test.
	const canTest = $derived(!sim.armed && sim.phase !== 'flight' && sim.phase !== 'landed');
	const testedAt = $derived(sim.contTestAt ? `${sim.contTestAt.slice(11, 19)}Z` : null);
</script>

<Section title="Pad box">
	{#snippet actions()}
		{#if canTest}
			<ActionLink onclick={() => sim.contTest()}>CONT TEST</ActionLink>
		{/if}
	{/snippet}

	<DetailTable>
		<DetailRow label="Pad key" mono>
			<span class={cn(v, sim.padKey === 'ARMED' && 'font-bold')}>{sim.padKey}</span>
			<span class="ml-2 text-xs text-quiet">physical</span>
		</DetailRow>
		<DetailRow label="Igniter continuity" mono>
			<span class={v}>
				{#if igniter === 'open'}
					<span class={cn('font-bold', !sim.stale && 'text-error')}>OPEN</span>
				{:else}
					{sim.igniterOhm.toFixed(1)} Ω
					{#if igniter === 'cont'}
						<span class={cn('font-bold', !sim.stale && 'text-ok')}>CONT</span>
					{:else}
						<span class="font-bold">HIGH</span>
					{/if}
				{/if}
			</span>
		</DetailRow>
		<DetailRow label="Relay" mono>
			{#if sim.relay === 'CLOSED'}
				<span class="border border-warn-fill bg-warn-fill px-1.5 text-xs font-bold text-warn-on"
					>CLOSED</span
				>
			{:else}
				<span class={v}>OPEN</span>
			{/if}
		</DetailRow>
		<DetailRow label="Fire current" mono>
			<span class={v}>{sim.fireCurrent > 0 ? `${sim.fireCurrent.toFixed(1)} A` : '—'}</span>
		</DetailRow>
		<DetailRow label="Pad battery" mono>
			<span class={cn(v, !sim.stale && battLow && 'text-error')}>
				{sim.padBatt.toFixed(1)} V
				{#if battLow}<span class="font-bold">LOW</span>{/if}
			</span>
		</DetailRow>
		<DetailRow label="Last continuity test" value={testedAt} mono />
	</DetailTable>
</Section>
