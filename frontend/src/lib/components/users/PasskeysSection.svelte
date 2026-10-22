<script lang="ts">
	import { onMount } from 'svelte';
	import {
		confirm,
		DataTable,
		Section,
		Timestamp,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import { createCredential, passkeysSupported } from '#lib/webauthn.js';

	interface Passkey {
		id: number;
		name: string;
		created_at: string;
		last_used_at: string | null;
	}

	let { enabled, onchanged }: { enabled: boolean; onchanged: () => void } = $props();

	let keys = $state<Passkey[]>([]);
	let loaded = $state(false);
	let label = $state('');
	let busy = $state(false);

	// Browsers only expose WebAuthn on HTTPS or localhost, and never for a bare IP address.
	const usable = $derived(
		enabled &&
			typeof window !== 'undefined' &&
			window.isSecureContext &&
			!/^[\d.]+$|:/.test(window.location.hostname) &&
			passkeysSupported()
	);

	async function load() {
		keys = await api.get<Passkey[]>('/auth/passkeys');
		loaded = true;
	}

	onMount(() => {
		if (enabled) load().catch(toastError);
	});

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const options = await api.post<{ publicKey: Record<string, unknown> }>(
				'/auth/passkey/register/begin'
			);
			const credential = await createCredential(options);
			await api.post('/auth/passkey/register/complete', {
				name: label.trim() || 'Passkey',
				credential
			});
			label = '';
			await load();
			onchanged();
			toast.success('Passkey registered');
		} catch (err) {
			// Dismissing the browser prompt is not an error worth reporting.
			if (!(err instanceof DOMException && err.name === 'NotAllowedError')) toastError(err);
		} finally {
			busy = false;
		}
	}

	async function remove(k: Passkey) {
		const ok = await confirm({
			title: `Remove passkey "${k.name}"?`,
			body: 'That device can no longer sign in with it.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/auth/passkeys/${k.id}`);
			await load();
			onchanged();
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<Passkey>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'created_at', label: 'Created', class: 'whitespace-nowrap' },
		{ key: 'last_used_at', label: 'Last used', class: 'whitespace-nowrap' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];
</script>

{#if enabled}
	<Section title="Passkeys" count={loaded ? keys.length : undefined}>
		{#if keys.length}
			<DataTable rows={keys} {columns} emptyLabel="PASSKEYS" dense>
				{#snippet cell(k, col)}
					{#if col.key === 'name'}{k.name}
					{:else if col.key === 'created_at'}<Timestamp value={k.created_at} dateOnly />
					{:else if col.key === 'last_used_at'}<Timestamp value={k.last_used_at} dateOnly />
					{:else}
						<Button variant="ghost" size="xs" class="text-destructive" onclick={() => remove(k)}
							>REMOVE</Button
						>
					{/if}
				{/snippet}
			</DataTable>
		{/if}
		{#if usable}
			<form class="flex items-center gap-2 border-t border-border p-3" onsubmit={add}>
				<Input
					bind:value={label}
					class="h-7 max-w-56"
					aria-label="Passkey name"
					placeholder="Name, e.g. shop laptop"
					maxlength={100}
				/>
				<Button type="submit" size="sm" disabled={busy}>ADD PASSKEY</Button>
			</form>
		{:else}
			<p class="border-t border-border px-3 py-2 font-mono text-xs text-muted-foreground">
				Registering needs HTTPS or the hostname localhost.
			</p>
		{/if}
	</Section>
{/if}
