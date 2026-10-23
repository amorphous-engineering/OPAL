<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '#lib/api.js';
	import {
		PageHeader,
		Section,
		DataTable,
		DetailTable,
		DetailRow,
		EmptyLine,
		Timestamp,
		confirm,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import DatasetChart from '#lib/components/datasets/DatasetChart.svelte';
	import AddPointDialog from '#lib/components/datasets/AddPointDialog.svelte';
	import EditDatasetDialog from '#lib/components/datasets/EditDatasetDialog.svelte';
	import type { DataPoint, SchemaField } from '#lib/components/datasets/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ds = $derived(data.dataset);
	const fields = $derived(ds.schema.fields ?? []);
	const numeric = $derived(fields.filter((f) => f.type === 'number'));

	let addOpen = $state(false);
	let editOpen = $state(false);
	let chosen = $state<string | null>(null);
	const chartField = $derived<SchemaField | undefined>(
		numeric.find((f) => f.name === chosen) ?? numeric.find((f) => f.chart) ?? numeric[0]
	);

	// Newest first in the table; the chart sorts itself by time.
	const points = $derived(
		[...ds.data_points].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))
	);
	const truncated = $derived(ds.point_count > ds.data_points.length);

	const columns = $derived<Column<DataPoint>[]>([
		{ key: 'recorded_at', label: 'Recorded', width: '10rem' },
		...fields.map((f) => ({
			key: `v:${f.name}`,
			label: f.unit ? `${f.name} (${f.unit})` : f.name,
			align: f.type === 'number' ? ('right' as const) : ('left' as const),
			mono: f.type === 'number'
		})),
		{ key: 'source', label: 'Source' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	]);

	function show(v: unknown): string {
		if (v === null || v === undefined || v === '') return '';
		if (typeof v === 'boolean') return v ? 'YES' : 'NO';
		return String(v);
	}

	async function removePoint(p: DataPoint) {
		if (
			!(await confirm({
				title: 'Delete data point',
				body: 'This removes the point from the dataset and from its chart.',
				action: 'DELETE',
				destructive: true
			}))
		)
			return;
		try {
			await api.del(`/datasets/${ds.id}/points/${p.id}`);
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function removeDataset() {
		if (
			!(await confirm({
				title: `Delete ${ds.name}`,
				body: 'This deletes the dataset and all of its data points.',
				action: 'DELETE',
				destructive: true
			}))
		)
			return;
		try {
			await api.del(`/datasets/${ds.id}`);
			toast.success('Dataset deleted');
			await goto('/datasets');
		} catch (e) {
			toastError(e);
		}
	}
</script>

<PageHeader title={ds.name} crumbs={[{ label: 'Datasets', href: '/datasets' }, { label: ds.name }]}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" href={`/audit?entity=dataset&record=${ds.id}`}>AUDIT</Button>
		<Button size="sm" onclick={() => (addOpen = true)}>+ ADD POINT</Button>
		<Button variant="outline" size="sm" onclick={() => (editOpen = true)}>EDIT</Button>
		<Button variant="outline" size="sm" href={`/api/datasets/${ds.id}/export`} download
			>EXPORT CSV</Button
		>
		<Button variant="destructive" size="sm" onclick={removeDataset}>DELETE</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
		<Section title="Dataset">
			<DetailTable>
				<DetailRow label="Procedure">
					{#if ds.procedure_id}
						<a href={`/procedures/${ds.procedure_id}`} class="text-info hover:underline"
							>{ds.procedure_name}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Description">
					{#if ds.description}
						<span class="whitespace-pre-wrap">{ds.description}</span>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Created"><Timestamp value={ds.created_at} /></DetailRow>
				<DetailRow label="Updated"><Timestamp value={ds.updated_at} /></DetailRow>
			</DetailTable>
		</Section>

		<Section title="Fields" count={fields.length}>
			<DataTable
				rows={fields}
				columns={[
					{ key: 'name', label: 'Name' },
					{ key: 'type', label: 'Type', mono: true },
					{ key: 'unit', label: 'Unit', mono: true },
					{ key: 'chart', label: 'Charted', align: 'center' }
				]}
				emptyLabel="Fields"
				dense
			>
				{#snippet cell(row, col)}
					{#if col.key === 'chart'}
						{row.type === 'number' ? (row.chart ? 'YES' : 'NO') : '—'}
					{:else}
						{@const v = (row as unknown as Record<string, string | undefined>)[col.key]}
						{#if v}{v}{:else}<span class="text-muted-foreground">—</span>{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	</div>

	{#if numeric.length && chartField && points.length}
		<Section title="Chart">
			{#snippet actions()}
				{#if numeric.length > 1}
					<NativeSelect
						size="sm"
						aria-label="Chart field"
						value={chartField.name}
						onchange={(e) => (chosen = e.currentTarget.value)}
					>
						{#each numeric as f (f.name)}
							<NativeSelectOption value={f.name}
								>{f.unit ? `${f.name} (${f.unit})` : f.name}</NativeSelectOption
							>
						{/each}
					</NativeSelect>
				{:else}
					<span class="font-mono text-xs text-muted-foreground">{chartField.name}</span>
				{/if}
			{/snippet}
			<DatasetChart points={ds.data_points} field={chartField} />
		</Section>
	{/if}

	{#if points.length === 0}
		<div class="border border-border bg-card">
			<EmptyLine label="Data points" onadd={() => (addOpen = true)} />
		</div>
	{:else}
		<Section title="Data points" count={ds.point_count}>
			<DataTable rows={points} {columns} emptyLabel="Data points" key={(p) => p.id} dense>
				{#snippet cell(row, col)}
					{#if col.key === 'recorded_at'}
						<Timestamp value={row.recorded_at} />
					{:else if col.key === 'source'}
						{#if row.source}
							<a
								href={`/executions/${row.source.instance_id}`}
								class="font-mono text-xs text-info hover:underline"
								>{row.source.work_order_number ?? 'Execution'} · {row.source.step_number_str}</a
							>
							{#if row.source.step_title}
								<span class="text-muted-foreground"> {row.source.step_title}</span>
							{/if}
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'actions'}
						<Button variant="ghost" size="xs" onclick={() => removePoint(row)}>DELETE</Button>
					{:else}
						{@const v = show(row.values[col.key.slice(2)])}
						{#if v}{v}{:else}<span class="text-muted-foreground">—</span>{/if}
					{/if}
				{/snippet}
			</DataTable>
			{#if truncated}
				<p class="border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
					Latest {ds.data_points.length} of {ds.point_count}. The CSV export has all points.
				</p>
			{/if}
		</Section>
	{/if}
</div>

<AddPointDialog bind:open={addOpen} datasetId={ds.id} {fields} onadded={invalidateAll} />
<EditDatasetDialog
	bind:open={editOpen}
	dataset={ds}
	procedures={data.procedures}
	onsaved={invalidateAll}
/>
