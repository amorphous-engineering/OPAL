<script lang="ts">
	// DETAILS tab: the template's description, kit and outputs, and versions.
	// Executions and issues live in the right column.
	import { DetailRow, DetailTable, Section, Timestamp } from '#lib/components/opal/index.js';
	import PartLines from './PartLines.svelte';
	import Prose from './Prose.svelte';
	import VersionsSection from './VersionsSection.svelte';
	import type { TemplateData } from './template-data.js';

	let { data, onchange }: { data: TemplateData; onchange: () => void | Promise<void> } = $props();

	const p = $derived(data.procedure);
	const showOutputs = $derived(p.procedure_type === 'build' || data.outputs.length > 0);
</script>

<div class="grid grid-cols-1 gap-3">
	<Section title="Details">
		<DetailTable>
			<DetailRow label="Created"><Timestamp value={p.created_at} /></DetailRow>
			<DetailRow label="Updated"><Timestamp value={p.updated_at} /></DetailRow>
			<DetailRow label="Description">
				{#if p.description}
					<Prose source={p.description} />
				{:else}—{/if}
			</DetailRow>
		</DetailTable>
	</Section>

	<PartLines kind="kit" procedureId={p.id} lines={data.kit} {onchange} />
	{#if showOutputs}
		<PartLines kind="outputs" procedureId={p.id} lines={data.outputs} {onchange} />
	{/if}

	<VersionsSection
		procedureId={p.id}
		versions={data.versions}
		currentVersionId={p.current_version_id}
	/>
</div>
