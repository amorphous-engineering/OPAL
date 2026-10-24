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
	import { opal } from '#lib/api.js';
	import { createCredential, passkeysSupported } from '#lib/webauthn.js';
	type Passkey = Awaited<ReturnType<typeof opal.auth.passkeys.list>>['items'][number];

	// `enabled` is optional: without it the section asks the server which methods are on.
	let { enabled: given, onchanged }: { enabled?: boolean; onchanged: () => void } = $props();
	let asked = $state<boolean | undefined>(undefined);
	const enabled = $derived(given ?? asked ?? false);

	let keys = $state<Passkey[]>([]);
	let renaming = $state<number | null>(null);
	let draft = $state('');
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
		keys = (await opal.auth.passkeys.list({})).items;
		loaded = true;
	}

	onMount(async () => {
		if (given === undefined) {
			asked = (await opal.auth.config({}).catch(() => null))?.passkeysEnabled ?? false;
		}
		if (enabled) load().catch(toastError);
	});

	async function rename(k: Passkey) {
		const name = draft.trim();
		renaming = null;
		if (!name || name === k.name) return;
		try {
			await opal.auth.passkeys.rename({ id: k.id, name });
			await load();
		} catch (err) {
			toastError(err);
		}
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const options = await opal.auth.passkeys.registerBegin({ rpId: location.hostname });
			const credential = await createCredential(options);
			await opal.auth.passkeys.registerComplete({
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
			await opal.auth.passkeys.delete({ id: k.id });
			await load();
			onchanged();
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<Passkey>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'createdAt', label: 'Created', class: 'whitespace-nowrap' },
		{ key: 'lastUsedAt', label: 'Last used', class: 'whitespace-nowrap' },
		{ key: 'actions', label: '', width: '11rem', align: 'right' }
	];
</script>

{#if enabled}
	<Section title="Passkeys" count={loaded ? keys.length : undefined}>
		{#if keys.length}
			<DataTable rows={keys} {columns} emptyLabel="PASSKEYS" dense>
				{#snippet cell(k, col)}
					{#if col.key === 'name'}
						{#if renaming === k.id}
							<form
								onsubmit={(e) => {
									e.preventDefault();
									void rename(k);
								}}
							>
								<Input
									bind:value={draft}
									class="h-6 max-w-56"
									aria-label="Passkey name"
									maxlength={100}
									onblur={() => rename(k)}
								/>
							</form>
						{:else}{k.name}{/if}
					{:else if col.key === 'createdAt'}<Timestamp value={k.createdAt} dateOnly />
					{:else if col.key === 'lastUsedAt'}<Timestamp value={k.lastUsedAt} dateOnly />
					{:else}
						<Button
							variant="ghost"
							size="xs"
							onclick={() => {
								draft = k.name;
								renaming = k.id;
							}}>RENAME</Button
						>
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
