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
	import { api } from '#lib/api.js';

	interface AuthSession {
		id: number;
		auth_method: string;
		created_at: string;
		last_seen_at: string | null;
		user_agent: string | null;
		ip_address: string | null;
		current: boolean;
	}

	// `version` changes whenever another section did something that affects sessions.
	let { version = 0 }: { version?: number } = $props();

	let sessions = $state<AuthSession[]>([]);
	let loaded = $state(false);

	async function load() {
		sessions = await api.get<AuthSession[]>('/auth/sessions');
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
			await api.del(`/auth/sessions/${s.id}`);
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
			const r = await api.post<{ revoked: number }>('/auth/sessions/revoke-others');
			await load();
			toast.success(`${r.revoked} session(s) signed out`);
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<AuthSession>[] = [
		{ key: 'auth_method', label: 'Method', class: 'whitespace-nowrap' },
		{ key: 'last_seen_at', label: 'Last seen', class: 'whitespace-nowrap' },
		{ key: 'user_agent', label: 'Client' },
		{ key: 'ip_address', label: 'Address', mono: true, class: 'whitespace-nowrap' },
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
			{#if col.key === 'auth_method'}
				<span class="font-mono text-xs uppercase">{s.auth_method}</span>
				{#if s.current}<State value="this" tone="info" label="THIS" class="ml-1" />{/if}
			{:else if col.key === 'last_seen_at'}
				<Timestamp value={s.last_seen_at} />
			{:else if col.key === 'user_agent'}
				<span
					class="block max-w-xs truncate text-xs text-muted-foreground"
					title={s.user_agent ?? ''}>{s.user_agent ?? '—'}</span
				>
			{:else if col.key === 'ip_address'}
				{s.ip_address ?? '—'}
			{:else if !s.current}
				<Button variant="ghost" size="xs" class="text-destructive" onclick={() => revoke(s)}
					>REVOKE</Button
				>
			{/if}
		{/snippet}
	</DataTable>
</Section>
