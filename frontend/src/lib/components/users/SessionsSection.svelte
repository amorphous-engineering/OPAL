<script lang="ts">
	import { onMount } from 'svelte';
	import {
		confirm,
		DataTable,
		Section,
		State,
		Timestamp,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';

	type AuthSession = Awaited<ReturnType<typeof opal.auth.sessions.list>>['items'][number];

	// `version` changes whenever another section did something that affects sessions.
	let { version = 0 }: { version?: number } = $props();

	let sessions = $state<AuthSession[]>([]);
	let loaded = $state(false);

	async function load() {
		sessions = (await opal.auth.sessions.list({})).items;
		loaded = true;
	}

	onMount(() => {
		load().catch(toastError);
	});

	$effect(() => {
		void version;
		if (loaded) load().catch(toastError);
	});

	async function revoke(s: AuthSession) {
		try {
			await opal.auth.sessions.revoke({ id: s.id });
			await load();
		} catch (err) {
			toastError(err);
		}
	}

	async function revokeOthers() {
		const ok = await confirm({
			title: 'Sign out all other sessions?',
			body: 'Every other browser and device must sign in again.',
			action: 'SIGN OUT OTHERS',
			destructive: true
		});
		if (!ok) return;
		try {
			const r = await opal.auth.sessions.revokeOthers({});
			await load();
			toast.success(`${r.revoked} session(s) signed out`);
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<AuthSession>[] = [
		{ key: 'method', label: 'Method', class: 'whitespace-nowrap' },
		{ key: 'lastSeenAt', label: 'Last seen', class: 'whitespace-nowrap' },
		{ key: 'userAgent', label: 'Client' },
		{ key: 'ipAddress', label: 'Address', mono: true, class: 'whitespace-nowrap' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];
	const others = $derived(sessions.filter((s) => !s.current).length);
</script>

<Section title="Sessions" count={loaded ? sessions.length : undefined}>
	{#snippet actions()}
		{#if others > 0}
			<Button variant="ghost" size="xs" onclick={revokeOthers}>SIGN OUT OTHERS</Button>
		{/if}
	{/snippet}
	<DataTable rows={sessions} {columns} loading={!loaded} emptyLabel="SESSIONS" dense>
		{#snippet cell(s, col)}
			{#if col.key === 'method'}
				<span class="font-mono text-xs uppercase">{s.method}</span>
				{#if s.current}<State value="this" tone="info" label="THIS" class="ml-1" />{/if}
			{:else if col.key === 'lastSeenAt'}
				<Timestamp value={s.lastSeenAt} />
			{:else if col.key === 'userAgent'}
				<span
					class="block max-w-xs truncate text-xs text-muted-foreground"
					title={s.userAgent ?? ''}>{s.userAgent ?? '—'}</span
				>
			{:else if col.key === 'ipAddress'}
				{s.ipAddress ?? '—'}
			{:else if !s.current}
				<Button variant="ghost" size="xs" class="text-destructive" onclick={() => revoke(s)}
					>REVOKE</Button
				>
			{/if}
		{/snippet}
	</DataTable>
</Section>
