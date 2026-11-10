<script lang="ts">
	// Structure: plan view of the ground track beside the position readout. The prediction is pencil, so it is tan.
	import Section from '#lib/components/opal/Section.svelte';
	import ActionLink from '#lib/components/opal/ActionLink.svelte';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	const SAFE_M = 30;
	const NICE = [100, 250, 500, 1000, 2000, 5000, 10000];
	const PAD_PX = 4; // half side of the pad marker

	let w = $state(200);
	const size = $derived(Math.max(160, Math.min(w, 260)));
	const c = $derived(size / 2);
	// Leave room for ring labels and the N tick.
	const R = $derived(c - 18);

	const range = (p: { e: number; n: number }) => Math.hypot(p.e, p.n);
	const bearing = (p: { e: number; n: number }) =>
		((Math.atan2(p.e, p.n) * 180) / Math.PI + 360) % 360;
	const brg = (deg: number) => `${String(Math.round(deg) % 360).padStart(3, '0')}° T`;

	const top = $derived.by(() => {
		const pts = [...sim.track, { e: sim.east, n: sim.north }];
		if (sim.predicted && sim.flight !== 'LANDED') pts.push(sim.predicted);
		const ext = Math.max(...pts.map((p) => Math.max(Math.abs(p.e), Math.abs(p.n))));
		return NICE.find((n) => n >= ext * 1.05) ?? NICE[NICE.length - 1];
	});
	const rings = $derived([top / 2, top]);
	const px = $derived(R / top);
	// North up: northing grows toward the top of the screen.
	const X = (e: number) => c + e * px;
	const Y = (n: number) => c - n * px;

	const landed = $derived(sim.flight === 'LANDED');
	const pred = $derived(landed ? null : sim.predicted);
	const trackPts = $derived(
		sim.track.map((p) => `${X(p.e).toFixed(1)},${Y(p.n).toFixed(1)}`).join(' ')
	);
	const vx = $derived(X(sim.east));
	const vy = $derived(Y(sim.north));

	// Arrow points to where the wind blows: windDir is where it blows from.
	const toDeg = $derived((sim.windDir + 180) % 360);
	const arrow = $derived.by(() => {
		const a = (toDeg * Math.PI) / 180;
		const dx = Math.sin(a);
		const dy = -Math.cos(a);
		const cx = 24;
		const cy = 24;
		const L = 12;
		const hx = cx + dx * L;
		const hy = cy + dy * L;
		const tx = cx - dx * L;
		const ty = cy - dy * L;
		const h = 5;
		const lx = hx - dx * h - dy * h * 0.6;
		const ly = hy - dy * h + dx * h * 0.6;
		const rx = hx - dx * h + dy * h * 0.6;
		const ry = hy - dy * h - dx * h * 0.6;
		return { tx, ty, hx, hy, head: `${lx},${ly} ${hx},${hy} ${rx},${ry}` };
	});

	const age = $derived((sim.packetAge / 1000).toFixed(1));
	const q = $derived(sim.stale ? 'text-quiet' : '');
	const latTxt = $derived(`${sim.lat.toFixed(4)}° N`);
	const lonTxt = $derived(`${Math.abs(sim.lon).toFixed(4)}° W`);
	const predTxt = $derived(pred ? `${Math.round(range(pred))} m · ${brg(bearing(pred))}` : null);

	function copy() {
		try {
			navigator.clipboard
				?.writeText(`${sim.lat.toFixed(4)}, ${sim.lon.toFixed(4)}`)
				?.catch(() => {});
		} catch {
			// Clipboard can be blocked; nothing to report.
		}
	}
</script>

{#snippet row(label: string, value: string | null, tone = '')}
	<div
		class="flex items-baseline justify-between gap-2 border-b border-dotted border-border py-1.5"
	>
		<dt class="font-mono text-xs tracking-wider text-muted-foreground uppercase">{label}</dt>
		<dd class={cn('mono text-right', value === null ? 'text-quiet' : tone)}>{value ?? '—'}</dd>
	</div>
{/snippet}

<Section title="Recovery">
	{#snippet actions()}
		{#if sim.stale}
			<span class="mono text-xs text-quiet">LAST FIX {age} s</span>
		{/if}
	{/snippet}
	<div class="flex flex-wrap gap-3 p-3">
		<div class="min-w-40 flex-1 basis-48" bind:clientWidth={w}>
			<svg width={size} height={size} role="img" aria-label="Plan view, north up">
				{#each rings as r (r)}
					<circle
						cx={c}
						cy={c}
						r={r * px}
						fill="none"
						stroke="var(--quiet)"
						stroke-width="1"
						stroke-dasharray="1 3"
					/>
					<text
						x={c + r * px * 0.7071 + 2}
						y={c + r * px * 0.7071 + 12}
						class="mono"
						font-size="12"
						fill="var(--quiet)"
						text-anchor="end">{r} m</text
					>
				{/each}
				<circle cx={c} cy={c} r={SAFE_M * px} fill="none" stroke="var(--error)" stroke-width="1" />
				<line x1={c} y1="2" x2={c} y2="8" stroke="var(--foreground)" stroke-width="1.5" />
				<text x={c + 5} y="12" class="mono" font-size="12" fill="var(--foreground)">N</text>
				<polyline
					points={trackPts}
					fill="none"
					stroke={sim.stale ? 'var(--quiet)' : 'var(--foreground)'}
					stroke-width="1.5"
				/>
				<rect
					x={c - PAD_PX}
					y={c - PAD_PX}
					width={PAD_PX * 2}
					height={PAD_PX * 2}
					fill="var(--card)"
					stroke="var(--foreground)"
					stroke-width="1.5"
				/>
				<text
					x={c + PAD_PX + 3}
					y={c - PAD_PX - 2}
					class="mono"
					font-size="12"
					fill="var(--foreground)">PAD</text
				>
				{#if pred}
					{@const ex = X(pred.e)}
					{@const ey = Y(pred.n)}
					<line x1={vx} y1={vy} x2={ex} y2={ey} stroke="var(--tan)" stroke-width="1" />
					<circle cx={ex} cy={ey} r="5" fill="var(--card)" stroke="var(--tan)" stroke-width="1.5" />
					<text
						x={ex > size - 44 ? ex - 8 : ex + 8}
						y={ey < 28 ? ey + 16 : ey - 8}
						class="mono"
						font-size="12"
						fill="var(--tan)"
						text-anchor={ex > size - 44 ? 'end' : 'start'}>PRED</text
					>
				{/if}
				<circle cx={vx} cy={vy} r="4" fill={sim.stale ? 'var(--quiet)' : 'var(--foreground)'} />
				{#if landed}
					<text
						x={vx > size - 56 ? vx - 8 : vx + 8}
						y={vy < 28 ? vy + 16 : vy - 8}
						class="mono"
						font-size="12"
						font-weight="600"
						fill="var(--foreground)"
						text-anchor={vx > size - 56 ? 'end' : 'start'}>LANDED</text
					>
				{/if}
				<line
					x1={arrow.tx}
					y1={arrow.ty}
					x2={arrow.hx}
					y2={arrow.hy}
					stroke="var(--foreground)"
					stroke-width="1.5"
				/>
				<polyline points={arrow.head} fill="none" stroke="var(--foreground)" stroke-width="1.5" />
			</svg>
			<div class="mono -mt-1 text-xs text-muted-foreground">WIND {sim.wind.toFixed(1)} m/s</div>
		</div>
		<div class="flex min-w-40 flex-1 basis-44 flex-col">
			<dl>
				{@render row('Range', `${Math.round(sim.range)} m`, q)}
				{@render row('Bearing', brg(sim.bearing), q)}
				{@render row('Position', `${latTxt}, ${lonTxt}`, cn(q, 'text-xs'))}
				{@render row('GPS', `${sim.sats} sats`, q)}
				{@render row('Predicted landing', predTxt, 'text-tan')}
			</dl>
			<div class="pt-1.5">
				<ActionLink onclick={copy}>COPY POSITION</ActionLink>
			</div>
		</div>
	</div>
</Section>
