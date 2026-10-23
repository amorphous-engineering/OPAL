<script lang="ts">
	import { onMount } from 'svelte';
	import {
		confirm,
		DataTable,
		Section,
		Timestamp,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import CopyField from './CopyField.svelte';

	interface ApiToken {
		id: number;
		name: string;
		created_at: string;
		last_used_at: string | null;
		expires_at: string | null;
	}

	let tokens = $state<ApiToken[]>([]);
	let loaded = $state(false);
	let name = $state('');
	let days = $state('');
	let busy = $state(false);
	/** The raw token, shown once, right after creation. */
	let revealed = $state<{ name: string; token: string; expires_at: string | null } | null>(null);

	async function load() {
		tokens = await api.get<ApiToken[]>('/auth/tokens');
		loaded = true;
	}

	onMount(() => {
		load().catch(toastError);
	});

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const ttl = parseInt(days, 10);
			revealed = await api.post('/auth/tokens', {
				name: name.trim(),
				expires_in_days: ttl > 0 ? ttl : null
			});
			name = days = '';
			await load();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function revoke(t: ApiToken) {
		const ok = await confirm({
			title: `Revoke token "${t.name}"?`,
			body: 'Clients using it stop working immediately.',
			action: 'REVOKE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/auth/tokens/${t.id}`);
			await load();
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<ApiToken>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'created_at', label: 'Created', class: 'whitespace-nowrap' },
		{ key: 'last_used_at', label: 'Last used', class: 'whitespace-nowrap' },
		{ key: 'expires_at', label: 'Expires', class: 'whitespace-nowrap' },
		{ key: 'actions', label: '', width: '5rem', align: 'right' }
	];
</script>

<Section title="API tokens" count={loaded ? tokens.length : undefined}>
	{#if revealed}
		<div class="grid grid-cols-1 gap-2 border-b border-border bg-warn-muted p-3">
			<div class="text-xs">
				<span class="font-medium">{revealed.name}</span>
				<span class="text-muted-foreground">
					is shown once. Send it as <code class="font-mono">Authorization: Bearer</code>.</span
				>
			</div>
			<CopyField value={revealed.token} label="API token" />
			<div class="flex items-center gap-3 text-xs text-muted-foreground">
				<span>
					{#if revealed.expires_at}Expires <Timestamp value={revealed.expires_at} />{:else}Never
						expires{/if}
				</span>
				<Button variant="outline" size="xs" onclick={() => (revealed = null)}>DONE</Button>
			</div>
		</div>
	{/if}
	{#if tokens.length}
		<DataTable rows={tokens} {columns} emptyLabel="API TOKENS" dense>
			{#snippet cell(t, col)}
				{#if col.key === 'name'}{t.name}
				{:else if col.key === 'created_at'}<Timestamp value={t.created_at} dateOnly />
				{:else if col.key === 'last_used_at'}<Timestamp value={t.last_used_at} dateOnly />
				{:else if col.key === 'expires_at'}
					{#if t.expires_at}<Timestamp value={t.expires_at} dateOnly />{:else}<span
							class="font-mono text-xs text-muted-foreground">NEVER</span
						>{/if}
				{:else}
					<Button variant="ghost" size="xs" class="text-destructive" onclick={() => revoke(t)}
						>REVOKE</Button
					>
				{/if}
			{/snippet}
		</DataTable>
	{/if}
	<form class="flex flex-wrap items-center gap-2 border-t border-border p-3" onsubmit={create}>
		<Input
			bind:value={name}
			class="h-7 max-w-56"
			aria-label="Token name"
			placeholder="Name, e.g. workshop TUI"
			maxlength={100}
			required
		/>
		<Input
			bind:value={days}
			type="number"
			min={1}
			max={3650}
			class="h-7 w-32"
			aria-label="Expires in days"
			placeholder="Days (optional)"
		/>
		<Button type="submit" size="sm" disabled={busy || !name.trim()}>CREATE TOKEN</Button>
	</form>
</Section>
