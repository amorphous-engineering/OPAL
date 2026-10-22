<script lang="ts">
	import { goto } from '$app/navigation';
	import { PageHeader } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { api, ApiError } from '#lib/api.js';
	import type { UserRecord } from '#lib/components/users/types.js';

	let name = $state('');
	let username = $state('');
	let email = $state('');
	let password = $state('');
	let isAdmin = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const created = await api.post<UserRecord>('/users', {
				name: name.trim(),
				username: username.trim() || null,
				email: email.trim() || null,
				password: password || null,
				is_admin: isAdmin
			});
			// No password means the owner has to claim the account: hand the admin
			// the claim link straight away instead of making them hunt for it.
			await goto(`/users/${created.id}${password ? '' : '?claim=1'}`);
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not create the user';
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New user"
	crumbs={[{ label: 'System' }, { label: 'Users', href: '/users' }, { label: 'New' }]}
/>

<form class="max-w-xl border-b border-border p-4" onsubmit={submit}>
	{#if error}
		<p
			role="alert"
			class="mb-3 border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
		>
			{error}
		</p>
	{/if}
	<div class="grid gap-4">
		<div class="grid gap-1.5">
			<Label for="name">Name</Label>
			<Input id="name" bind:value={name} maxlength={255} required autocomplete="off" />
		</div>
		<div class="grid gap-1.5">
			<Label for="username">Username</Label>
			<Input
				id="username"
				class="font-mono"
				bind:value={username}
				maxlength={64}
				autocapitalize="none"
				autocomplete="off"
				placeholder="From email or name when blank"
			/>
		</div>
		<div class="grid gap-1.5">
			<Label for="email">Email</Label>
			<Input id="email" type="email" bind:value={email} maxlength={255} autocomplete="off" />
		</div>
		<div class="grid gap-1.5">
			<Label for="password">Initial password</Label>
			<Input
				id="password"
				type="password"
				bind:value={password}
				minlength={10}
				autocomplete="new-password"
				placeholder="Blank: the owner claims the account by link"
			/>
		</div>
		<div class="flex items-center gap-2">
			<Switch id="is-admin" bind:checked={isAdmin} />
			<Label for="is-admin">Administrator</Label>
		</div>
	</div>
	<div class="mt-5 flex gap-2">
		<Button type="submit" disabled={busy || !name.trim()}>CREATE USER</Button>
		<Button variant="outline" href="/users">CANCEL</Button>
	</div>
</form>
