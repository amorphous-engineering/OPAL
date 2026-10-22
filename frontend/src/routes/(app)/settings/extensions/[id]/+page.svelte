<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		confirm,
		DataTable,
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		State,
		Timestamp,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import OnshapePanel from '#lib/components/settings/OnshapePanel.svelte';
	import type { ExtensionDetail } from '#lib/components/settings/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let ext = $derived<ExtensionDetail>(data.ext);
	const isAdmin = $derived(!!session.user?.is_admin);
	let busy = $state(false);

	async function toggle() {
		busy = true;
		try {
			ext = await api.post<ExtensionDetail>(
				`/extensions/${ext.id}/${ext.enabled ? 'disable' : 'enable'}`
			);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function uninstall() {
		const ok = await confirm({
			title: `Uninstall ${ext.id}?`,
			body: `Its files are deleted from this machine. Procedures and datasets already imported from it stay.`,
			action: 'UNINSTALL',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/extensions/${ext.id}`);
			toast.success(`Uninstalled ${ext.id}`);
			await goto('/settings/extensions');
		} catch (err) {
			toastError(err);
		}
	}

	async function importTemplate(kind: 'procedures' | 'datasets', key: string) {
		try {
			const r = await api.post<{ name: string; href: string }>(
				`/extensions/${ext.id}/import/${kind}/${key}`
			);
			toast.success(`Imported ${r.name}`, {
				action: { label: 'OPEN', onClick: () => goto(r.href) }
			});
		} catch (err) {
			toastError(err);
		}
	}

	const procedureColumns: Column<ExtensionDetail['procedures'][number]>[] = [
		{ key: 'key', label: 'Key', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'type', label: 'Type' },
		{ key: 'steps', label: 'Steps', align: 'right', mono: true },
		{ key: 'import', label: '', align: 'right' }
	];
	const datasetColumns: Column<ExtensionDetail['datasets'][number]>[] = [
		{ key: 'key', label: 'Key', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'fields', label: 'Fields', align: 'right', mono: true },
		{ key: 'import', label: '', align: 'right' }
	];
</script>

<PageHeader
	title={ext.name}
	identifier={ext.id}
	crumbs={[
		{ label: 'System' },
		{ label: 'Settings', href: '/settings' },
		{ label: 'Extensions', href: '/settings/extensions' },
		{ label: ext.id }
	]}
>
	{#snippet actions()}
		{#if isAdmin}
			<Button variant="outline" size="sm" disabled={busy} onclick={toggle}
				>{ext.enabled ? 'DISABLE' : 'ENABLE'}</Button
			>
			{#if !ext.is_bundled}
				<Button variant="destructive" size="sm" onclick={uninstall}>UNINSTALL</Button>
			{/if}
		{/if}
	{/snippet}
</PageHeader>

<div class="grid items-start gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 gap-4">
		<Section title="Extension">
			<DetailTable>
				<DetailRow label="Version" mono value={ext.version} />
				<DetailRow label="Origin"
					><span class="font-mono text-xs uppercase">{ext.origin}</span></DetailRow
				>
				<DetailRow label="State">
					{#if !ext.compatible}<State value="incompatible" tone="error" />
					{:else if ext.enabled}<State value="enabled" tone="ok" />
					{:else}<State value="disabled" tone="muted" />{/if}
				</DetailRow>
				<DetailRow label="Requires OPAL" mono value={ext.requires} />
				<DetailRow label="Summary" value={ext.summary} />
				<DetailRow label="Author" value={ext.author} />
				<DetailRow label="License" mono value={ext.license} />
				<DetailRow label="Homepage">
					{#if ext.homepage}
						<a
							class="font-mono text-xs text-info hover:underline"
							href={ext.homepage}
							target="_blank"
							rel="noopener noreferrer">{ext.homepage}</a
						>
					{:else}<span class="text-muted-foreground">—</span>{/if}
				</DetailRow>
				<DetailRow label="Registered"><Timestamp value={ext.installed_at} /></DetailRow>
				<DetailRow label="Checksum" mono value={ext.checksum} />
				<DetailRow label="Path"><span class="font-mono break-all">{ext.path}</span></DetailRow>
			</DetailTable>
		</Section>

		{#if ext.content_errors.length}
			<Section title="Content errors" count={ext.content_errors.length}>
				<ul class="divide-y divide-border">
					{#each ext.content_errors as message (message)}
						<li class="px-3 py-1.5 text-xs text-error">{message}</li>
					{/each}
				</ul>
			</Section>
		{/if}
	</div>

	<div class="grid min-w-0 gap-4">
		{#if ext.id === 'opal.onshape'}
			<OnshapePanel enabled={ext.enabled} {isAdmin} />
		{/if}

		<!-- Declared intent decides expectation: only declared capabilities appear. -->
		{#if ext.declares.procedures}
			<Section title="Procedure templates" count={ext.procedures.length}>
				<DataTable
					rows={ext.procedures}
					columns={procedureColumns}
					key={(p) => p.key}
					emptyLabel="PROCEDURE TEMPLATES"
					dense
				>
					{#snippet cell(p, col)}
						{#if col.key === 'type'}
							<span class="font-mono text-xs uppercase">{p.type}</span>
						{:else if col.key === 'import'}
							{#if isAdmin && ext.enabled}
								<Button
									size="xs"
									variant="outline"
									onclick={() => importTemplate('procedures', p.key)}>IMPORT</Button
								>
							{/if}
						{:else}
							{(p as unknown as Record<string, unknown>)[col.key]}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}
		{#if ext.declares.datasets}
			<Section title="Dataset templates" count={ext.datasets.length}>
				<DataTable
					rows={ext.datasets}
					columns={datasetColumns}
					key={(d) => d.key}
					emptyLabel="DATASET TEMPLATES"
					dense
				>
					{#snippet cell(d, col)}
						{#if col.key === 'import'}
							{#if isAdmin && ext.enabled}
								<Button
									size="xs"
									variant="outline"
									onclick={() => importTemplate('datasets', d.key)}>IMPORT</Button
								>
							{/if}
						{:else}
							{(d as unknown as Record<string, unknown>)[col.key]}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}
	</div>
</div>
