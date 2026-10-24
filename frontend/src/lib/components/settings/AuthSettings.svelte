<script lang="ts">
	import { untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import {
		DetailRow,
		DetailTable,
		Section,
		State,
		toast,
		toastError,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import type { AuthSettings as AuthConfig, DiscoveryResult } from '@opal/shared';
	import CopyField from '#lib/components/users/CopyField.svelte';

	// The settings page loads the stored settings; the type is the contract's.
	let { auth }: { auth: unknown } = $props();
	// The form is seeded once from the stored settings and reseeded by each save.
	const seed = untrack(() => auth as AuthConfig);

	// The form starts from the stored settings and is reseeded after every save.
	let saved = $state<AuthConfig>(seed);
	let passwordLogin = $state(seed.passwordLoginEnabled);
	let passkeys = $state(seed.passkeysEnabled);
	let oidc = $state(seed.oidcEnabled);
	let issuer = $state(seed.oidcIssuer);
	let clientId = $state(seed.oidcClientId);
	let clientSecret = $state('');
	let clearSecret = $state(false);
	let provider = $state(seed.oidcProviderName);
	let scopes = $state(seed.oidcScopes);
	let groupsClaim = $state(seed.oidcGroupsClaim);
	let adminGroup = $state(seed.oidcAdminGroup);
	let baseUrl = $state(seed.oidcRedirectBaseUrl);
	let autoCreate = $state(seed.oidcAutoCreateUsers);
	const callbackUrl = $derived(saved.callbackUrl ?? `${location.origin}/oidc/callback`);

	let busy = $state(false);
	let error = $state<string | null>(null);
	let discovery = $state<DiscoveryResult | null>(null);
	let testing = $state(false);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			saved = await opal.auth.settings.update({
				passwordLoginEnabled: passwordLogin,
				passkeysEnabled: passkeys,
				oidcEnabled: oidc,
				oidcIssuer: issuer,
				oidcClientId: clientId,
				oidcClientSecret: clientSecret,
				clearClientSecret: clearSecret,
				oidcScopes: scopes,
				oidcProviderName: provider,
				oidcGroupsClaim: groupsClaim,
				oidcAdminGroup: adminGroup,
				oidcAutoCreateUsers: autoCreate,
				oidcRedirectBaseUrl: baseUrl
			});
			clientSecret = '';
			clearSecret = false;
			issuer = saved.oidcIssuer;
			baseUrl = saved.oidcRedirectBaseUrl;
			toast.success('Sign-in settings saved');
			void refreshAll();
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not save';
		} finally {
			busy = false;
		}
	}

	async function test() {
		testing = true;
		discovery = null;
		try {
			discovery = await opal.auth.settings.testDiscovery({});
		} catch (err) {
			toastError(err);
		} finally {
			testing = false;
		}
	}
</script>

<form class="grid grid-cols-1 gap-4" onsubmit={save}>
	<ErrorBanner message={error} />

	<Section title="Local credentials">
		<div class="grid grid-cols-1 gap-3 p-3">
			<div class="flex items-center gap-2">
				<Switch id="password" bind:checked={passwordLogin} />
				<Label for="password">Username and password</Label>
			</div>
			<div class="flex items-center gap-2">
				<Switch id="passkeys" bind:checked={passkeys} />
				<Label for="passkeys">Passkeys</Label>
			</div>
		</div>
	</Section>

	<Section title="OpenID Connect">
		<div class="grid grid-cols-1 gap-3 p-3">
			<div class="flex items-center gap-2">
				<Switch id="oidc" bind:checked={oidc} />
				<Label for="oidc">Single sign-on</Label>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="issuer">Issuer URL</Label>
				<Input
					id="issuer"
					class="font-mono"
					type="url"
					bind:value={issuer}
					placeholder="https://id.example.com"
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="client-id">Client id</Label>
				<Input id="client-id" class="font-mono" bind:value={clientId} autocomplete="off" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="client-secret">Client secret</Label>
				<Input
					id="client-secret"
					class="font-mono"
					type="password"
					bind:value={clientSecret}
					autocomplete="new-password"
					placeholder={saved.hasClientSecret ? 'Stored. Blank keeps it.' : 'None (public client)'}
				/>
				{#if saved.hasClientSecret}
					<div class="flex items-center gap-2">
						<Switch id="clear-secret" size="sm" bind:checked={clearSecret} />
						<Label for="clear-secret">Clear the stored secret</Label>
					</div>
				{/if}
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="provider">Provider name</Label>
				<Input id="provider" bind:value={provider} placeholder="Pocket ID" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="scopes">Scopes</Label>
				<Input id="scopes" class="font-mono" bind:value={scopes} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="groups">Groups claim</Label>
				<Input id="groups" class="font-mono" bind:value={groupsClaim} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="admin-group">Admin group</Label>
				<Input
					id="admin-group"
					class="font-mono"
					bind:value={adminGroup}
					placeholder="opal-admins"
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="base-url">Public base URL</Label>
				<Input
					id="base-url"
					class="font-mono"
					type="url"
					bind:value={baseUrl}
					placeholder="Derived from the request"
				/>
			</div>
			<div class="flex items-center gap-2">
				<Switch id="auto-create" bind:checked={autoCreate} />
				<Label for="auto-create">Create accounts on first sign-in</Label>
			</div>
		</div>
	</Section>

	<Section title="Callback URL">
		<div class="p-3">
			<CopyField value={callbackUrl} label="Callback URL" />
		</div>
	</Section>
	<Section title="Provider discovery">
		{#snippet actions()}
			<Button variant="ghost" size="xs" disabled={testing} onclick={test}>TEST DISCOVERY</Button>
		{/snippet}
		{#if discovery}
			<div class="border-b border-border px-3 py-2">
				<State
					value={discovery.ok ? 'ok' : 'failed'}
					tone={discovery.ok ? 'ok' : 'error'}
					label={discovery.ok ? 'REACHED' : 'FAILED'}
				/>
				<span class="ml-2 text-xs">{discovery.message}</span>
			</div>
			{#if discovery.authorizationEndpoint}
				<DetailTable>
					<DetailRow label="Authorization" mono value={discovery.authorizationEndpoint} />
					<DetailRow label="Token" mono value={discovery.tokenEndpoint} />
					<DetailRow label="Userinfo" mono value={discovery.userinfoEndpoint} />
					<DetailRow label="JWKS" mono value={discovery.jwksUri} />
				</DetailTable>
			{/if}
		{:else}
			<p class="px-3 py-2 font-mono text-xs text-muted-foreground">
				{testing ? 'Contacting the provider' : 'Not run'}
			</p>
		{/if}
	</Section>

	<div class="flex gap-2">
		<Button type="submit" class="flex-1" disabled={busy}>SAVE</Button>
	</div>
</form>
