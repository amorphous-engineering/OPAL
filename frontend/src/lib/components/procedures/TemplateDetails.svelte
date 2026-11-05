<script lang="ts">
	// DETAILS tab: the template's description, kit and outputs, and versions.
	// Executions and issues live in the right column. Reading a released template shows what the
	// release says; the draft's own lines show in edit mode, or when nothing was ever released.
	import { DetailRow, DetailTable, Section, Timestamp } from '#lib/components/opal/index.js';
	import PartLines from './PartLines.svelte';
	import Prose from './Prose.svelte';
	import SnapshotParts from './SnapshotParts.svelte';
	import VersionsSection from './VersionsSection.svelte';
	import type { TemplateData } from './template-data.js';

	let {
		data,
		editing,
		onchange
	}: { data: TemplateData; editing: boolean; onchange: () => void | Promise<void> } = $props();

	const p = $derived(data.procedure);
	const release = $derived(!editing ? data.current : null);
	const description = $derived(release ? release.snapshot.procedure.description : p.description);
	const showOutputs = $derived(
		p.procedureType === 'build' ||
			(release ? release.snapshot.outputs.length > 0 : data.outputs.length > 0)
	);
</script>

<div class="grid grid-cols-1 gap-3">
	<Section title="Details">
		<DetailTable>
			<DetailRow label="Created"><Timestamp value={p.createdAt} /></DetailRow>
			<DetailRow label="Updated"><Timestamp value={p.updatedAt} /></DetailRow>
			<DetailRow label="Description">
				{#if description}
					<Prose source={description} />
				{:else}—{/if}
			</DetailRow>
		</DetailTable>
	</Section>

	{#if release}
		<SnapshotParts
			title="Kit"
			rows={release.snapshot.kit}
			parts={release.parts}
			qtyLabel="Required"
		/>
		{#if showOutputs}
			<SnapshotParts
				title="Outputs"
				rows={release.snapshot.outputs}
				parts={release.parts}
				qtyLabel="Produced"
			/>
		{/if}
	{:else}
		<PartLines kind="kit" procedureId={p.id} lines={data.kit} editable={editing} {onchange} />
		{#if showOutputs}
			<PartLines
				kind="outputs"
				procedureId={p.id}
				lines={data.outputs}
				editable={editing}
				{onchange}
			/>
		{/if}
	{/if}

	<VersionsSection
		procedureId={p.id}
		versions={data.versions}
		currentVersionId={p.currentVersionId}
	/>
</div>
