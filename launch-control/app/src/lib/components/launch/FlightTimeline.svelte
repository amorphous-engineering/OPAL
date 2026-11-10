<script lang="ts">
	// The flight computer's state machine as one strip: where it is, what it reached and when,
	// what is still predicted (pencil).
	import { Section } from '#lib/components/opal/index.js';
	import { PREDICTED, type LaunchSim } from '#lib/launch/sim.svelte.js';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	type Cell = { key: string; full: string; short: string; at?: number; predicted?: number };
	const CELLS: Cell[] = [
		{ key: 'PAD_IDLE', full: 'PAD_IDLE', short: 'IDLE' },
		{ key: 'PAD_READY', full: 'PAD_READY', short: 'READY' },
		{ key: 'BOOST', full: 'BOOST', short: 'BOOST', predicted: PREDICTED.BOOST },
		{ key: 'COAST', full: 'COAST', short: 'COAST', predicted: PREDICTED.COAST },
		{ key: 'DROGUE', full: 'APOGEE / DROGUE', short: 'DROGUE', predicted: PREDICTED.DROGUE },
		{ key: 'MAIN', full: 'MAIN', short: 'MAIN', predicted: PREDICTED.MAIN },
		{ key: 'LANDED', full: 'LANDED', short: 'LANDED', predicted: PREDICTED.LANDED }
	];

	let width = $state(0);
	const wide = $derived(width >= 900);

	const current = $derived(
		Math.max(
			0,
			CELLS.findIndex((c) => c.key === (sim.fcState === 'PAD' ? 'PAD_READY' : sim.fcState))
		)
	);

	const t = (s: number) =>
		`T+${Math.floor(s / 60)
			.toString()
			.padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

	// The sim keeps only the latest sample, so the peaks are tracked here.
	let maxVel = $state(0);
	let maxAcc = $state(0);
	$effect(() => {
		if (sim.vel > maxVel) maxVel = sim.vel;
		if (sim.acc > maxAcc) maxAcc = sim.acc;
	});

	const flown = $derived(sim.phase === 'flight' || sim.phase === 'landed' || sim.phase === 'safed');
	const apogeeReached = $derived(['DROGUE', 'MAIN', 'LANDED'].includes(sim.flight) && flown);
	const flightTime = $derived(
		sim.flightTimes.LANDED ?? (flown ? Math.max(0, sim.clockMs / 1000) : null)
	);
	const g = 9.80665;
</script>

<Section title="Flight state">
	<div bind:clientWidth={width}>
		{#if sim.phase === 'scrubbed'}
			<p class="mono px-3 py-2 text-sm text-quiet">SCRUBBED</p>
		{:else}
			<ol class="grid grid-cols-7 border-b border-dotted border-border">
				{#each CELLS as c, i (c.key)}
					{@const here = i === current}
					{@const reached = i < current || (here && i === CELLS.length - 1 && flown)}
					{@const at = sim.flightTimes[c.key as keyof typeof sim.flightTimes]}
					<li
						class={cn(
							'min-w-0 border-r border-dotted border-border px-2 py-1.5 last:border-r-0',
							here && 'bg-foreground text-background'
						)}
						aria-current={here ? 'step' : undefined}
					>
						<div
							class={cn(
								'mono truncate text-xs',
								!here && reached && 'text-ok',
								here && 'font-bold'
							)}
						>
							{wide ? c.full : c.short}
						</div>
						<div class={cn('mono truncate text-xs tabular-nums', !here && !reached && 'text-tan')}>
							{#if at !== undefined}
								{t(at)}
							{:else if c.predicted !== undefined && !reached}
								≈ T+{c.predicted.toFixed(1)} s
							{:else}
								—
							{/if}
						</div>
					</li>
				{/each}
			</ol>
			<p class="mono flex flex-wrap gap-x-6 gap-y-0.5 px-3 py-1.5 text-xs tabular-nums">
				<span>
					<span class="text-quiet">Apogee</span>
					{apogeeReached ? `${Math.round(sim.apogee)} m` : '—'}
				</span>
				<span>
					<span class="text-quiet">Max velocity</span>
					{flown ? `${Math.round(maxVel)} m/s` : '—'}
				</span>
				<span>
					<span class="text-quiet">Max acceleration</span>
					{flown ? `${(maxAcc / g).toFixed(1)} g` : '—'}
				</span>
				<span>
					<span class="text-quiet">Flight time</span>
					{flightTime !== null ? `${flightTime.toFixed(1)} s` : '—'}
				</span>
			</p>
		{/if}
	</div>
</Section>
