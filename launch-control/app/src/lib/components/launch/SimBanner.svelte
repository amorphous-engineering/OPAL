<script lang="ts">
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';

	let { sim }: { sim: LaunchSim } = $props();

	const faults = $derived([
		{
			label: `Pad key: ${sim.padKey}`,
			on: sim.padKey === 'ARMED',
			act: () => sim.turnPadKey()
		},
		{ label: 'Gust', on: sim.gust, act: () => sim.toggle('gust') },
		{ label: 'Drop link', on: sim.linkDown, act: () => sim.toggle('linkDown') },
		{ label: 'Lose continuity', on: sim.contLost, act: () => sim.toggle('contLost') },
		{ label: 'Drop OPAL', on: sim.opalDown, act: () => sim.toggle('opalDown') }
	]);
</script>

<div
	role="status"
	class="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1 border-b border-info bg-info px-3 py-0.5 font-mono text-xs font-medium tracking-wider text-primary-foreground uppercase"
>
	<span>PROTOTYPE — SIMULATED VEHICLE AND OPAL LINK. NO HARDWARE CONNECTED.</span>
	<span class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 normal-case">
		{#each faults as f (f.label)}
			<button type="button" class="underline" aria-pressed={f.on} onclick={f.act}
				>{f.label}{f.label.startsWith('Pad key') ? '' : f.on ? ': on' : ': off'}</button
			>
		{/each}
	</span>
</div>
