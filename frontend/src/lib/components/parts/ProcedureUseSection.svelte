<script lang="ts">
	// Procedures that name this part in a kit, a step kit or as an output. Always rendered: a part
	// no procedure uses is information.
	import { DataTable, EmptyLine, Section, State, type Column } from '#lib/components/opal/index.js';
	import { qtyUnit, stateLabel } from '#lib/format.js';
	import type { PartProcedureUse } from '@opal/shared';

	let { uses }: { uses: PartProcedureUse[] } = $props();

	const columns: Column<PartProcedureUse>[] = [
		{ key: 'template', label: 'Template', width: '8rem', mono: true },
		{ key: 'name', label: 'Procedure' },
		{ key: 'step', label: 'Step' },
		{ key: 'role', label: 'Role', width: '7rem' },
		{ key: 'qty', label: 'Qty', width: '8rem', align: 'right', mono: true },
		{ key: 'status', label: 'Status', width: '7rem' }
	];
</script>

{#if uses.length}
	<Section title="Procedure use" count={uses.length}>
		<DataTable
			rows={uses}
			{columns}
			key={(u) => `${u.procedureId}-${u.role}-${u.stepTitle ?? ''}`}
			href={(u) => `/procedures/${u.procedureId}`}
			emptyLabel="PROCEDURE USE"
		>
			{#snippet cell(u, col)}
				{#if col.key === 'template'}
					<a href={`/procedures/${u.procedureId}`} class="text-info hover:underline"
						>{u.templateNumber}</a
					>
				{:else if col.key === 'name'}
					{u.procedureName}
				{:else if col.key === 'step'}
					{#if u.stepTitle}{u.stepTitle}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'role'}
					<span class="font-mono text-xs text-muted-foreground">{stateLabel(u.role)}</span>
				{:else if col.key === 'qty'}
					{qtyUnit(u.quantity, u.unitOfMeasure)}
				{:else}
					<State value={u.procedureStatus} />
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{:else}
	<EmptyLine label="PROCEDURE USE" empty="Not used in any procedure." />
{/if}
