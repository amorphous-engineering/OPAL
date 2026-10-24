<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { DataTable, EmptyLine, Section, State, Timestamp } from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import type { VersionRow } from './types.js';

	let {
		procedureId,
		versions,
		currentVersionId
	}: { procedureId: number; versions: VersionRow[]; currentVersionId: number | null } = $props();

	const columns: Column<VersionRow>[] = [
		{ key: 'versionNumber', label: 'Version', width: '10rem', mono: true },
		{ key: 'createdAt', label: 'Published', width: '10rem' },
		{ key: 'createdByName', label: 'By', width: '9rem' },
		{ key: 'stepCount', label: 'Steps', align: 'right', width: '5rem', mono: true },
		{ key: 'changeNote', label: 'Change note' },
		{ key: 'actions', label: '', width: '9rem', align: 'right' }
	];

	let a = $state('');
	let b = $state('');
	$effect(() => {
		// Default comparison: previous → current.
		if (versions.length >= 2 && !a) {
			a = String(versions[1].id);
			b = String(versions[0].id);
		}
	});

	function previous(v: VersionRow): VersionRow | undefined {
		return versions.find((x) => x.versionNumber === v.versionNumber - 1);
	}
</script>

{#if versions.length === 0}
	<EmptyLine label="Versions" />
{:else}
	<Section title="Versions" count={versions.length}>
		<DataTable
			rows={versions}
			{columns}
			emptyLabel="Versions"
			dense
			key={(v) => v.id}
			href={(v) => `/procedures/versions/${v.id}`}
		>
			{#snippet cell(v, col)}
				{#if col.key === 'versionNumber'}
					<span class="text-info">v{v.versionNumber}</span>
					{#if v.id === currentVersionId}<State
							value="released"
							tone="ok"
							label="CURRENT"
							class="ml-2"
						/>{/if}
				{:else if col.key === 'createdAt'}
					<Timestamp value={v.createdAt} />
				{:else if col.key === 'createdByName'}
					{v.createdByName ?? '—'}
				{:else if col.key === 'changeNote'}
					{#if v.changeNote}<span class="line-clamp-2">{v.changeNote}</span>{:else}<span
							class="text-muted-foreground">—</span
						>{/if}
				{:else if col.key === 'actions'}
					<span class="font-mono text-xs whitespace-nowrap">
						{#if previous(v)}
							<a
								class="text-info hover:underline"
								href={`/procedures/${procedureId}/versions/${previous(v)?.id}/diff/${v.id}`}>DIFF</a
							>
							<span class="text-muted-foreground">·</span>
						{/if}
						<a
							class="text-info hover:underline"
							href={`/procedures/${procedureId}/versions/${v.id}/print`}>PRINT</a
						>
					</span>
				{:else if col.key === 'stepCount'}
					{v.stepCount}
				{/if}
			{/snippet}
		</DataTable>
		{#if versions.length >= 2}
			<form
				class="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1.5"
				onsubmit={(e) => {
					e.preventDefault();
					if (a && b && a !== b) goto(`/procedures/${procedureId}/versions/${a}/diff/${b}`);
				}}
			>
				<span class="label">Compare</span>
				<NativeSelect bind:value={a} size="sm" aria-label="From version" class="w-24">
					{#each versions as v (v.id)}
						<NativeSelectOption value={String(v.id)}>v{v.versionNumber}</NativeSelectOption>
					{/each}
				</NativeSelect>
				<span class="font-mono text-xs text-muted-foreground">→</span>
				<NativeSelect bind:value={b} size="sm" aria-label="To version" class="w-24">
					{#each versions as v (v.id)}
						<NativeSelectOption value={String(v.id)}>v{v.versionNumber}</NativeSelectOption>
					{/each}
				</NativeSelect>
				<Button type="submit" size="xs" variant="outline" disabled={!a || !b || a === b}
					>COMPARE</Button
				>
			</form>
		{/if}
	</Section>
{/if}
