<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { opal } from '#lib/api.js';
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
		setQuery,
		State,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import ProjectRow from '#lib/components/projects/ProjectRow.svelte'; // added by projects
	import DatasetChart from '#lib/components/datasets/DatasetChart.svelte';
	import ImportPointsDialog from '#lib/components/datasets/ImportPointsDialog.svelte';
	import AddPointDialog from '#lib/components/datasets/AddPointDialog.svelte';
	import EditDatasetDialog from '#lib/components/datasets/EditDatasetDialog.svelte';
	import type { DataPoint } from '#lib/components/datasets/types.js';
	import { opUrl, contracts, specResult, specText, unitSymbol } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ds = $derived(data.dataset);
	const fields = $derived(ds.schema.fields);
	const numeric = $derived(fields.filter((f) => f.type === 'number'));

	let addOpen = $state(false);
	let editOpen = $state(false);
	let importOpen = $state(false);
	const archived = $derived(ds.state === 'archived');
	const procedureName = $derived(
		data.procedures.find((p) => p.id === ds.procedureId)?.name ?? `Procedure ${ds.procedureId}`
	);

	// Newest first, as the server returns them.
	const points = $derived(data.points.items);
	const truncated = $derived(ds.pointCount > points.length);
	const exportHref = $derived(opUrl(contracts.datasets.exportCsv, { id: ds.id }));

	const columns = $derived<Column<DataPoint>[]>([
		{ key: 'recordedAt', label: 'Recorded', width: '10rem' },
		...fields.map((f) => ({
			key: `v:${f.name}`,
			label: f.unit ? `${f.name} (${unitSymbol(f.unit)})` : f.name,
			align: f.type === 'number' ? ('right' as const) : ('left' as const),
			mono: f.type === 'number'
		})),
		{ key: 'source', label: 'Source' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	]);

	const byName = $derived(new Map(fields.map((f) => [f.name, f])));
	const chartSpec = $derived(fields.find((f) => f.name === data.field)?.spec);

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
			await opal.datasets.points.remove({ id: ds.id, pointId: p.id });
			await invalidateAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function removeDataset() {
		const archive = ds.pointCount > 0;
		if (
			!(await confirm({
				title: `${archive ? 'Archive' : 'Delete'} ${ds.name}`,
				body: archive
					? 'An archived dataset keeps its points and takes no new ones. This cannot be undone.'
					: 'This deletes the dataset.',
				action: archive ? 'ARCHIVE' : 'DELETE',
				destructive: true
			}))
		)
			return;
		try {
			if (archive) {
				await opal.datasets.archive({ id: ds.id });
				toast.success('Dataset archived');
				await invalidateAll();
			} else {
				await opal.datasets.delete({ id: ds.id });
				toast.success('Dataset deleted');
				await goto('/datasets');
			}
		} catch (e) {
			toastError(e);
		}
	}
</script>

<PageHeader title={ds.name} crumbs={[{ label: 'Datasets', href: '/datasets' }, { label: ds.name }]}>
	{#snippet actions()}
		<Button size="sm" variant="ghost" href={`/audit?entity=dataset&record=${ds.id}`}>AUDIT</Button>
		{#if !archived}
			<Button size="sm" onclick={() => (addOpen = true)}>+ ADD POINT</Button>
			<Button variant="outline" size="sm" onclick={() => (importOpen = true)}>IMPORT CSV</Button>
			<Button variant="outline" size="sm" onclick={() => (editOpen = true)}>EDIT</Button>
		{/if}
		<Button variant="outline" size="sm" href={exportHref} download={`dataset-${ds.id}.csv`}
			>EXPORT CSV</Button
		>
		{#if !archived}
			<Button variant="destructive" size="sm" onclick={removeDataset}
				>{ds.pointCount > 0 ? 'ARCHIVE' : 'DELETE'}</Button
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
		<Section title="Dataset">
			<DetailTable>
				<ProjectRow id={ds.projectId} code={ds.projectCode} name={ds.projectName} />
				<!-- added by projects -->
				<DetailRow label="State"
					>{#if archived}<State value="archived" tone="warn" badge />{:else}<span
							class="font-mono text-xs text-muted-foreground">ACTIVE</span
						>{/if}</DetailRow
				>
				<DetailRow label="Procedure">
					{#if ds.procedureId}
						<a href={`/procedures/${ds.procedureId}`} class="text-info hover:underline"
							>{procedureName}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Description">
					{#if ds.description}
						<span class="whitespace-pre-wrap">{ds.description}</span>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Created"><Timestamp value={ds.createdAt} /></DetailRow>
				<DetailRow label="Updated"><Timestamp value={ds.updatedAt} /></DetailRow>
				{#if archived && ds.archivedAt}
					<DetailRow label="Archived"><Timestamp value={ds.archivedAt} /></DetailRow>
				{/if}
			</DetailTable>
		</Section>

		<Section title="Fields" count={fields.length}>
			<DataTable
				rows={fields}
				columns={[
					{ key: 'name', label: 'Name' },
					{ key: 'type', label: 'Type', mono: true },
					{ key: 'unit', label: 'Unit', mono: true },
					{ key: 'spec', label: 'Spec', mono: true },
					{ key: 'chart', label: 'Charted', align: 'center' }
				]}
				emptyLabel="Fields"
				dense
			>
				{#snippet cell(row, col)}
					{#if col.key === 'chart'}
						{row.type === 'number' ? (row.chart ? 'YES' : 'NO') : '—'}
					{:else if col.key === 'unit'}
						{#if row.unit}{unitSymbol(row.unit)}{:else}<span class="text-muted-foreground">—</span
							>{/if}
					{:else if col.key === 'spec'}
						{#if row.spec}{specText(row.spec, row.unit)}
						{:else if row.min !== undefined || row.max !== undefined}{row.min ?? ''} … {row.max ??
								''}{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else}
						{@const v = (row as unknown as Record<string, string | undefined>)[col.key]}
						{#if v}{v}{:else}<span class="text-muted-foreground">—</span>{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	</div>

	{#if data.chart && data.field}
		<Section title="Chart">
			{#snippet actions()}
				{#if numeric.length > 1}
					<NativeSelect
						size="sm"
						aria-label="Chart field"
						value={data.field}
						onchange={(e) => setQuery({ field: e.currentTarget.value })}
					>
						{#each numeric as f (f.name)}
							<NativeSelectOption value={f.name}
								>{f.unit ? `${f.name} (${unitSymbol(f.unit)})` : f.name}</NativeSelectOption
							>
						{/each}
					</NativeSelect>
				{:else}
					<span class="font-mono text-xs text-muted-foreground">{data.field}</span>
				{/if}
			{/snippet}
			<DatasetChart chart={data.chart} spec={chartSpec} />
		</Section>
	{/if}

	{#if points.length === 0}
		<EmptyLine label="Data points" onadd={archived ? undefined : () => (addOpen = true)} />
	{:else}
		<Section title="Data points" count={ds.pointCount}>
			<DataTable rows={points} {columns} emptyLabel="Data points" key={(p) => p.id} dense>
				{#snippet cell(row, col)}
					{#if col.key === 'recordedAt'}
						<Timestamp value={row.recordedAt} />
					{:else if col.key === 'source'}
						{#if row.stepExecutionId !== null}
							<span class="font-mono text-xs">Execution step</span>
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'actions'}
						{#if !archived}<Button variant="ghost" size="xs" onclick={() => removePoint(row)}
								>DELETE</Button
							>{/if}
					{:else}
						{@const name = col.key.slice(2)}
						{@const f = byName.get(name)}
						{@const v = show(row.values[name])}
						{#if v}
							{v}{#if f?.type === 'number' && f.unit}<span class="ml-1 text-muted-foreground"
									>{unitSymbol(f.unit)}</span
								>{/if}
							{#if f?.spec && specResult(f.spec, row.values[name]) === 'out_of_spec'}
								<Badge
									variant="outline"
									class="ml-2 border-error/50 bg-error-muted font-mono tracking-wider text-error"
									>OUT OF SPEC</Badge
								>
							{/if}
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{/if}
				{/snippet}
			</DataTable>
			{#if truncated}
				<p class="border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
					Latest {points.length} of {ds.pointCount}. The CSV export has all points.
				</p>
			{/if}
		</Section>
	{/if}
</div>

<AddPointDialog bind:open={addOpen} datasetId={ds.id} {fields} onadded={invalidateAll} />
<ImportPointsDialog bind:open={importOpen} datasetId={ds.id} onimported={invalidateAll} />
<EditDatasetDialog
	bind:open={editOpen}
	dataset={ds}
	procedures={data.procedures}
	onsaved={invalidateAll}
/>
