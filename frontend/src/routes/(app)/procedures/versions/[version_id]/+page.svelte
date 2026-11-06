<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import {
		DetailRow,
		DetailTable,
		MoreMenu,
		PageHeader,
		Section,
		State,
		Timestamp,
		confirm,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import Prose from '#lib/components/procedures/Prose.svelte';
	import SnapshotParts from '#lib/components/procedures/SnapshotParts.svelte';
	import SnapshotSteps from '#lib/components/procedures/SnapshotSteps.svelte';
	import { OpGraph } from '#lib/components/op-graph/index.js';
	import { snapshotGraph } from '#lib/components/procedures/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const v = $derived(data.version);
	const others = $derived(data.versions.filter((x) => x.id !== v.id));
	const showOutputs = $derived(v.procedureType === 'build' || v.snapshot.outputs.length > 0);
	const startable = $derived(v.isCurrent && v.procedureStatus === 'released');

	const graph = $derived(snapshotGraph(v.snapshot.steps));
	const graphNodes = $derived(graph.nodes);
	const graphEdges = $derived(graph.edges);
	const kitRows = $derived(v.snapshot.kit);
	const outRows = $derived(v.snapshot.outputs);
	let steps = $state<ReturnType<typeof SnapshotSteps>>();

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
			await goto(`/procedures/${v.procedureId}?edit=1`);
		} catch (e) {
			toastError(e);
		}
	}
</script>

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
		{#if v.isCurrent}<State value="released" tone="default" label="CURRENT" />{:else}<State
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
		<MoreMenu
			items={[
				{ label: 'RESTORE TO DRAFT', onselect: restore, when: v.procedureStatus !== 'obsolete' }
			]}
		/>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<div class="flex items-center justify-end gap-3 font-mono text-xs">
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground"
				onclick={() => steps?.setAll(true)}>EXPAND ALL</button
			>
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground"
				onclick={() => steps?.setAll(false)}>COLLAPSE ALL</button
			>
		</div>
		<SnapshotSteps bind:this={steps} steps={v.snapshot.steps} parts={v.parts} />
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
		<SnapshotParts title="Kit" rows={kitRows} parts={v.parts} qtyLabel="Required" />
		{#if showOutputs}<SnapshotParts
				title="Outputs"
				rows={outRows}
				parts={v.parts}
				qtyLabel="Produced"
			/>{/if}
	</div>
</div>
