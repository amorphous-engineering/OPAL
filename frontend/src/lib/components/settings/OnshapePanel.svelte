<script lang="ts">
	// The single home for Onshape's live state, rendered on the extension's page.
	import { onMount } from 'svelte';
	import {
		confirm,
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		State,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import SyncLogTable from './SyncLogTable.svelte';
	import type { OnshapeDocument, OnshapeStatus, SyncLog } from './types.js';

	let { enabled, isAdmin }: { enabled: boolean; isAdmin: boolean } = $props();

	let status = $state<OnshapeStatus | null>(null);
	let logs = $state<SyncLog[]>([]);
	let url = $state('');
	let docName = $state('');
	let adding = $state(false);
	let syncing = $state<'pull' | 'push' | null>(null);
	let result = $state<{ status: string; summary: string | null } | null>(null);

	async function load() {
		[status, logs] = await Promise.all([
			api.get<OnshapeStatus>('/onshape/status'),
			api.get<SyncLog[]>('/onshape/sync/logs', { limit: 10 })
		]);
	}

	onMount(() => {
		load().catch(toastError);
	});

	const documents = $derived((status?.documents ?? []) as OnshapeDocument[]);

	async function addDocument(e: SubmitEvent) {
		e.preventDefault();
		adding = true;
		try {
			const doc = await api.post<OnshapeDocument>('/onshape/documents', {
				url: url.trim(),
				name: docName.trim()
			});
			url = docName = '';
			await load();
			toast.success(`Added ${doc.name}`);
		} catch (err) {
			toastError(err);
		} finally {
			adding = false;
		}
	}

	async function removeDocument(d: OnshapeDocument) {
		const ok = await confirm({
			title: `Remove ${d.name}?`,
			body: 'It is no longer synced. Parts already linked to it stay.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/onshape/documents/${d.document_id}/${d.element_id}`);
			await load();
		} catch (err) {
			toastError(err);
		}
	}

	async function sync(direction: 'pull' | 'push') {
		syncing = direction;
		result = null;
		try {
			result = await api.post(`/onshape/sync/${direction}`);
			await load();
		} catch (err) {
			toastError(err);
		} finally {
			syncing = null;
		}
	}

	const columns: Column<OnshapeDocument>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'element_type', label: 'Type' },
		{ key: 'document_id', label: 'Document', mono: true },
		{ key: 'element_id', label: 'Element', mono: true },
		{ key: 'auto_sync', label: 'Auto sync' },
		{ key: 'actions', label: '', align: 'right' }
	];
	const tone = (s: string) => (s === 'success' ? 'ok' : s === 'partial' ? 'warn' : 'error');
</script>

<Section title="Onshape integration">
	{#snippet actions()}
		{#if isAdmin && enabled}
			<Button variant="ghost" size="xs" href="/settings/onshape/configure"
				>{status?.enabled ? 'EDIT' : 'CONFIGURE'}</Button
			>
			{#if status?.enabled}
				<Button variant="ghost" size="xs" disabled={syncing !== null} onclick={() => sync('pull')}
					>{syncing === 'pull' ? 'PULLING' : 'PULL'}</Button
				>
				<Button variant="ghost" size="xs" disabled={syncing !== null} onclick={() => sync('push')}
					>{syncing === 'push' ? 'PUSHING' : 'PUSH'}</Button
				>
			{/if}
		{/if}
	{/snippet}
	<DetailTable>
		<DetailRow label="Credentials">
			{#if status?.enabled}<State value="configured" tone="ok" label="CONFIGURED" />{:else}<span
					class="font-mono text-xs">NONE</span
				>{/if}
		</DetailRow>
		{#if enabled}
			<DetailRow label="Status">
				{#if status?.connected}<State
						value="connected"
						tone="ok"
						label="CONNECTED"
					/>{:else if status?.enabled}<State
						value="credentials_only"
						tone="warn"
						label="CREDENTIALS ONLY"
					/>{:else}<span class="font-mono text-xs">—</span>{/if}
			</DetailRow>
			<DetailRow label="Poll interval">
				{#if status?.poll_interval_minutes}<span class="font-mono text-xs"
						>{status.poll_interval_minutes} min</span
					>{:else}<span class="font-mono text-xs text-muted-foreground">DISABLED</span>{/if}
			</DetailRow>
		{:else}
			<DetailRow label="Polling"><span class="font-mono text-xs">STOPPED</span></DetailRow>
		{/if}
	</DetailTable>

	{#if result}
		<div class="flex items-start gap-2 border-t border-border px-3 py-2">
			<State
				value={result.status}
				tone={tone(result.status)}
				label={result.status === 'success' ? 'OK' : undefined}
			/>
			<span class="font-mono text-xs whitespace-pre-line">{result.summary || 'Sync complete'}</span>
		</div>
	{/if}
</Section>

{#if enabled && status?.enabled}
	<Section title="Registered documents" count={documents.length}>
		{#if documents.length}
			<DataTable
				rows={documents}
				{columns}
				key={(d) => `${d.document_id}/${d.element_id}`}
				emptyLabel="DOCUMENTS"
				dense
			>
				{#snippet cell(d, col)}
					{#if col.key === 'element_type'}
						<span class="font-mono text-xs uppercase">{d.element_type.replace('_', ' ')}</span>
					{:else if col.key === 'auto_sync'}
						{#if d.auto_sync}<State value="on" tone="ok" label="ON" />{:else}<span
								class="font-mono text-xs text-muted-foreground">OFF</span
							>{/if}
					{:else if col.key === 'actions'}
						{#if isAdmin}
							<Button
								variant="ghost"
								size="xs"
								class="text-destructive"
								onclick={() => removeDocument(d)}>REMOVE</Button
							>
						{/if}
					{:else}
						<span class="break-all">{(d as unknown as Record<string, unknown>)[col.key]}</span>
					{/if}
				{/snippet}
			</DataTable>
		{/if}
		{#if isAdmin}
			<form
				class="flex flex-wrap items-center gap-2 border-t border-border p-3"
				onsubmit={addDocument}
			>
				<Input
					bind:value={url}
					class="h-7 min-w-72 flex-1 font-mono"
					aria-label="Onshape document URL"
					placeholder="https://cad.onshape.com/documents/…/w/…/e/…"
					required
				/>
				<Input
					bind:value={docName}
					class="h-7 w-48"
					aria-label="Document name"
					placeholder="Name (from Onshape)"
				/>
				<Button type="submit" size="sm" disabled={adding || !url.trim()}>ADD DOCUMENT</Button>
			</form>
		{/if}
	</Section>

	{#if logs.length}
		<Section title="Recent sync log" count={logs.length}>
			{#snippet actions()}
				<Button variant="ghost" size="xs" href="/settings/onshape/sync-log">ALL</Button>
			{/snippet}
			<SyncLogTable {logs} />
		</Section>
	{:else}
		<EmptyLine label="Sync log" empty="No sync runs." />
	{/if}
{/if}
