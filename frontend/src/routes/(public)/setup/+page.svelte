<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { session, getSignInConfig, landingFor, type CurrentUser } from '#lib/session.svelte.js';

	let name = $state('');
	let email = $state('');
	let username = $state('');
	let password = $state('');
	let confirmPw = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	onMount(async () => {
		const config = await getSignInConfig();
		if (!config.needs_setup) goto('/login', { replace: true });
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (password !== confirmPw) {
			error = 'Passwords do not match';
			return;
		}
		busy = true;
		try {
			const r = await api.post<{ user: CurrentUser }>('/auth/setup', {
				name,
				email,
				username,
				password
			});
			session.set(r.user);
			await goto(landingFor(r.user, null), { replace: true });
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Setup failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>First-run setup · OPAL</title></svelte:head>

<h1 class="text-base font-semibold">First administrator</h1>
<p class="mb-4 text-xs text-muted-foreground">This account administers the instance.</p>

{#if error}
	<p role="alert" class="mb-3 border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
		{error}
	</p>
{/if}

<form class="grid gap-3" onsubmit={submit}>
	<div class="grid gap-1.5">
		<Label for="name">Name</Label><Input id="name" bind:value={name} autocomplete="name" required />
	</div>
	<div class="grid gap-1.5">
		<Label for="email">Email</Label><Input
			id="email"
			type="email"
			bind:value={email}
			autocomplete="email"
		/>
	</div>
	<div class="grid gap-1.5">
		<Label for="username">Username</Label>
		<Input
			id="username"
			bind:value={username}
			autocomplete="username"
			autocapitalize="none"
			required
		/>
	</div>
	<div class="grid gap-1.5">
		<Label for="password">Password</Label>
		<Input
			id="password"
			type="password"
			bind:value={password}
			autocomplete="new-password"
			required
		/>
	</div>
	<div class="grid gap-1.5">
		<Label for="confirm">Confirm password</Label>
		<Input
			id="confirm"
			type="password"
			bind:value={confirmPw}
			autocomplete="new-password"
			required
		/>
	</div>
	<Button type="submit" disabled={busy}>CREATE ADMINISTRATOR</Button>
</form>
