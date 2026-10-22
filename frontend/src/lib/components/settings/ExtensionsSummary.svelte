<script lang="ts">
	import { DataTable, Section, State, type Column } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { ExtensionSummary } from './types.js';

	let { items }: { items: ExtensionSummary[] } = $props();

	const columns: Column<ExtensionSummary>[] = [
		{ key: 'id', label: 'Extension', mono: true },
		{ key: 'version', label: 'Version', mono: true },
		{ key: 'origin', label: 'Origin' },
		{ key: 'enabled', label: 'State' }
	];
</script>

<Section title="Extensions" count={items.length}>
	{#snippet actions()}
		<Button variant="ghost" size="xs" href="/settings/extensions">MANAGE</Button>
	{/snippet}
	<DataTable
		rows={items}
		{columns}
		href={(e) => `/settings/extensions/${e.id}`}
		key={(e) => e.id}
		emptyLabel="EXTENSIONS"
		dense
	>
		{#snippet cell(e, col)}
			{#if col.key === 'origin'}
				<span class="font-mono text-xs uppercase">{e.origin}</span>
			{:else if col.key === 'enabled'}
				{#if !e.compatible}<State value="incompatible" tone="error" />
				{:else if e.enabled}<State value="enabled" tone="ok" />
				{:else}<State value="disabled" tone="muted" />{/if}
			{:else}
				{(e as unknown as Record<string, unknown>)[col.key]}
			{/if}
		{/snippet}
	</DataTable>
</Section>
