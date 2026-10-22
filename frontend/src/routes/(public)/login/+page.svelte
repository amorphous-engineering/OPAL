<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api, ApiError } from '#lib/api.js';
	import {
		session,
		getSignInConfig,
		landingFor,
		type CurrentUser,
		type SignInConfig
	} from '#lib/session.svelte.js';
	import { getAssertion, passkeysSupported } from '#lib/webauthn.js';

	let config = $state<SignInConfig | null>(null);
	let username = $state('');
	let password = $state('');
	let error = $state<string | null>(page.url.searchParams.get('error'));
	let busy = $state(false);
	let loadFailed = $state(false);
	const next = page.url.searchParams.get('next');

	onMount(async () => {
		try {
			config = await getSignInConfig();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not load the sign-in options';
			loadFailed = true;
			return;
		}
		if (config.needs_setup) return goto('/setup', { replace: true });
		const user = await session.load().catch(() => null);
		if (user) goto(landingFor(user, next), { replace: true });
	});

	async function done(user: CurrentUser) {
		session.set(user);
		await goto(landingFor(user, next), { replace: true });
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const r = await api.post<{ user: CurrentUser }>('/auth/login', { username, password });
			await done(r.user);
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Sign-in failed';
			password = '';
		} finally {
			busy = false;
		}
	}

	async function passkey() {
		busy = true;
		error = null;
		try {
			const options = await api.post<{ publicKey: Record<string, unknown> }>(
				'/auth/passkey/login/begin'
			);
			const assertion = await getAssertion(options);
			await api.post('/auth/passkey/login/complete', assertion);
			const user = await session.load();
			if (user) await done(user);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'NotAllowedError') error = null;
			else error = err instanceof Error ? err.message : 'Passkey sign-in failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · OPAL</title></svelte:head>

<h1 class="mb-4 text-base font-semibold">Sign in</h1>

{#if error}
	<p role="alert" class="mb-3 border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
		{error}
	</p>
{/if}

{#if !config}
	{#if loadFailed}
		<Button variant="outline" onclick={() => location.reload()}>RETRY</Button>
	{:else}
		<div class="h-40 animate-pulse bg-muted"></div>
	{/if}
{:else}
	{#if config.password_login_enabled}
		<form class="grid gap-3" onsubmit={submit}>
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
					autocomplete="current-password"
					required
				/>
			</div>
			<Button type="submit" disabled={busy}>SIGN IN</Button>
		</form>
	{/if}
	{#if (config.passkeys_enabled && passkeysSupported()) || config.oidc_enabled}
		<div class="my-4 flex items-center gap-2 font-mono text-[11px] text-muted-foreground uppercase">
			<span class="h-px flex-1 bg-border"></span>or<span class="h-px flex-1 bg-border"></span>
		</div>
		<div class="grid gap-2">
			{#if config.passkeys_enabled && passkeysSupported()}
				<Button variant="outline" disabled={busy} onclick={passkey}>SIGN IN WITH PASSKEY</Button>
			{/if}
			{#if config.oidc_enabled}
				<Button
					variant="outline"
					href={`/oidc/login?next=${encodeURIComponent(next ?? '/')}`}
					data-sveltekit-reload
					>SIGN IN WITH {(config.oidc_provider_name ?? 'SSO').toUpperCase()}</Button
				>
			{/if}
		</div>
	{/if}
{/if}
