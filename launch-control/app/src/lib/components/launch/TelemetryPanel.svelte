<script lang="ts">
	// Structure: vehicle telemetry grouped by source, with data age beside the title and an altitude plot.
	import Section from '#lib/components/opal/Section.svelte';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	const BATT_MIN = 7.4;
	const CONT_MAX = 5;

	const age = $derived((sim.packetAge / 1000).toFixed(1));
	// Amber only past the stale threshold plus margin: waiting on a person to decide.
	const severe = $derived(sim.stale && sim.packetAge > 1500);
	const inFlight = $derived(
		sim.phase === 'flight' || sim.phase === 'landed' || sim.phase === 'safed'
	);
	const v = $derived(sim.stale ? 'text-quiet' : '');
	const battLow = $derived(sim.fcBatt < BATT_MIN);
	const igniterOpen = $derived(sim.igniterOhm >= 99);

	// Plot geometry. Width follows the box so tick labels never stretch.
	let w = $state(600);
	const H = 160;
	const M = { l: 56, r: 16, t: 10, b: 24 };

	const plot = $derived.by(() => {
		const s = sim.samples;
		if (s.length < 2) return null;
		const tMax = Math.max(10, Math.ceil(s[s.length - 1].t / 10) * 10);
		const peak = s.reduce((a, p) => (p.alt > a.alt ? p : a), s[0]);
		const step = peak.alt > 600 ? 200 : peak.alt > 250 ? 100 : 50;
		const aMax = Math.max(step, Math.ceil((peak.alt * 1.05) / step) * step);
		const x = (t: number) => M.l + (t / tMax) * (w - 24 - M.l - M.r);
		const y = (a: number) => H - M.b - (a / aMax) * (H - M.t - M.b);
		const xStep = tMax > 50 ? 20 : 10;
		const xTicks = Array.from({ length: Math.floor(tMax / xStep) + 1 }, (_, i) => i * xStep);
		const yTicks = Array.from({ length: Math.floor(aMax / step) + 1 }, (_, i) => i * step);
		return {
			x,
			y,
			xTicks,
			yTicks,
			peak,
			points: s.map((p) => `${x(p.t).toFixed(1)},${y(p.alt).toFixed(1)}`).join(' ')
		};
	});
</script>

{#snippet group(name: string)}
	<div class="label border-b border-dotted border-border px-3 pt-2 pb-1 text-muted-foreground">
		{name}
	</div>
{/snippet}

<Section title="Vehicle">
	{#snippet actions()}
		<span class="mono text-xs text-quiet">LINK {age} s</span>
		{#if sim.stale}
			<span
				class={cn(
					'mono border border-dotted border-foreground px-1.5 text-xs font-bold',
					severe && 'bg-warn-fill text-warn-on'
				)}>STALE {age} s</span
			>
		{/if}
	{/snippet}

	<div class="grid gap-x-0">
		<div>
			{@render group('Flight computer')}
			<dl class="m-0">
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						State
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] font-bold whitespace-nowrap tabular-nums', v)}>
						{sim.fcState}
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Battery
					</dt>
					<dd
						class={cn(
							'm-0 font-mono text-[13px] whitespace-nowrap tabular-nums',
							v,
							!sim.stale && battLow && 'text-error'
						)}
					>
						{sim.fcBatt.toFixed(2)} V
						{#if battLow}<span class="font-bold">LOW</span>{/if}
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Tilt
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.tilt.toFixed(1)} °
					</dd>
				</div>
				<div class="flex items-baseline gap-3 px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						GPS
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.sats} sats
					</dd>
				</div>
			</dl>

			{@render group('Pyro')}
			<dl class="m-0">
				{#each [{ l: 'Drogue', o: sim.drogueOhm }, { l: 'Main', o: sim.mainOhm }] as ch, i (ch.l)}
					<div
						class={cn(
							'flex items-baseline gap-3 px-3 py-1',
							i === 0 && 'border-b border-dotted border-border'
						)}
					>
						<dt
							class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
						>
							{ch.l}
						</dt>
						<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
							{ch.o.toFixed(1)} Ω
							{#if ch.o < CONT_MAX}
								<span class={cn('font-bold', !sim.stale && 'text-ok')}>CONT</span>
							{:else}
								<span class={cn('font-bold', !sim.stale && 'text-error')}>OPEN</span>
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		</div>

		<div class="border-t border-border">
			{@render group('Pad box')}
			<dl class="m-0">
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Pad key
					</dt>
					<dd
						class={cn(
							'm-0 font-mono text-[13px] whitespace-nowrap tabular-nums',
							v,
							sim.padKey === 'ARMED' && 'font-bold'
						)}
					>
						{sim.padKey}
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Igniter
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{#if igniterOpen}
							<span class={cn('font-bold', !sim.stale && 'text-error')}>OPEN</span>
						{:else}
							{sim.igniterOhm.toFixed(1)} Ω
						{/if}
					</dd>
				</div>
				<div class="flex items-baseline gap-3 px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Battery
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.padBatt.toFixed(1)} V
					</dd>
				</div>
			</dl>

			{@render group('Link')}
			<dl class="m-0">
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						RSSI
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.rssi} dBm
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						SNR
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.snr.toFixed(1)} dB
					</dd>
				</div>
				<div class="flex items-baseline gap-3 px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Packet age
					</dt>
					<dd
						class={cn(
							'm-0 font-mono text-[13px] whitespace-nowrap tabular-nums',
							sim.stale ? 'font-bold' : ''
						)}
					>
						{age} s
					</dd>
				</div>
			</dl>
		</div>
	</div>

	{#if inFlight}
		<div class="border-t border-border">
			{@render group('Flight')}
			<dl class="m-0">
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Altitude AGL
					</dt>
					<dd class={cn('m-0 font-mono text-base font-bold whitespace-nowrap tabular-nums', v)}>
						{sim.baroAlt.toFixed(1)} m
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						State
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] font-bold whitespace-nowrap tabular-nums', v)}>
						{sim.flight}
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Velocity
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.vel.toFixed(1)} m/s
					</dd>
				</div>
				<div class="flex items-baseline gap-3 border-b border-dotted border-border px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Acceleration
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.acc.toFixed(1)} m/s²
					</dd>
				</div>
				<div class="flex items-baseline gap-3 px-3 py-1">
					<dt
						class="w-28 shrink-0 font-mono text-xs tracking-wider text-muted-foreground uppercase"
					>
						Apogee
					</dt>
					<dd class={cn('m-0 font-mono text-[13px] whitespace-nowrap tabular-nums', v)}>
						{sim.apogee.toFixed(0)} m
					</dd>
				</div>
			</dl>
		</div>
	{/if}

	<div class="border-t border-border px-3 py-2" bind:clientWidth={w}>
		{#if plot}
			<svg
				width={w - 24}
				height={H}
				viewBox="0 0 {w - 24} {H}"
				class="block h-40 w-full"
				role="img"
				aria-label="Altitude against time"
			>
				{#each plot.yTicks as a (a)}
					<line
						x1={M.l}
						x2={w - 24 - M.r}
						y1={plot.y(a)}
						y2={plot.y(a)}
						stroke="var(--border)"
						stroke-dasharray={a === 0 ? undefined : '1 3'}
					/>
					<text
						x={M.l - 6}
						y={plot.y(a) + 4}
						text-anchor="end"
						font-size="12"
						class="font-mono"
						fill="var(--quiet)">{a} m</text
					>
				{/each}
				{#each plot.xTicks as t (t)}
					<line
						x1={plot.x(t)}
						x2={plot.x(t)}
						y1={M.t}
						y2={H - M.b}
						stroke="var(--border)"
						stroke-dasharray={t === 0 ? undefined : '1 3'}
					/>
					<text
						x={plot.x(t)}
						y={H - 6}
						text-anchor="middle"
						font-size="12"
						class="font-mono"
						fill="var(--quiet)">{t} s</text
					>
				{/each}
				<polyline
					points={plot.points}
					fill="none"
					stroke="var(--foreground)"
					stroke-width="1.5"
					stroke-linejoin="round"
				/>
				<line
					x1={plot.x(plot.peak.t)}
					x2={plot.x(plot.peak.t)}
					y1={plot.y(plot.peak.alt) - 6}
					y2={plot.y(plot.peak.alt) - 1}
					stroke="var(--foreground)"
				/>
				<text
					x={plot.x(plot.peak.t)}
					y={plot.y(plot.peak.alt) - 9}
					text-anchor={plot.x(plot.peak.t) > w - 120 ? 'end' : 'start'}
					font-size="12"
					class="font-mono"
					fill="var(--foreground)">{plot.peak.alt.toFixed(0)} m</text
				>
			</svg>
		{:else}
			<p class="m-0 text-sm text-quiet">No flight data.</p>
		{/if}
	</div>
</Section>
