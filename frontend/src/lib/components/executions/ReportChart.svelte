<script lang="ts">
	// A plain SVG line chart for the printed report: one numeric field over time.
	let {
		points,
		field,
		label
	}: {
		points: { recorded_at: string; values: Record<string, unknown> }[];
		field: string;
		label: string;
	} = $props();

	const W = 720;
	const H = 220;
	const pad = { l: 56, r: 16, t: 12, b: 28 };

	const data = $derived(
		points
			.map((p) => ({ t: new Date(p.recorded_at).getTime(), v: Number(p.values[field]) }))
			.filter((p) => Number.isFinite(p.v) && Number.isFinite(p.t))
			.sort((a, b) => a.t - b.t)
	);
	const t0 = $derived(data[0]?.t ?? 0);
	const t1 = $derived(data.at(-1)?.t ?? 1);
	const lo = $derived(Math.min(...data.map((d) => d.v)));
	const hi = $derived(Math.max(...data.map((d) => d.v)));
	const span = $derived(hi - lo || 1);
	const x = (t: number) => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
	const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
	const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
	const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
</script>

{#if data.length}
	<svg viewBox={`0 0 ${W} ${H}`} class="h-auto w-full" role="img" aria-label={label}>
		<rect
			x={pad.l}
			y={pad.t}
			width={W - pad.l - pad.r}
			height={H - pad.t - pad.b}
			fill="none"
			stroke="#000"
			stroke-width="1"
		/>
		{#each [lo, lo + span / 2, hi] as tick (tick)}
			<line
				x1={pad.l}
				x2={W - pad.r}
				y1={y(tick)}
				y2={y(tick)}
				stroke="#bbb"
				stroke-dasharray="3 3"
			/>
			<text x={pad.l - 6} y={y(tick) + 3} text-anchor="end" font-size="10" font-family="monospace"
				>{fmt(tick)}</text
			>
		{/each}
		<polyline
			fill="none"
			stroke="#000"
			stroke-width="1.5"
			points={data.map((d) => `${x(d.t)},${y(d.v)}`).join(' ')}
		/>
		{#each data as d (d.t)}
			<circle cx={x(d.t)} cy={y(d.v)} r="2.5" fill="#000" />
		{/each}
		<text x={pad.l} y={H - 8} font-size="10" font-family="monospace">{iso(t0)}</text>
		<text x={W - pad.r} y={H - 8} text-anchor="end" font-size="10" font-family="monospace"
			>{iso(t1)}</text
		>
	</svg>
{/if}
