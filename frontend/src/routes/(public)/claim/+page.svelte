<script lang="ts">
	import { ErrorBanner } from '#lib/components/opal/index.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { session, landingFor, type CurrentUser } from '#lib/session.svelte.js';

	const token = page.url.searchParams.get('token') ?? '';
	let username = $state<string | null>(null);
	let invalid = $state(false);
	let password = $state('');
	let confirmPw = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	onMount(async () => {
		try {
			username = (await api.get<{ username: string }>('/auth/claim', { token })).username;
		} catch {
			invalid = true;
		}
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
			const r = await api.post<{ user: CurrentUser }>('/auth/claim', { token, password });
			session.set(r.user);
			await goto(landingFor(r.user, null), { replace: true });
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not set password';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Set password · OPAL</title></svelte:head>

<h1 class="mb-4 text-lg font-semibold">Set password</h1>

{#if invalid}
	<ErrorBanner message="This link is invalid or has expired." class="mb-3" />
	<Button variant="outline" href="/login">SIGN IN</Button>
{:else if username}
	<ErrorBanner message={error} class="mb-3" />
	<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
		<div class="grid grid-cols-1 gap-1.5">
			<Label>Username</Label>
			<div class="mono text-sm">{username}</div>
		</div>
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="password">Password</Label>
			<Input
				id="password"
				type="password"
				bind:value={password}
				autocomplete="new-password"
				required
			/>
		</div>
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="confirm">Confirm password</Label>
			<Input
				id="confirm"
				type="password"
				bind:value={confirmPw}
				autocomplete="new-password"
				required
			/>
		</div>
		<Button type="submit" disabled={busy}>SET PASSWORD</Button>
	</form>
{:else}
	<Skeleton class="h-24" />
{/if}
