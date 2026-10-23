<script lang="ts">
	import { DetailRow, DetailTable, Section, State } from '#lib/components/opal/index.js';
	import type { SignInConfig } from '#lib/session.svelte.js';

	let { signIn }: { signIn: SignInConfig } = $props();

	const on = (v: boolean) => (v ? 'ENABLED' : 'DISABLED');
</script>

<Section title="Sign-in methods">
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
		{/if}
	</DetailTable>
</Section>
