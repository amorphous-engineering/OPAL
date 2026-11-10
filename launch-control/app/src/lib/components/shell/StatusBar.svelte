<script lang="ts">
	// Two links the count depends on, each as one small fill at the left: the ground station
	// (telemetry from the vehicle and pad box) and OPAL (the record, through the plugin).
	// OPAL STALE latches like OPAL's own ticker: pressing it clears it. A lost OPAL link never
	// stops the count; the journal queues and goes in order when the link returns.
	import { cn } from '#lib/utils.js';
	import { flightSim } from '#lib/launch/sim.svelte.js';
	import type { LinkState } from '#lib/opal/link.js';

	const sim = flightSim();

	const fill: Record<LinkState, string> = {
		ONLINE: 'bg-ok-fill text-ok-on',
		STALE: 'bg-warn-fill text-warn-on',
		OFFLINE: 'bg-error-fill text-error-on'
	};
	const rf = $derived<LinkState>(
		sim.linkDown && sim.packetAge > 5000 ? 'OFFLINE' : sim.stale ? 'STALE' : 'ONLINE'
	);
	const utc = $derived(new Date(sim.now).toISOString().slice(0, 19).replace('T', ' ') + ' UTC');
	const tag = 'inline-flex h-5 items-center px-1.5 font-mono text-xs font-semibold tracking-wider';
</script>

<footer
	class="sticky bottom-0 z-30 flex h-6 items-center gap-3 border-t border-border bg-background px-3 font-mono text-xs"
>
	<span class="flex items-center gap-1.5">
		<span class="text-quiet">GROUND</span>
		<span class={cn(tag, fill[rf])} role="status">{rf}</span>
		{#if rf !== 'ONLINE'}<span class="text-quiet">{(sim.packetAge / 1000).toFixed(1)} s</span>{/if}
	</span>
	<span class="flex items-center gap-1.5">
		<span class="text-quiet">OPAL</span>
		{#if sim.opal === 'STALE'}
			<button
				type="button"
				class={cn(tag, fill.STALE, 'cursor-pointer')}
				onclick={() => sim.ackOpal()}
				title="Clear">STALE</button
			>
			<span class="text-quiet"
				>Dropped {sim.opalDroppedAt?.slice(11, 19)}{#if sim.opalBackAt}, back {sim.opalBackAt.slice(
						11,
						19
					)}{/if}</span
			>
		{:else}
			<span class={cn(tag, fill[sim.opal])} role="status">{sim.opal}</span>
		{/if}
		<span class="text-quiet">WO-0041</span>
		{#if sim.journalQueued > 0}<span class="font-bold">{sim.journalQueued} QUEUED</span>{/if}
	</span>
	<span class="ml-auto text-quiet max-[560px]:hidden">{utc}</span>
</footer>
