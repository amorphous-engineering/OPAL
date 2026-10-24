<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
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
	const showOutputs = $derived(v.procedure_type === 'build' || v.content.output_items.length > 0);
	const startable = $derived(v.is_current && data.procedureStatus === 'active');

	const topOps = $derived(groupOps(v.content.steps));
	const graphNodes = $derived<GraphNode[]>(
		[...topOps.ops, ...topOps.contingency].map((g) => ({
			id: g.op.order,
			number: g.op.step_number,
			title: g.op.title,
			kind: g.op.is_contingency ? 'contingency' : 'op'
		}))
	);
	const graphEdges = $derived<GraphEdge[]>(
		[...topOps.ops, ...topOps.contingency].flatMap((g) =>
			(g.op.depends_on ?? [])
				.filter((d) => graphNodes.some((n) => n.id === d))
				.map((d) => ({ from: d, to: g.op.order, kind: 'dependency' as const }))
		)
	);

	interface PartRow {
		part_id: number;
		quantity: number;
	}
	const kitRows = $derived<PartRow[]>(
		v.content.kit_items.map((k) => ({ part_id: k.part_id, quantity: k.quantity_required }))
	);
	const outRows = $derived<PartRow[]>(
		v.content.output_items.map((k) => ({ part_id: k.part_id, quantity: k.quantity_produced }))
	);
	const partColumns = (qtyLabel: string): Column<PartRow>[] => [
		{ key: 'pn', label: 'Part', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'quantity', label: qtyLabel, align: 'right', width: '8rem', mono: true }
	];

	async function restore() {
		const ok = await confirm({
			title: `Restore v${v.version_number} to draft?`,
			body: 'All current draft steps, kit items and outputs are replaced by this version’s snapshot. This cannot be undone.',
			action: 'RESTORE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.post(`/procedures/${v.procedure_id}/versions/${v.id}/restore`);
			toast.success(`Draft restored from v${v.version_number}`);
			await goto(`/procedures/${v.procedure_id}`);
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
				key={(r) => r.part_id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'pn'}
						<a href={`/parts/${r.part_id}`} class="text-info hover:underline"
							>{partById.get(r.part_id)?.internal_pn ?? '—'}</a
						>
					{:else if col.key === 'name'}
						{partById.get(r.part_id)?.name ?? '—'}
					{:else}
						{qty(r.quantity)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}
{/snippet}

<PageHeader
	title={v.procedure_name}
	identifier={`v${v.version_number}`}
	crumbs={[
		{ label: 'Templates', href: '/procedures' },
		{ label: v.procedure_name, href: `/procedures/${v.procedure_id}` },
		{ label: `v${v.version_number}` }
	]}
>
	{#snippet state()}
		{#if v.is_current}<State value="active" label="CURRENT" />{:else}<State
				value="deprecated"
				label="SUPERSEDED"
			/>{/if}
	{/snippet}
	{#snippet actions()}
		{#if startable}
			<Button href={`/executions/new?procedure_id=${v.procedure_id}&version_id=${v.id}`}
				>START EXECUTION</Button
			>
		{/if}
		<Button variant="outline" href={`/procedures/${v.procedure_id}/versions/${v.id}/print`}
			>PRINT TRAVELER</Button
		>
		<Button variant="outline" onclick={restore}>RESTORE TO DRAFT</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<SnapshotSteps steps={v.content.steps} />
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
					<a href={`/procedures/${v.procedure_id}`} class="text-info hover:underline"
						>{v.procedure_name}</a
					>
				</DetailRow>
				<DetailRow label="Version" value={`v${v.version_number}`} mono />
				<DetailRow label="Published"><Timestamp value={v.created_at} /></DetailRow>
				<DetailRow label="Published by" value={v.created_by_name} />
				<DetailRow label="Change note" value={v.change_note} />
				<DetailRow label="Description">
					{#if v.content.procedure_description}
						<Prose source={v.content.procedure_description} />
					{:else}—{/if}
				</DetailRow>
				<DetailRow label="Compare">
					{#if others.length}
						<span class="flex flex-wrap gap-x-3 font-mono text-xs">
							{#each others as o (o.id)}
								<a
									class="text-info hover:underline"
									href={`/procedures/${v.procedure_id}/versions/${o.id}/diff/${v.id}`}
									>v{o.version_number}</a
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
