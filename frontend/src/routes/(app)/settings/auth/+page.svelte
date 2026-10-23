<script lang="ts">
	import { untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import {
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		State,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { api, ApiError } from '#lib/api.js';
	import type { AuthSettings } from '#lib/components/settings/types.js';
	import CopyField from '#lib/components/users/CopyField.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	// The form is seeded once from the stored settings and reseeded by each save.
	const seed = untrack(() => data.auth);

	interface Discovery {
		ok: boolean;
		message: string;
		authorization_endpoint: string | null;
		token_endpoint: string | null;
		userinfo_endpoint: string | null;
		jwks_uri: string | null;
	}

	// The form starts from the stored settings and is reseeded after every save.
	let saved = $state<AuthSettings>(seed);
	let passwordLogin = $state(seed.password_login_enabled);
	let passkeys = $state(seed.passkeys_enabled);
	let oidc = $state(seed.oidc_enabled);
	let issuer = $state(seed.oidc_issuer);
	let clientId = $state(seed.oidc_client_id);
	let clientSecret = $state('');
	let clearSecret = $state(false);
	let provider = $state(seed.oidc_provider_name);
	let scopes = $state(seed.oidc_scopes);
	let groupsClaim = $state(seed.oidc_groups_claim);
	let adminGroup = $state(seed.oidc_admin_group);
	let baseUrl = $state(seed.oidc_redirect_base_url);
	let autoCreate = $state(seed.oidc_auto_create_users);

	let busy = $state(false);
	let error = $state<string | null>(null);
	let discovery = $state<Discovery | null>(null);
	let testing = $state(false);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			saved = await api.put<AuthSettings>('/settings/auth', {
				password_login_enabled: passwordLogin,
				passkeys_enabled: passkeys,
				oidc_enabled: oidc,
				oidc_issuer: issuer,
				oidc_client_id: clientId,
				oidc_client_secret: clientSecret,
				clear_client_secret: clearSecret,
				oidc_scopes: scopes,
				oidc_provider_name: provider,
				oidc_groups_claim: groupsClaim,
				oidc_admin_group: adminGroup,
				oidc_auto_create_users: autoCreate,
				oidc_redirect_base_url: baseUrl
			});
			clientSecret = '';
			clearSecret = false;
			issuer = saved.oidc_issuer;
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
			discovery = await api.post<Discovery>('/settings/auth/test');
		} catch (err) {
			toastError(err);
		} finally {
			testing = false;
		}
	}
</script>

<PageHeader
	title="Sign-in methods"
	crumbs={[{ label: 'System' }, { label: 'Settings', href: '/settings' }, { label: 'Sign-in' }]}
/>

<div class="grid grid-cols-1 items-start gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
	<form class="grid min-w-0 grid-cols-1 gap-4" onsubmit={save}>
		{#if error}
			<p role="alert" class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error">
				{error}
			</p>
		{/if}

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
						placeholder={saved.has_client_secret
							? 'Stored. Blank keeps it.'
							: 'None (public client)'}
					/>
					{#if saved.has_client_secret}
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

		<div class="flex gap-2">
			<Button type="submit" disabled={busy}>SAVE</Button>
			<Button variant="outline" href="/settings">CANCEL</Button>
		</div>
	</form>

	<div class="grid min-w-0 grid-cols-1 gap-4">
		<Section title="Callback URL">
			<div class="p-3">
				<CopyField value={saved.callback_url} label="Callback URL" />
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
				{#if discovery.authorization_endpoint}
					<DetailTable>
						<DetailRow label="Authorization" mono value={discovery.authorization_endpoint} />
						<DetailRow label="Token" mono value={discovery.token_endpoint} />
						<DetailRow label="Userinfo" mono value={discovery.userinfo_endpoint} />
						<DetailRow label="JWKS" mono value={discovery.jwks_uri} />
					</DetailTable>
				{/if}
			{:else}
				<p class="px-3 py-2 font-mono text-xs text-muted-foreground">
					{testing ? 'Contacting the provider' : 'Not run'}
				</p>
			{/if}
		</Section>
	</div>
</div>
