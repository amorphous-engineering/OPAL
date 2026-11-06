<script lang="ts">
	import { ErrorBanner } from '#lib/components/opal/index.js';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import {
		session,
		getSignInConfig,
		landingFor,
		toCurrentUser,
		type AuthConfig
	} from '#lib/session.svelte.js';

	let setupCode = $state('');
	let name = $state('');
	let email = $state('');
	let username = $state('');
	let password = $state('');
	let confirmPw = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let config = $state<AuthConfig | null>(null);

	onMount(async () => {
		config = await getSignInConfig().catch(() => null);
		if (config && !config.needsSetup) goto('/login', { replace: true });
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
			const r = await opal.auth.setup({
				name,
				email: email || null,
				username,
				password,
				...(config?.setupCodeRequired ? { setupCode } : {})
			});
			const user = toCurrentUser(r.user);
			session.set(user);
			await goto(landingFor(user, null), { replace: true });
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Setup failed';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>First-run setup · OPAL</title></svelte:head>

<h1 class="text-lg font-semibold">First administrator</h1>
<p class="mb-4 text-xs text-muted-foreground">This account administers the instance.</p>

<ErrorBanner message={error} class="mb-3" />

{#if config && !config.setupHostAllowed}
	<p class="text-sm">
		Open this page by the server's IP address to finish setup, or set
		<span class="font-mono">OPAL_ALLOWED_HOSTS</span> to include this host name and restart OPAL.
	</p>
{:else}
	<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
		{#if config?.setupCodeRequired}
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="setup-code">Setup code</Label>
				<Input
					id="setup-code"
					class="font-mono uppercase"
					bind:value={setupCode}
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
					required
				/>
				<p class="text-xs text-muted-foreground">
					OPAL printed this code where it started: the terminal, the control page or the service
					log.
				</p>
			</div>
		{/if}
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="name">Name</Label><Input
				id="name"
				bind:value={name}
				autocomplete="name"
				required
			/>
		</div>
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="email">Email</Label><Input
				id="email"
				type="email"
				bind:value={email}
				autocomplete="email"
			/>
		</div>
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
		<Button type="submit" disabled={busy}>CREATE ADMINISTRATOR</Button>
	</form>
{/if}
{#if config?.oidcEnabled}
	<div class="my-4 flex items-center gap-2 font-mono text-xs text-muted-foreground uppercase">
		<Separator class="flex-1" />or<Separator class="flex-1" />
	</div>
	<Button variant="outline" class="w-full" href="/oidc/login" data-sveltekit-reload
		>SIGN IN WITH {(config.oidcProviderName ?? 'SSO').toUpperCase()}</Button
	>
{/if}
