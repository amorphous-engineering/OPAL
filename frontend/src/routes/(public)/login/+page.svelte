<script lang="ts">
	import { ErrorBanner } from '#lib/components/opal/index.js';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { getAssertion, passkeysSupported } from '#lib/webauthn.js';
	import {
		session,
		getSignInConfig,
		landingFor,
		toCurrentUser,
		type CurrentUser,
		type AuthConfig
	} from '#lib/session.svelte.js';

	let config = $state<AuthConfig | null>(null);
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
		if (config.needsSetup) return goto('/setup', { replace: true });
		const user = await session.load().catch(() => null);
		if (user) goto(landingFor(user, next), { replace: true });
	});

	async function done(user: CurrentUser) {
		session.set(user);
		await goto(landingFor(user, next), { replace: true });
	}

	// Browsers expose WebAuthn on HTTPS and localhost only, never for a bare IP address.
	const passkeyUsable = $derived(
		!!config?.passkeysEnabled &&
			typeof window !== 'undefined' &&
			window.isSecureContext &&
			!/^[\d.]+$|:/.test(location.hostname) &&
			passkeysSupported()
	);

	async function passkeySignIn() {
		busy = true;
		error = null;
		try {
			const options = await opal.auth.passkeys.loginBegin({ rpId: location.hostname });
			const credential = await getAssertion(options);
			const r = await opal.auth.passkeys.loginComplete({ credential });
			await done(toCurrentUser(r.user));
		} catch (err) {
			// Dismissing the browser prompt is not an error worth reporting.
			if (!(err instanceof DOMException && err.name === 'NotAllowedError')) {
				error = err instanceof ApiError ? err.message : 'Passkey sign-in failed';
			}
		} finally {
			busy = false;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const r = await opal.auth.login({ username, password });
			await done(toCurrentUser(r.user));
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Sign-in failed';
			password = '';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · OPAL</title></svelte:head>

<h1 class="mb-4 text-lg font-semibold">Sign in</h1>

<ErrorBanner message={error} class="mb-3" />

{#if !config}
	{#if loadFailed}
		<Button variant="outline" onclick={() => location.reload()}>RETRY</Button>
	{:else}
		<Skeleton class="h-40" />
	{/if}
{:else}
	{#if config.passwordLoginEnabled}
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="username">Username</Label>
				<Input
					id="username"
					bind:value={username}
					autocomplete="username"
					autocapitalize="none"
					required
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
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
	{#if passkeyUsable || config.oidcEnabled}
		{#if config.passwordLoginEnabled}
			<div class="my-4 flex items-center gap-2 font-mono text-xs text-muted-foreground uppercase">
				<Separator class="flex-1" />or<Separator class="flex-1" />
			</div>
		{/if}
		<div class="grid grid-cols-1 gap-2">
			{#if passkeyUsable}
				<Button variant="outline" class="w-full" disabled={busy} onclick={passkeySignIn}
					>SIGN IN WITH PASSKEY</Button
				>
			{/if}
			{#if config.oidcEnabled}
				<Button
					variant="outline"
					class="w-full"
					href={`/oidc/login?next=${encodeURIComponent(next ?? '/')}`}
					data-sveltekit-reload>SIGN IN WITH {(config.oidcProviderName ?? 'SSO').toUpperCase()}</Button
				>
			{/if}
		</div>
	{/if}
{/if}
