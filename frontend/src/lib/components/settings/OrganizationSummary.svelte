<script lang="ts">
	import {
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		type Column
	} from '#lib/components/opal/index.js';
	import type { OrgSettings, Tier } from './types.js';

	let { organization }: { organization: OrgSettings | null } = $props();

	const columns: Column<Tier>[] = [
		{ key: 'level', label: 'Level', mono: true, width: '4rem' },
		{ key: 'name', label: 'Name' },
		{ key: 'code', label: 'Code', mono: true },
		{ key: 'defaultTracking', label: 'Tracking' },
		{ key: 'requireLot', label: 'Lot' },
		{ key: 'autoSerial', label: 'Serial' },
		{ key: 'description', label: 'Description' }
	];

	const customFields = $derived(Object.entries(organization?.customFields ?? {}));
	const flag = (v: boolean) => (v ? 'REQUIRED' : '—');
</script>

{#if organization}
	<Section title="Organization">
		<DetailTable>
			<DetailRow label="Name" value={organization.name} />
			<DetailRow label="Description" value={organization.description} />
			<DetailRow label="Number format" mono value={organization.partNumbering.format} />
			<DetailRow label="Prefix" mono value={organization.partNumbering.prefix} />
			<DetailRow
				label="Separator"
				mono
				value={organization.partNumbering.separator === ''
					? '(none)'
					: organization.partNumbering.separator}
			/>
			<DetailRow label="Sequence digits" mono value={organization.partNumbering.sequenceDigits} />
			<DetailRow label="Categories">
				{#if organization.categories.length}
					<span class="font-mono text-xs">{organization.categories.join(' · ')}</span>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			</DetailRow>
			{#each customFields as [key, value] (key)}
				<DetailRow label={key} value={String(value)} />
			{/each}
		</DetailTable>
		<div class="border-t border-border">
			<DataTable rows={organization.tiers} {columns} emptyLabel="TIERS" key={(t) => t.level} dense>
				{#snippet cell(t, col)}
					{#if col.key === 'defaultTracking'}
						<span class="font-mono text-xs uppercase">{t.defaultTracking}</span>
					{:else if col.key === 'requireLot'}
						<span class="font-mono text-xs">{flag(t.requireLot)}</span>
					{:else if col.key === 'autoSerial'}
						<span class="font-mono text-xs">{t.autoSerial ? 'AUTO' : '—'}</span>
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
	<EmptyLine label="Organization" />
{/if}
