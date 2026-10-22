<script lang="ts">
	import { DetailRow, DetailTable, Section, State } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { SignInConfig } from '#lib/session.svelte.js';
	import type { AuthSettings } from './types.js';

	let {
		signIn,
		auth,
		isAdmin
	}: { signIn: SignInConfig; auth: AuthSettings | null; isAdmin: boolean } = $props();

	const on = (v: boolean) => (v ? 'ENABLED' : 'DISABLED');
</script>

<Section title="Sign-in methods">
	{#snippet actions()}
		{#if isAdmin}<Button variant="ghost" size="xs" href="/settings/auth">EDIT</Button>{/if}
	{/snippet}
	<DetailTable>
		<DetailRow label="Password">
			<State
				value={signIn.password_login_enabled ? 'active' : 'off'}
				tone={signIn.password_login_enabled ? 'ok' : 'muted'}
				label={on(signIn.password_login_enabled)}
			/>
		</DetailRow>
		<DetailRow label="Passkeys">
			<State
				value={signIn.passkeys_enabled ? 'active' : 'off'}
				tone={signIn.passkeys_enabled ? 'ok' : 'muted'}
				label={on(signIn.passkeys_enabled)}
			/>
		</DetailRow>
		<DetailRow label="OIDC">
			<State
				value={signIn.oidc_enabled ? 'active' : 'off'}
				tone={signIn.oidc_enabled ? 'ok' : 'muted'}
				label={on(signIn.oidc_enabled)}
			/>
		</DetailRow>
		{#if signIn.oidc_enabled}
			<DetailRow label="Provider" value={signIn.oidc_provider_name} />
			{#if auth}<DetailRow label="Issuer" mono value={auth.oidc_issuer} />{/if}
		{/if}
	</DetailTable>
</Section>
