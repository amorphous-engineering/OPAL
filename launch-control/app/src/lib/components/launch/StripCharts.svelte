<script lang="ts">
	// Structure: stacked strip charts on one shared count-time axis, one channel per strip.
	import Section from '#lib/components/opal/Section.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { Frame, LaunchSim } from '#lib/launch/sim.svelte.js';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	type Win = '30' | '120' | 'FLIGHT';
	let win = $state<Win>('120');

	interface Channel {
		key: keyof Omit<Frame, 't'>;
		name: string;
		unit: string;
		digits: number;
		minSpan: number;
		zero?: boolean;
		limit?: { value: number; bad: 'above' | 'below'; label: string };
	}

	const CHANNELS: Channel[] = [
		{ key: 'alt', name: 'Altitude AGL', unit: 'm', digits: 0, minSpan: 20 },
		{ key: 'vel', name: 'Vertical velocity', unit: 'm/s', digits: 1, minSpan: 10, zero: true },
		{ key: 'acc', name: 'Acceleration', unit: 'm/s²', digits: 1, minSpan: 10, zero: true },
		{
			key: 'tilt',
			name: 'Tilt from vertical',
			unit: '°',
			digits: 1,
			minSpan: 10,
			limit: { value: 30, bad: 'above', label: '30° limit' }
		},
		{
			key: 'batt',
			name: 'FC battery',
			unit: 'V',
			digits: 2,
			minSpan: 0.5,
			limit: { value: 7.4, bad: 'below', label: '7.4 V limit' }
		},
		{
			key: 'rssi',
			name: 'RSSI',
			unit: 'dBm',
			digits: 0,
			minSpan: 10,
			limit: { value: -110, bad: 'below', label: '−110 dBm limit' }
		}
	];

	const EVENTS: [keyof typeof sim.flightTimes, string][] = [
		['BOOST', 'LIFTOFF'],
		['COAST', 'BURNOUT'],
		['DROGUE', 'APOGEE'],
		['MAIN', 'MAIN'],
		['LANDED', 'LANDED']
	];

	const H = 112;
	const M = { l: 64, r: 12, t: 6, b: 6 };
	const CH = 7.4; // mono 12px glyph width, for fitting event labels
	const ROW = 14;

	let w = $state(640);
	const pw = $derived(Math.max(100, w - M.l - M.r));

	const frames = $derived(sim.frames);
	const tMax = $derived(frames.length ? frames[frames.length - 1].t : 0);
	const flightWin = $derived(win === 'FLIGHT' && sim.firedAt !== null);
	const tMin = $derived(flightWin ? -5 : tMax - (win === '30' ? 30 : 120));
	const span = $derived(Math.max(1, tMax - tMin));
	const xOf = (t: number) => M.l + ((t - tMin) / span) * pw;

	const visible = $derived(frames.filter((f) => f.t >= tMin));
	// One point per pixel at most; the newest frame always closes the line.
	const thinned = $derived.by(() => {
		const stride = Math.max(1, Math.floor(visible.length / pw));
		if (stride === 1) return visible;
		const out = visible.filter((_, i) => i % stride === 0);
		const last = visible[visible.length - 1];
		if (last && out[out.length - 1] !== last) out.push(last);
		return out;
	});

	const xStep = $derived.by(() => {
		const want = span / Math.max(1, pw / 90);
		return [5, 10, 20, 30, 60].find((s) => s >= want) ?? 60;
	});
	const xTicks = $derived.by(() => {
		const out: number[] = [];
		for (let t = Math.ceil(tMin / xStep) * xStep; t <= tMax; t += xStep) out.push(t);
		return out;
	});
	const tickLabel = (t: number) => (t < 0 ? `T−${-t} s` : `T+${t} s`);

	function nice(lo: number, hi: number, minSpan: number): [number, number, number] {
		if (hi - lo < minSpan) {
			const mid = (hi + lo) / 2;
			lo = mid - minSpan / 2;
			hi = mid + minSpan / 2;
		}
		const raw = (hi - lo) / 3;
		const p = 10 ** Math.floor(Math.log10(raw));
		const step = ([1, 2, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
		const a = Math.floor(lo / step) * step;
		let b = Math.ceil(hi / step) * step;
		if (b <= a) b = a + step;
		return [a, b, step];
	}

	const evs = $derived(
		EVENTS.flatMap(([k, label]) => {
			const t = sim.flightTimes[k];
			return t !== undefined && t >= tMin && t <= tMax ? [{ label, t, x: xOf(t) }] : [];
		})
	);
	// Greedy rows so close events (liftoff, burnout) do not print over each other.
	const placed = $derived.by(() => {
		const ends: number[] = [];
		return evs.map((e) => {
			const width = e.label.length * CH + 4;
			const flip = e.x + 3 + width > M.l + pw + M.r;
			const x0 = flip ? e.x - 3 - width : e.x + 3;
			let row = ends.findIndex((end) => x0 > end);
			if (row < 0) row = ends.length;
			ends[row] = x0 + width;
			return { ...e, row, flip };
		});
	});
	const evRows = $derived(placed.reduce((m, e) => Math.max(m, e.row + 1), 0));

	const strips = $derived(
		CHANNELS.map((c, idx) => {
			const vals = visible.map((f) => f[c.key]);
			const cur = frames.length ? frames[frames.length - 1][c.key] : null;
			let lo = vals.length ? Math.min(...vals) : 0;
			let hi = vals.length ? Math.max(...vals) : 1;
			const dMin = lo;
			const dMax = hi;
			if (c.zero) {
				lo = Math.min(lo, 0);
				hi = Math.max(hi, 0);
			}
			const s0 = Math.max(hi - lo, c.minSpan);
			// A limit far outside the data would flatten the trace; it stays off the plot.
			const lim = c.limit && c.limit.value > lo - s0 && c.limit.value < hi + s0 ? c.limit : null;
			if (lim) {
				lo = Math.min(lo, lim.value);
				hi = Math.max(hi, lim.value);
			}
			const [a, b] = nice(lo, hi, c.minSpan);
			const top = M.t + (idx === 0 ? evRows * ROW : 0);
			const height = H + (idx === 0 ? evRows * ROW : 0);
			const y = (v: number) => height - M.b - ((v - a) / (b - a)) * (height - top - M.b);
			const points = thinned
				.map((f) => `${xOf(f.t).toFixed(1)},${y(f[c.key]).toFixed(1)}`)
				.join(' ');
			const over =
				cur !== null &&
				c.limit !== undefined &&
				(c.limit.bad === 'above' ? cur > c.limit.value : cur < c.limit.value);
			return {
				c,
				cur,
				dMin,
				dMax,
				a,
				b,
				y,
				top,
				height,
				points,
				lim,
				over,
				hasData: vals.length > 0
			};
		})
	);

	const fmt = (v: number | null, d: number) => (v === null ? '—' : v.toFixed(d));
	const stroke = $derived(sim.stale ? 'var(--quiet)' : 'var(--foreground)');
	const age = $derived((sim.packetAge / 1000).toFixed(1));
	const choices: { id: Win; label: string }[] = [
		{ id: '30', label: '30 s' },
		{ id: '120', label: '120 s' },
		{ id: 'FLIGHT', label: 'FLIGHT' }
	];
</script>

<Section title="Telemetry">
	{#snippet actions()}
		{#if sim.stale}
			<span class="mono border border-dotted border-foreground px-1.5 text-xs font-bold"
				>STALE {age} s</span
			>
		{/if}
		<span class="mono mr-2 text-xs text-quiet">{sim.packetRate} Hz</span>
		{#each choices as o (o.id)}
			<Button
				variant="outline"
				size="sm"
				class="mono aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
				aria-pressed={win === o.id}
				onclick={() => (win = o.id)}>{o.label}</Button
			>
		{/each}
	{/snippet}

	<div class="flex flex-col">
		{#each strips as s (s.c.key)}
			<div class="flex border-b border-dotted border-border">
				<div
					class="flex w-32 shrink-0 flex-col justify-center gap-0.5 px-3"
					style:height="{s.height}px"
				>
					<span class="label text-muted-foreground">{s.c.name}</span>
					<span
						class={cn(
							'mono text-lg font-semibold tabular-nums',
							sim.stale ? 'text-quiet' : s.over && 'text-error'
						)}>{fmt(s.cur, s.c.digits)}<span class="text-xs font-normal"> {s.c.unit}</span></span
					>
					{#if s.over}
						<span class={cn('mono text-xs font-bold', sim.stale ? 'text-quiet' : 'text-error')}
							>LIMIT</span
						>
					{/if}
					{#if s.hasData}
						<span class="mono text-xs text-quiet tabular-nums"
							>{fmt(s.dMin, s.c.digits)} / {fmt(s.dMax, s.c.digits)} {s.c.unit}</span
						>
					{/if}
				</div>
				<svg
					class="block min-w-0 flex-1"
					width={w}
					height={s.height}
					role="img"
					aria-label="{s.c.name} strip chart"
				>
					{#each xTicks as t (t)}
						<line
							x1={xOf(t)}
							x2={xOf(t)}
							y1={s.top}
							y2={s.height - M.b}
							stroke="var(--border)"
							stroke-width="1"
							stroke-dasharray="1 3"
						/>
					{/each}
					<line x1={M.l} x2={M.l} y1={s.top} y2={s.height - M.b} stroke="var(--border)" />
					<line
						x1={M.l}
						x2={M.l + pw}
						y1={s.height - M.b}
						y2={s.height - M.b}
						stroke="var(--border)"
					/>
					<text
						x={M.l - 6}
						y={s.top + 10}
						text-anchor="end"
						class="mono"
						font-size="12"
						fill="var(--quiet)">{+s.b.toFixed(3)} {s.c.unit}</text
					>
					<text
						x={M.l - 6}
						y={s.height - M.b - 3}
						text-anchor="end"
						class="mono"
						font-size="12"
						fill="var(--quiet)">{+s.a.toFixed(3)} {s.c.unit}</text
					>
					{#if s.c.zero && s.a < 0 && s.b > 0}
						<line
							x1={M.l}
							x2={M.l + pw}
							y1={s.y(0)}
							y2={s.y(0)}
							stroke="var(--foreground)"
							stroke-width="1"
						/>
						<text
							x={M.l - 6}
							y={s.y(0) + 4}
							text-anchor="end"
							class="mono"
							font-size="12"
							fill="var(--quiet)">0 {s.c.unit}</text
						>
					{/if}
					{#each placed as e (e.label)}
						<line
							x1={e.x}
							x2={e.x}
							y1={M.t}
							y2={s.height - M.b}
							stroke={sim.stale ? 'var(--quiet)' : 'var(--foreground)'}
							stroke-width="1"
						/>
					{/each}
					{#if s.lim}
						<line
							x1={M.l}
							x2={M.l + pw}
							y1={s.y(s.lim.value)}
							y2={s.y(s.lim.value)}
							stroke="var(--error)"
							stroke-width="1"
						/>
						<text
							x={M.l + pw - 4}
							y={s.y(s.lim.value) + (s.y(s.lim.value) - s.top < 16 ? 14 : -4)}
							text-anchor="end"
							class="mono"
							font-size="12"
							fill="var(--error)">{s.lim.label}</text
						>
					{/if}
					{#if s.hasData}
						<polyline
							points={s.points}
							fill="none"
							{stroke}
							stroke-width="1.5"
							stroke-linejoin="round"
						/>
					{/if}
					{#if s.c.key === 'alt'}
						{#each placed as e (e.label)}
							<text
								x={e.flip ? e.x - 3 : e.x + 3}
								y={M.t + e.row * ROW + 11}
								text-anchor={e.flip ? 'end' : 'start'}
								class="mono"
								font-size="12"
								fill="var(--foreground)">{e.label}</text
							>
						{/each}
					{/if}
				</svg>
			</div>
		{/each}

		<div class="flex">
			<div class="w-32 shrink-0"></div>
			<div class="min-w-0 flex-1" bind:clientWidth={w}>
				<svg class="block" width={w} height="22" role="img" aria-label="Count time axis">
					{#each xTicks as t (t)}
						<text
							x={xOf(t)}
							y="16"
							text-anchor="middle"
							class="mono"
							font-size="12"
							fill="var(--quiet)">{tickLabel(t)}</text
						>
					{/each}
				</svg>
			</div>
		</div>
	</div>
</Section>
