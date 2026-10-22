<script lang="ts">
	// One numeric field over time: a single 2px line with point markers. A single
	// series needs no legend; the section title and the field picker name it.
	import { LineChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import { datetime } from '#lib/format.js';
	import type { DataPoint, SchemaField } from './types.js';

	let { points, field }: { points: DataPoint[]; field: SchemaField } = $props();

	const rows = $derived(
		points
			.map((p) => ({ at: new Date(p.recorded_at), value: p.values[field.name] }))
			.filter((r): r is { at: Date; value: number } => typeof r.value === 'number')
			.sort((a, b) => a.at.getTime() - b.at.getTime())
	);

	const label = $derived(field.unit ? `${field.name} (${field.unit})` : field.name);
	const config = $derived({
		value: { label, color: 'var(--chart-1)' }
	}) satisfies Chart.ChartConfig;
</script>

{#if rows.length === 0}
	<p class="px-3 py-6 font-mono text-xs text-muted-foreground">
		{field.name} — no numeric values recorded
	</p>
{:else}
	<Chart.Container {config} class="aspect-auto h-72 w-full justify-start px-3 pt-3 pb-1">
		<LineChart
			data={rows}
			x="at"
			series={[{ key: 'value', label, color: 'var(--color-value)' }]}
			points={{ r: 4 }}
			props={{
				spline: { strokeWidth: 2 },
				xAxis: { ticks: 6 },
				yAxis: { ticks: 5 }
			}}
		>
			{#snippet tooltip()}
				<Chart.Tooltip labelFormatter={(v: Date) => datetime(v)} />
			{/snippet}
		</LineChart>
	</Chart.Container>
{/if}
