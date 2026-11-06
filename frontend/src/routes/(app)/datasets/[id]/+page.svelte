<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { opal } from '#lib/api.js';
	import {
		ActionLink,
		PageHeader,
		Section,
		DataTable,
		DetailTable,
		DetailRow,
		EditToggle,
		EmptyLine,
		ErrorBanner,
		MoreMenu,
		Timestamp,
		askReason,
		confirm,
		isEditing,
		toast,
		toastError,
		setQuery,
		State,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte';
	import ProjectRow from '#lib/components/projects/ProjectRow.svelte'; // added by projects
	import DatasetChart from '#lib/components/datasets/DatasetChart.svelte';
	import ImportPointsDialog from '#lib/components/datasets/ImportPointsDialog.svelte';
	import AddPointDialog from '#lib/components/datasets/AddPointDialog.svelte';
	import type { DataPoint } from '#lib/components/datasets/types.js';
	import { opUrl, contracts, specResult, specText, unitSymbol } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const ds = $derived(data.dataset);
	const fields = $derived(ds.schema.fields);
	const numeric = $derived(fields.filter((f) => f.type === 'number'));

	let addOpen = $state(false);
	let importOpen = $state(false);
	const archived = $derived(ds.state === 'archived');
	const editing = $derived(isEditing(page.url) && !archived);

	let name = $state('');
	let description = $state('');
	let procedure = $state('');
	let projectId = $state(0);
	let busy = $state(false);
	let error = $state<string | null>(null);
	$effect(() => {
		if (editing) {
			name = ds.name;
			description = ds.description ?? '';
			procedure = ds.procedureId ? String(ds.procedureId) : '';
			projectId = ds.projectId;
			error = null;
		}
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await opal.datasets.update({
				id: ds.id,
				projectId,
				name: name.trim(),
				description: description.trim() || null,
				procedureId: procedure ? Number(procedure) : null
			});
			await invalidateAll();
			await goto(page.url.pathname);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			busy = false;
		}
	}
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
		{ key: 'actions', label: '', width: '11rem', align: 'right' }
	]);

	const byName = $derived(new Map(fields.map((f) => [f.name, f])));
	const chartSpec = $derived(fields.find((f) => f.name === data.field)?.spec);

	function show(v: unknown): string {
		if (v === null || v === undefined || v === '') return '';
		if (typeof v === 'boolean') return v ? 'YES' : 'NO';
		return String(v);
	}

	/** A captured point is never removed: it is struck, with a reason, and stays on the page. */
	async function strikePoint(p: DataPoint) {
		const reason = await askReason({
			title: 'Strike data point',
			body: 'The point stays listed, struck, and no longer counts in the chart or the export.',
			action: 'STRIKE',
			destructive: true
		});
		if (reason === null) return;
		try {
			await opal.datasets.points.strike({ id: ds.id, pointId: p.id, reason });
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
			<EditToggle />
		{/if}
		<Button variant="outline" size="sm" href={exportHref} download={`dataset-${ds.id}.csv`}
			>EXPORT CSV</Button
		>
		<MoreMenu
			items={[
				{
					label: ds.pointCount > 0 ? 'ARCHIVE' : 'DELETE',
					onselect: removeDataset,
					strike: true,
					when: !archived
				}
			]}
		/>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
		<Section title="Dataset">
			{#if editing}
				<form class="grid grid-cols-1 gap-3 p-3" onsubmit={save}>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="ed-project">Project</Label>
						<ProjectSelect
							id="ed-project"
							bind:value={projectId}
							keep={ds.projectId}
							class="w-full"
						/>
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="ed-name">Name</Label>
						<Input id="ed-name" bind:value={name} required maxlength={255} />
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="ed-desc">Description</Label>
						<Textarea id="ed-desc" bind:value={description} rows={3} />
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="ed-proc">Procedure</Label>
						<NativeSelect id="ed-proc" bind:value={procedure} class="w-full">
							<NativeSelectOption value="">None</NativeSelectOption>
							{#each data.procedures as p (p.id)}
								<NativeSelectOption value={String(p.id)}>{p.name}</NativeSelectOption>
							{/each}
						</NativeSelect>
					</div>
					<ErrorBanner message={error} />
					<div class="flex gap-2">
						<Button type="submit" size="sm" disabled={busy || !name.trim() || !projectId}
							>SAVE</Button
						>
					</div>
				</form>
			{:else}
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
						{:else}<span class="text-quiet">—</span>{/if}
					</DetailRow>
					<DetailRow label="Description">
						{#if ds.description}
							<span class="whitespace-pre-wrap">{ds.description}</span>
						{:else}<span class="text-quiet">—</span>{/if}
					</DetailRow>
					<DetailRow label="Created"><Timestamp value={ds.createdAt} /></DetailRow>
					<DetailRow label="Updated"><Timestamp value={ds.updatedAt} /></DetailRow>
					{#if archived && ds.archivedAt}
						<DetailRow label="Archived"><Timestamp value={ds.archivedAt} /></DetailRow>
					{/if}
				</DetailTable>
			{/if}
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
						{#if row.unit}{unitSymbol(row.unit)}{:else}<span class="text-quiet">—</span>{/if}
					{:else if col.key === 'spec'}
						{#if row.spec}{specText(row.spec, row.unit)}
						{:else if row.min !== undefined || row.max !== undefined}{row.min ?? ''} … {row.max ??
								''}{:else}<span class="text-quiet">—</span>{/if}
					{:else}
						{@const v = (row as unknown as Record<string, string | undefined>)[col.key]}
						{#if v}{v}{:else}<span class="text-quiet">—</span>{/if}
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
			<DataTable
				rows={points}
				{columns}
				emptyLabel="Data points"
				key={(p) => p.id}
				rowClass={(p) => (p.struck ? 'text-muted-foreground' : undefined)}
				dense
			>
				{#snippet cell(row, col)}
					{#if col.key === 'recordedAt'}
						<span class={row.struck ? 'line-through' : undefined}
							><Timestamp value={row.recordedAt} /></span
						>
					{:else if col.key === 'source'}
						{#if row.stepExecutionId !== null}
							<span class="font-mono text-xs">Execution step</span>
						{:else}<span class="text-quiet">—</span>{/if}
					{:else if col.key === 'actions'}
						{#if row.struck}
							<span class="font-mono text-xs" title={row.struck.reason}
								>STRUCK <Timestamp value={row.struck.at} /> · {row.struck.reason}</span
							>
						{:else if !archived}<ActionLink onclick={() => strikePoint(row)}>STRIKE</ActionLink
							>{/if}
					{:else}
						{@const name = col.key.slice(2)}
						{@const f = byName.get(name)}
						{@const v = show(row.values[name])}
						{#if v}
							<span class={row.struck ? 'line-through' : undefined}>{v}</span
							>{#if f?.type === 'number' && f.unit}<span class="ml-1 text-muted-foreground"
									>{unitSymbol(f.unit)}</span
								>{/if}
							{#if !row.struck && f?.spec && specResult(f.spec, row.values[name]) === 'out_of_spec'}
								<Badge
									variant="outline"
									class="ml-2 border-error-fill bg-error-fill font-mono tracking-wider text-error-on dark:bg-error-fill"
									>OUT OF SPEC</Badge
								>
							{/if}
						{:else}<span class="text-quiet">—</span>{/if}
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
