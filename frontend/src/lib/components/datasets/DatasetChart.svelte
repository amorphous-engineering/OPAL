<script lang="ts">
	// One numeric field over time: a single 2px line with point markers. A single
	// series needs no legend; the section title and the field picker name it.
	import { LineChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import { datetime, toDate } from '#lib/format.js';
	import type { Chart as ChartData } from './types.js';

	let { chart }: { chart: ChartData } = $props();

	const rows = $derived(
		chart.series
			.map((p) => ({ at: toDate(p.recordedAt) ?? new Date(NaN), value: p.value }))
			.filter((r): r is { at: Date; value: number } => r.value !== null)
	);

	// Points logged within one day need seconds to tell the ticks apart.
	const span = $derived(
		rows.length ? Math.max(...rows.map((r) => +r.at)) - Math.min(...rows.map((r) => +r.at)) : 0
	);
	const withSeconds = (v: Date) => `${datetime(v)}:${String(v.getSeconds()).padStart(2, '0')}`;
	const tick = (v: Date) => (span < 86_400_000 ? withSeconds(v) : datetime(v));

	const label = $derived(chart.unit ? `${chart.field} (${chart.unit})` : chart.field);
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
			points={{ r: 4 }}
			props={{
				spline: { strokeWidth: 2 },
				xAxis: { ticks: 6, format: tick },
				yAxis: { ticks: 5 }
			}}
		>
			{#snippet tooltip()}
				<Chart.Tooltip labelFormatter={withSeconds} />
			{/snippet}
		</LineChart>
	</Chart.Container>
{/if}
