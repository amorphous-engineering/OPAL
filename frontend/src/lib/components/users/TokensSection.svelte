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
	import { opal } from '#lib/api.js';
	import CopyField from './CopyField.svelte';

	type ApiToken = Awaited<ReturnType<typeof opal.auth.tokens.list>>['items'][number];

	let tokens = $state<ApiToken[]>([]);
	let loaded = $state(false);
	let name = $state('');
	let days = $state('');
	let busy = $state(false);
	/** The raw token, shown once, right after creation. */
	let revealed = $state<{ name: string; token: string; expiresAt: string | null } | null>(null);

	async function load() {
		tokens = (await opal.auth.tokens.list({})).items;
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
			revealed = await opal.auth.tokens.create({
				name: name.trim(),
				expiresInDays: ttl > 0 ? ttl : undefined
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
			await opal.auth.tokens.revoke({ id: t.id });
			await load();
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<ApiToken>[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'createdAt', label: 'Created', class: 'whitespace-nowrap' },
		{ key: 'lastUsedAt', label: 'Last used', class: 'whitespace-nowrap' },
		{ key: 'expiresAt', label: 'Expires', class: 'whitespace-nowrap' },
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
					{#if revealed.expiresAt}Expires <Timestamp value={revealed.expiresAt} />{:else}Never
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
				{:else if col.key === 'createdAt'}<Timestamp value={t.createdAt} dateOnly />
				{:else if col.key === 'lastUsedAt'}<Timestamp value={t.lastUsedAt} dateOnly />
				{:else if col.key === 'expiresAt'}
					{#if t.expiresAt}<Timestamp value={t.expiresAt} dateOnly />{:else}<span
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
