<script lang="ts">
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ProjectConfig, Tier } from './types.js';

	let { project, isAdmin }: { project: ProjectConfig | null; isAdmin: boolean } = $props();

	const columns: Column<Tier>[] = [
		{ key: 'level', label: 'Level', mono: true, width: '4rem' },
		{ key: 'name', label: 'Name' },
		{ key: 'code', label: 'Code', mono: true },
		{ key: 'default_tracking', label: 'Tracking' },
		{ key: 'require_lot', label: 'Lot' },
		{ key: 'auto_serial', label: 'Serial' },
		{ key: 'description', label: 'Description' }
	];

	const customFields = $derived(Object.entries(project?.custom_fields ?? {}));
	const flag = (v: boolean | null) => (v ? 'REQUIRED' : '—');
</script>

{#if project}
	<Section title="Project">
		{#snippet actions()}
			{#if isAdmin}<Button variant="ghost" size="xs" href="/project/edit">EDIT</Button>{/if}
		{/snippet}
		<DetailTable>
			<DetailRow label="Name" value={project.name} />
			<DetailRow label="Description" value={project.description} />
			<DetailRow label="Number format" mono value={project.part_numbering.format} />
			<DetailRow label="Prefix" mono value={project.part_numbering.prefix} />
			<DetailRow
				label="Separator"
				mono
				value={project.part_numbering.separator === ''
					? '(none)'
					: project.part_numbering.separator}
			/>
			<DetailRow label="Sequence digits" mono value={project.part_numbering.sequence_digits} />
			<DetailRow label="Categories">
				{#if project.categories.length}
					<span class="font-mono text-xs">{project.categories.join(' · ')}</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
			{#each customFields as [key, value] (key)}
				<DetailRow label={key} value={String(value)} />
			{/each}
		</DetailTable>
		<div class="border-t border-border">
			<DataTable rows={project.tiers} {columns} emptyLabel="TIERS" key={(t) => t.level} dense>
				{#snippet cell(t, col)}
					{#if col.key === 'default_tracking'}
						<span class="font-mono text-xs uppercase">{t.default_tracking ?? '—'}</span>
					{:else if col.key === 'require_lot'}
						<span class="font-mono text-xs">{flag(t.require_lot)}</span>
					{:else if col.key === 'auto_serial'}
						<span class="font-mono text-xs">{t.auto_serial ? 'AUTO' : '—'}</span>
					{:else if col.key === 'description'}
						{#if t.description}{t.description}{:else}<span class="text-muted-foreground">—</span
							>{/if}
					{:else}
						{(t as unknown as Record<string, unknown>)[col.key]}
					{/if}
				{/snippet}
			</DataTable>
		</div>
	</Section>
{:else}
	<div class="border border-border bg-card">
		{#if isAdmin}
			<EmptyLine label="Project" addHref="/project/new" addLabel="+ CONFIGURE" />
		{:else}
			<EmptyLine label="Project" />
		{/if}
	</div>
{/if}
