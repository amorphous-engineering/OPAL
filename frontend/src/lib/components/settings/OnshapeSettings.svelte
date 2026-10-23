<script lang="ts">
	// Onshape: live state, credentials, registered documents and the sync log, all inline.
	import { onMount, untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
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
		type Column,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { api, ApiError } from '#lib/api.js';
	import SyncLogTable from './SyncLogTable.svelte';
	import type {
		OnshapeDocument,
		OnshapeSettings as OnshapeConfig,
		OnshapeStatus,
		SyncLog
	} from './types.js';

	let {
		enabled,
		isAdmin,
		settings
	}: { enabled: boolean; isAdmin: boolean; settings: OnshapeConfig | null } = $props();

	// The credentials form is seeded once from the stored settings and reseeded by each save.
	const seed = untrack(() => settings);
	let saved = $state<OnshapeConfig | null>(seed);
	let accessKey = $state(seed?.access_key ?? '');
	let secretKey = $state('');
	let clearSecret = $state(false);
	let baseUrl = $state(seed?.base_url ?? '');
	let poll = $state(String(seed?.poll_interval_minutes ?? 0));
	let webhook = $state('');
	let clearWebhook = $state(false);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let test = $state<{ ok: boolean; message: string } | null>(null);
	let testing = $state(false);
	let direction = $state('');

	async function saveSettings(e: SubmitEvent) {
		e.preventDefault();
		saving = true;
		saveError = null;
		try {
			saved = await api.put<OnshapeConfig>('/settings/onshape', {
				access_key: accessKey,
				secret_key: secretKey,
				clear_secret_key: clearSecret,
				base_url: baseUrl,
				poll_interval_minutes: Math.max(0, parseInt(poll, 10) || 0),
				webhook_secret: webhook,
				clear_webhook_secret: clearWebhook
			});
			secretKey = webhook = '';
			clearSecret = clearWebhook = false;
			toast.success('Onshape settings saved');
			await load();
			void refreshAll();
		} catch (err) {
			saveError = err instanceof ApiError ? err.message : 'Could not save';
		} finally {
			saving = false;
		}
	}

	async function runTest() {
		testing = true;
		test = null;
		try {
			test = await api.post('/settings/onshape/test');
		} catch (err) {
			toastError(err);
		} finally {
			testing = false;
		}
	}

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
			api.get<SyncLog[]>('/onshape/sync/logs', { limit: 100, direction })
		]);
	}

	function setDirection(value: string) {
		direction = value;
		load().catch(toastError);
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

<div class="grid grid-cols-1 gap-4">
	<Section title="Onshape integration">
		{#snippet actions()}
			{#if isAdmin && enabled}
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
				<span class="font-mono text-xs whitespace-pre-line"
					>{result.summary || 'Sync complete'}</span
				>
			</div>
		{/if}
	</Section>

	{#if isAdmin && enabled && saved}
		<form class="grid grid-cols-1 gap-4" onsubmit={saveSettings}>
			<ErrorBanner message={saveError} />
			<Section title="API credentials">
				{#snippet actions()}
					<Button
						variant="ghost"
						size="xs"
						disabled={testing || !saved?.configured}
						onclick={runTest}>TEST CONNECTION</Button
					>
				{/snippet}
				<div class="grid grid-cols-1 gap-3 p-3">
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="os-access">Access key</Label>
						<Input id="os-access" class="font-mono" bind:value={accessKey} autocomplete="off" />
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="os-secret">Secret key</Label>
						<Input
							id="os-secret"
							class="font-mono"
							type="password"
							bind:value={secretKey}
							autocomplete="new-password"
							placeholder={saved.has_secret_key ? 'Stored. Blank keeps it.' : ''}
						/>
						{#if saved.has_secret_key}
							<div class="flex items-center gap-2">
								<Switch id="os-clear-secret" size="sm" bind:checked={clearSecret} />
								<Label for="os-clear-secret">Clear the stored secret</Label>
							</div>
						{/if}
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="os-base">API base URL</Label>
						<Input id="os-base" class="font-mono" bind:value={baseUrl} />
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="os-poll">Poll interval (minutes)</Label>
						<Input
							id="os-poll"
							class="w-32 font-mono"
							type="number"
							min={0}
							step={1}
							bind:value={poll}
						/>
						<span class="text-xs text-muted-foreground">0 turns automatic pulls off.</span>
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label for="os-webhook">Webhook secret</Label>
						<Input
							id="os-webhook"
							class="font-mono"
							type="password"
							bind:value={webhook}
							autocomplete="new-password"
							placeholder={saved.has_webhook_secret ? 'Stored. Blank keeps it.' : 'Optional'}
						/>
						{#if saved.has_webhook_secret}
							<div class="flex items-center gap-2">
								<Switch id="os-clear-webhook" size="sm" bind:checked={clearWebhook} />
								<Label for="os-clear-webhook">Clear the stored secret</Label>
							</div>
						{/if}
					</div>
				</div>
				<div class="border-t border-border px-3 py-2">
					{#if test}
						<State
							value={test.ok ? 'ok' : 'failed'}
							tone={test.ok ? 'ok' : 'error'}
							label={test.ok ? 'CONNECTED' : 'FAILED'}
						/>
						<span class="ml-2 text-xs">{test.message}</span>
					{:else}
						<span class="font-mono text-xs text-muted-foreground"
							>{saved.configured
								? testing
									? 'Contacting Onshape'
									: 'Not tested'
								: 'No credentials saved'}</span
						>
					{/if}
				</div>
			</Section>
			<div class="flex gap-2">
				<Button type="submit" class="flex-1" disabled={saving}>SAVE</Button>
			</div>
		</form>
	{/if}

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

		<Section title="Sync log" count={logs.length}>
			{#snippet actions()}
				<NativeSelect.Root
					size="sm"
					aria-label="Direction"
					value={direction}
					onchange={(e) => setDirection(e.currentTarget.value)}
				>
					<NativeSelect.Option value="">All directions</NativeSelect.Option>
					<NativeSelect.Option value="pull">Pull</NativeSelect.Option>
					<NativeSelect.Option value="push">Push</NativeSelect.Option>
				</NativeSelect.Root>
			{/snippet}
			{#if logs.length}
				<SyncLogTable {logs} />
			{:else}
				<EmptyLine label="Sync log" empty="No sync runs." />
			{/if}
		</Section>
	{/if}
</div>
