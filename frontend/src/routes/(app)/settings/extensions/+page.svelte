<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		State,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import {
		bytes,
		type ExtensionDetail,
		type ExtensionSummary
	} from '#lib/components/settings/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const isAdmin = $derived(!!session.user?.is_admin);

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
			await goto(`/settings/extensions/${ext.id}`);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
			void refreshAll();
		}
	}
</script>

<PageHeader
	title="Extensions"
	crumbs={[{ label: 'System' }, { label: 'Settings', href: '/settings' }, { label: 'Extensions' }]}
/>

<div class="grid items-start gap-4 p-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="grid min-w-0 grid-cols-1 gap-4">
		<Section title="Installed" count={data.extensions.items.length}>
			<DataTable
				rows={data.extensions.items}
				{columns}
				href={(e) => `/settings/extensions/${e.id}`}
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

		{#if data.extensions.broken.length}
			<Section title="Unreadable" count={data.extensions.broken.length}>
				<DataTable
					rows={data.extensions.broken}
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
	</div>

	<div class="grid min-w-0 grid-cols-1 gap-4">
		{#if isAdmin}
			<Section title="Install">
				<form class="grid gap-3 p-3" onsubmit={install}>
					<Input
						type="file"
						accept=".zip,application/zip"
						bind:files
						aria-label="Extension archive"
						required
					/>
					<div>
						<Button type="submit" size="sm" disabled={busy || !files?.length}>INSTALL</Button>
					</div>
				</form>
				<DetailTable class="border-t border-border">
					<DetailRow label="Archive" mono value="ZIP with opal-ext.yaml" />
					<DetailRow label="Size limit" mono value={bytes(data.extensions.max_archive_bytes)} />
					<DetailRow label="Directory"
						><span class="font-mono break-all">{data.extensions.extension_dir}</span></DetailRow
					>
				</DetailTable>
			</Section>
		{/if}
	</div>
</div>
