<script lang="ts">
	// The installed list, install form, and every extension's own detail, all inline.
	import { goto, refreshAll } from '$app/navigation';
	import {
		confirm,
		DataTable,
		DetailRow,
		DetailTable,
		Section,
		State,
		Timestamp,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import {
		bytes,
		type ExtensionDetail,
		type ExtensionList,
		type ExtensionSummary
	} from './types.js';

	let {
		extensions,
		details,
		isAdmin
	}: {
		extensions: ExtensionList;
		details: Record<string, ExtensionDetail | null>;
		isAdmin: boolean;
	} = $props();

	const columns: Column<ExtensionSummary>[] = [
		{ key: 'id', label: 'Extension' },
		{ key: 'version', label: 'Version', mono: true },
		{ key: 'origin', label: 'Origin' },
		{ key: 'provides', label: 'Provides' },
		{ key: 'enabled', label: 'State' }
	];

	function provides(e: ExtensionSummary): string {
		const parts = Object.entries(e.provides).map(([k, n]) => `${n} ${k}`);
		if (e.has_code) parts.unshift('integration');
		return parts.join(', ') || '—';
	}

	let files = $state<FileList | undefined>();
	let busy = $state(false);

	async function install(e: SubmitEvent) {
		e.preventDefault();
		const file = files?.[0];
		if (!file) return;
		busy = true;
		try {
			const body = new FormData();
			body.append('archive', file);
			const ext = await api.post<ExtensionDetail>('/extensions/install', body);
			toast.success(`Installed ${ext.id} ${ext.version}`);
			files = undefined;
			await refreshAll();
			await goto(`#extension-${ext.id}`);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	let toggling = $state<string | null>(null);

	async function toggle(ext: ExtensionDetail) {
		toggling = ext.id;
		try {
			await api.post(`/extensions/${ext.id}/${ext.enabled ? 'disable' : 'enable'}`);
			await refreshAll();
		} catch (err) {
			toastError(err);
		} finally {
			toggling = null;
		}
	}

	async function uninstall(ext: ExtensionDetail) {
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
			await refreshAll();
		} catch (err) {
			toastError(err);
		}
	}

	async function importTemplate(
		ext: ExtensionDetail,
		kind: 'procedures' | 'datasets',
		key: string
	) {
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

	const loaded = $derived(
		extensions.items.map((e) => details[e.id]).filter((d): d is ExtensionDetail => !!d)
	);
</script>

<div class="grid grid-cols-1 gap-4">
	<Section title="Installed" count={extensions.items.length}>
		<DataTable
			rows={extensions.items}
			{columns}
			href={(e) => `#extension-${e.id}`}
			key={(e) => e.id}
			emptyLabel="EXTENSIONS"
		>
			{#snippet cell(e, col)}
				{#if col.key === 'id'}
					<span class="font-mono text-info">{e.id}</span>
					<div class="text-xs text-muted-foreground">{e.name}</div>
				{:else if col.key === 'origin'}
					<span class="font-mono text-xs uppercase">{e.origin}</span>
				{:else if col.key === 'provides'}
					<span class="font-mono text-xs">{provides(e)}</span>
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

	{#if extensions.broken.length}
		<Section title="Unreadable" count={extensions.broken.length}>
			<DataTable
				rows={extensions.broken}
				columns={[
					{ key: 'directory', label: 'Directory', mono: true },
					{ key: 'error', label: 'Reason' }
				]}
				emptyLabel="UNREADABLE"
				dense
			>
				{#snippet cell(b, col)}
					{#if col.key === 'error'}<span class="text-error">{b.error}</span
						>{:else}{b.directory}{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}

	{#if isAdmin}
		<Section title="Install">
			<form class="flex flex-wrap items-center gap-3 p-3" onsubmit={install}>
				<Input
					class="max-w-md flex-1"
					type="file"
					accept=".zip,application/zip"
					bind:files
					aria-label="Extension archive"
					required
				/>
				<Button type="submit" size="sm" disabled={busy || !files?.length}>INSTALL</Button>
			</form>
			<DetailTable class="border-t border-border">
				<DetailRow label="Archive" mono value="ZIP with opal-ext.yaml" />
				<DetailRow label="Size limit" mono value={bytes(extensions.max_archive_bytes)} />
				<DetailRow label="Directory"
					><span class="font-mono break-all">{extensions.extension_dir}</span></DetailRow
				>
			</DetailTable>
		</Section>
	{/if}

	{#each loaded as ext (ext.id)}
		<div id={`extension-${ext.id}`} class="grid scroll-mt-4 grid-cols-1 gap-4">
			<Section title={`${ext.id} · ${ext.name}`}>
				{#snippet actions()}
					{#if isAdmin}
						<Button
							variant="ghost"
							size="xs"
							disabled={toggling === ext.id}
							onclick={() => toggle(ext)}>{ext.enabled ? 'DISABLE' : 'ENABLE'}</Button
						>
						{#if !ext.is_bundled}
							<Button
								variant="ghost"
								size="xs"
								class="text-destructive"
								onclick={() => uninstall(ext)}>UNINSTALL</Button
							>
						{/if}
					{/if}
				{/snippet}
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
					<DetailRow label="Checksum"
						><span class="font-mono break-all">{ext.checksum ?? '—'}</span></DetailRow
					>
					<DetailRow label="Path"><span class="font-mono break-all">{ext.path}</span></DetailRow>
				</DetailTable>
			</Section>

			{#if ext.content_errors.length}
				<Section title={`${ext.id} content errors`} count={ext.content_errors.length}>
					<ul class="divide-y divide-border">
						{#each ext.content_errors as message (message)}
							<li class="px-3 py-1.5 text-xs text-error">{message}</li>
						{/each}
					</ul>
				</Section>
			{/if}

			<!-- Declared intent decides expectation: only declared capabilities appear. -->
			{#if ext.declares.procedures}
				<Section title={`${ext.id} procedure templates`} count={ext.procedures.length}>
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
										onclick={() => importTemplate(ext, 'procedures', p.key)}>IMPORT</Button
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
				<Section title={`${ext.id} dataset templates`} count={ext.datasets.length}>
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
										onclick={() => importTemplate(ext, 'datasets', d.key)}>IMPORT</Button
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
	{/each}
</div>
