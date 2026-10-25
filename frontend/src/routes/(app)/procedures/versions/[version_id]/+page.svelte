<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp,
		confirm,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import Prose from '#lib/components/procedures/Prose.svelte';
	import SnapshotSteps from '#lib/components/procedures/SnapshotSteps.svelte';
	import { OpGraph } from '#lib/components/op-graph/index.js';
	import type { GraphEdge, GraphNode } from '#lib/components/op-graph/index.js';
	import { groupOps } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const v = $derived(data.version);
	const partById = $derived(new Map(v.parts.map((p) => [p.id, p])));
	const others = $derived(data.versions.filter((x) => x.id !== v.id));
	const showOutputs = $derived(v.procedureType === 'build' || v.snapshot.outputs.length > 0);
	const startable = $derived(v.isCurrent && v.procedureStatus === 'released');

	const topOps = $derived(groupOps(v.snapshot.steps));
	const graphNodes = $derived<GraphNode[]>(
		[...topOps.ops, ...topOps.contingency].map((g) => ({
			id: g.op.id,
			number: g.op.number,
			title: g.op.title,
			kind: g.op.isContingency ? 'contingency' : 'op'
		}))
	);
	const graphEdges = $derived<GraphEdge[]>(
		[...topOps.ops, ...topOps.contingency].flatMap((g) =>
			g.op.dependsOn
				.filter((d) => graphNodes.some((n) => n.id === d))
				.map((d) => ({ from: d, to: g.op.id, kind: 'dependency' as const }))
		)
	);

	interface PartRow {
		partId: number;
		quantity: string;
	}
	const kitRows = $derived<PartRow[]>(v.snapshot.kit);
	const outRows = $derived<PartRow[]>(v.snapshot.outputs);
	const partColumns = (qtyLabel: string): Column<PartRow>[] => [
		{ key: 'pn', label: 'PN', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'quantity', label: qtyLabel, align: 'right', width: '8rem', mono: true }
	];

	async function restore() {
		const ok = await confirm({
			title: `Restore v${v.versionNumber} to draft?`,
			body: 'All current draft steps, kit items and outputs are replaced by this version’s snapshot. This cannot be undone.',
			action: 'RESTORE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.procedures.versions.restore({ id: v.procedureId, versionId: v.id });
			toast.success(`Draft restored from v${v.versionNumber}`);
			await goto(`/procedures/${v.procedureId}`);
		} catch (e) {
			toastError(e);
		}
	}
</script>

{#snippet partTable(title: string, rows: PartRow[], qtyLabel: string)}
	{#if rows.length === 0}
		<EmptyLine label={title} />
	{:else}
		<Section {title} count={rows.length}>
			<DataTable
				{rows}
				columns={partColumns(qtyLabel)}
				emptyLabel={title}
				dense
				key={(r) => r.partId}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'pn'}
						<a href={`/parts/${r.partId}`} class="text-info hover:underline"
							>{partById.get(r.partId)?.internalPn ?? '—'}</a
						>
					{:else if col.key === 'name'}
						{partById.get(r.partId)?.name ?? '—'}
					{:else}
						{qty(r.quantity)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
{/snippet}

<PageHeader
	title={v.procedureName}
	identifier={`v${v.versionNumber}`}
	crumbs={[
		{ label: 'Templates', href: '/procedures' },
		{ label: v.procedureName, href: `/procedures/${v.procedureId}` },
		{ label: `v${v.versionNumber}` }
	]}
>
	{#snippet state()}
		{#if v.isCurrent}<State value="released" tone="ok" label="CURRENT" />{:else}<State
				value="obsolete"
				tone="muted"
				label="SUPERSEDED"
			/>{/if}
	{/snippet}
	{#snippet actions()}
		{#if startable}
			<Button href={`/executions/new?procedure_id=${v.procedureId}&version_id=${v.id}`}
				>START EXECUTION</Button
			>
		{/if}
		<Button variant="outline" href={`/procedures/${v.procedureId}/versions/${v.id}/print`}
			>PRINT TRAVELER</Button
		>
		<Button variant="outline" onclick={restore}>RESTORE TO DRAFT</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<SnapshotSteps steps={v.snapshot.steps} parts={v.parts} />
		{#if graphNodes.length > 1}
			<Section title="Dependencies" count={graphEdges.length}>
				<OpGraph nodes={graphNodes} edges={graphEdges} class="h-[360px] w-full" />
			</Section>
		{/if}
	</div>
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<Section title="Details">
			<DetailTable>
				<DetailRow label="Template">
					<a href={`/procedures/${v.procedureId}`} class="text-info hover:underline"
						>{v.procedureName}</a
					>
				</DetailRow>
				<DetailRow label="Project">
					<a
						href={`/projects/${v.snapshot.procedure.projectId}`}
						class="font-mono text-info hover:underline">{v.projectCode}</a
					>
				</DetailRow>
				<DetailRow label="Version" value={`v${v.versionNumber}`} mono />
				<DetailRow label="Published"><Timestamp value={v.createdAt} /></DetailRow>
				<DetailRow label="Published by" value={v.createdByName} />
				<DetailRow label="Change note" value={v.changeNote} />
				<DetailRow label="Description">
					{#if v.snapshot.procedure.description}
						<Prose source={v.snapshot.procedure.description} />
					{:else}—{/if}
				</DetailRow>
				<DetailRow label="Compare">
					{#if others.length}
						<span class="flex flex-wrap gap-x-3 font-mono text-xs">
							{#each others as o (o.id)}
								<a
									class="text-info hover:underline"
									href={`/procedures/${v.procedureId}/versions/${o.id}/diff/${v.id}`}
									>v{o.versionNumber}</a
								>
							{/each}
						</span>
					{:else}—{/if}
				</DetailRow>
			</DetailTable>
		</Section>
		{@render partTable('Kit', kitRows, 'Required')}
		{#if showOutputs}{@render partTable('Outputs', outRows, 'Produced')}{/if}
	</div>
</div>
