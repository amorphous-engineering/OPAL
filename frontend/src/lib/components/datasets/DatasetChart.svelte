<script lang="ts">
	// One numeric field over time: a single 2px line with point markers. A single
	// series needs no legend; the section title and the field picker name it.
	import { LineChart, Spline, Points, Rule } from 'layerchart';
	import { specLimits, specResult, specText, unitSymbol, type Spec } from '@opal/shared';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import { datetime, toDate } from '#lib/format.js';
	import type { Chart as ChartData } from './types.js';

	let { chart, spec }: { chart: ChartData; spec?: Spec } = $props();

	const rows = $derived(
		chart.series
			.map((p) => ({ at: toDate(p.recordedAt) ?? new Date(NaN), value: p.value }))
			.filter((r): r is { at: Date; value: number } => r.value !== null)
	);

	// Spec limits are reference lines; a reference spec has a nominal line and no limits.
	const limits = $derived(spec ? specLimits(spec) : null);
	const lower = $derived(limits?.lower != null ? Number(limits.lower) : null);
	const upper = $derived(limits?.upper != null ? Number(limits.upper) : null);
	const nominal = $derived(
		spec && (spec.kind === 'nominal' || spec.kind === 'reference') ? Number(spec.nominal) : null
	);
	const out = $derived(rows.filter((r) => specResult(spec, r.value) === 'out_of_spec'));
	// The domain holds every limit, so a line never falls off the chart.
	const yDomain = $derived.by(() => {
		const all = [...rows.map((r) => r.value), lower, upper, nominal].filter(
			(v): v is number => v !== null && Number.isFinite(v)
		);
		const lo = Math.min(...all);
		const hi = Math.max(...all);
		const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
		return [lo - pad, hi + pad] as [number, number];
	});

	// Points logged within one day need seconds to tell the ticks apart.
	const span = $derived(
		rows.length ? Math.max(...rows.map((r) => +r.at)) - Math.min(...rows.map((r) => +r.at)) : 0
	);
	const withSeconds = (v: Date) => `${datetime(v)}:${String(v.getSeconds()).padStart(2, '0')}`;
	const tick = (v: Date) => (span < 86_400_000 ? withSeconds(v) : datetime(v));

	const symbol = $derived(unitSymbol(chart.unit));
	const label = $derived(symbol ? `${chart.field} (${symbol})` : chart.field);
	const config = $derived({
		value: { label, color: 'var(--chart-1)' }
	}) satisfies Chart.ChartConfig;
</script>

{#if rows.length === 0}
	<p class="px-3 py-6 font-mono text-xs text-muted-foreground">
		{chart.field} — no numeric values recorded
	</p>
{:else}
	<Chart.Container {config} class="aspect-auto h-72 w-full justify-start pt-3 pr-8 pb-1 pl-3">
		<LineChart
			data={rows}
			x="at"
			series={[{ key: 'value', label, color: 'var(--color-value)' }]}
			{yDomain}
			props={{
				spline: { strokeWidth: 2 },
				xAxis: { ticks: 6, format: tick },
				yAxis: { ticks: 5 }
			}}
		>
			{#snippet marks()}
				<Spline seriesKey="value" strokeWidth={2} />
				{#each [lower, upper] as limit, i (i)}
					{#if limit !== null}
						<Rule
							y={limit}
							style="stroke: var(--error); stroke-width: 1.5px; stroke-opacity: 0.8"
						/>
					{/if}
				{/each}
				{#if nominal !== null}
					<Rule
						y={nominal}
						style="stroke: var(--muted-foreground); stroke-width: 1px; stroke-dasharray: 4 3"
					/>
				{/if}
				<Points data={rows} x="at" y="value" r={4} fill="var(--color-value)" />
				<Points data={out} x="at" y="value" r={5} fill="var(--error)" stroke="var(--background)" />
			{/snippet}
			{#snippet tooltip()}
				<Chart.Tooltip labelFormatter={withSeconds} />
			{/snippet}
		</LineChart>
	</Chart.Container>
	{#if spec}
		<p class="border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
			Spec {specText(spec, chart.unit)}{#if out.length}
				<span class="ml-3 text-error">{out.length} OUT OF SPEC</span>{/if}
		</p>
	{/if}
{/if}
