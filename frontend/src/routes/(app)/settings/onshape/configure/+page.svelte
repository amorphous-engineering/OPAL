<script lang="ts">
	import { untrack } from 'svelte';
	import { goto, refreshAll } from '$app/navigation';
	import { PageHeader, Section, State, toast, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { api, ApiError } from '#lib/api.js';
	import type { OnshapeSettings } from '#lib/components/settings/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const seed = untrack(() => data.settings);

	let saved = $state<OnshapeSettings>(seed);
	let accessKey = $state(seed.access_key);
	let secretKey = $state('');
	let clearSecret = $state(false);
	let baseUrl = $state(seed.base_url);
	let poll = $state(String(seed.poll_interval_minutes));
	let webhook = $state('');
	let clearWebhook = $state(false);

	let busy = $state(false);
	let error = $state<string | null>(null);
	let test = $state<{ ok: boolean; message: string } | null>(null);
	let testing = $state(false);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			saved = await api.put<OnshapeSettings>('/settings/onshape', {
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
			await refreshAll();
			await goto('/settings/extensions/opal.onshape');
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not save';
		} finally {
			busy = false;
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
</script>

<PageHeader
	title="Onshape credentials"
	crumbs={[
		{ label: 'System' },
		{ label: 'Settings', href: '/settings' },
		{ label: 'Extensions', href: '/settings/extensions' },
		{ label: 'opal.onshape', href: '/settings/extensions/opal.onshape' },
		{ label: 'Credentials' }
	]}
/>

<div class="grid items-start gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
	<form class="grid min-w-0 gap-4" onsubmit={save}>
		{#if error}
			<p role="alert" class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
				{error}
			</p>
		{/if}
		<Section title="API credentials">
			<div class="grid gap-3 p-3">
				<div class="grid gap-1.5">
					<Label for="access">Access key</Label>
					<Input id="access" class="font-mono" bind:value={accessKey} autocomplete="off" />
				</div>
				<div class="grid gap-1.5">
					<Label for="secret">Secret key</Label>
					<Input
						id="secret"
						class="font-mono"
						type="password"
						bind:value={secretKey}
						autocomplete="new-password"
						placeholder={saved.has_secret_key ? 'Stored. Blank keeps it.' : ''}
					/>
					{#if saved.has_secret_key}
						<div class="flex items-center gap-2">
							<Switch id="clear-secret" size="sm" bind:checked={clearSecret} />
							<Label for="clear-secret">Clear the stored secret</Label>
						</div>
					{/if}
				</div>
				<div class="grid gap-1.5">
					<Label for="base">API base URL</Label>
					<Input id="base" class="font-mono" bind:value={baseUrl} />
				</div>
				<div class="grid gap-1.5">
					<Label for="poll">Poll interval (minutes)</Label>
					<Input
						id="poll"
						class="w-32 font-mono"
						type="number"
						min={0}
						step={1}
						bind:value={poll}
					/>
					<span class="text-[11px] text-muted-foreground">0 turns automatic pulls off.</span>
				</div>
				<div class="grid gap-1.5">
					<Label for="webhook">Webhook secret</Label>
					<Input
						id="webhook"
						class="font-mono"
						type="password"
						bind:value={webhook}
						autocomplete="new-password"
						placeholder={saved.has_webhook_secret ? 'Stored. Blank keeps it.' : 'Optional'}
					/>
					{#if saved.has_webhook_secret}
						<div class="flex items-center gap-2">
							<Switch id="clear-webhook" size="sm" bind:checked={clearWebhook} />
							<Label for="clear-webhook">Clear the stored secret</Label>
						</div>
					{/if}
				</div>
			</div>
		</Section>
		<div class="flex gap-2">
			<Button type="submit" disabled={busy}>SAVE</Button>
			<Button variant="outline" href="/settings/extensions/opal.onshape">CANCEL</Button>
		</div>
	</form>

	<Section title="Connection">
		{#snippet actions()}
			<Button variant="ghost" size="xs" disabled={testing || !saved.configured} onclick={runTest}
				>TEST CONNECTION</Button
			>
		{/snippet}
		<div class="px-3 py-2">
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
</div>
