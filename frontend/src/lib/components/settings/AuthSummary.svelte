<script lang="ts">
	import { DetailRow, DetailTable, Section, State } from '#lib/components/opal/index.js';
	import type { AuthConfig } from '#lib/session.svelte.js';

	// The settings page loads `auth.config`; the type is the contract's.
	let { signIn: loaded }: { signIn: unknown } = $props();
	const signIn = $derived(loaded as AuthConfig);

	const on = (v: boolean) => (v ? 'ENABLED' : 'DISABLED');
</script>

<Section title="Sign-in methods">
	<DetailTable>
		<DetailRow label="Password">
			<State
				value={signIn.passwordLoginEnabled ? 'active' : 'off'}
				tone={signIn.passwordLoginEnabled ? 'ok' : 'muted'}
				label={on(signIn.passwordLoginEnabled)}
			/>
		</DetailRow>
		<DetailRow label="Passkeys">
			<State
				value={signIn.passkeysEnabled ? 'active' : 'off'}
				tone={signIn.passkeysEnabled ? 'ok' : 'muted'}
				label={on(signIn.passkeysEnabled)}
			/>
		</DetailRow>
		<DetailRow label="OIDC">
			<State
				value={signIn.oidcEnabled ? 'active' : 'off'}
				tone={signIn.oidcEnabled ? 'ok' : 'muted'}
				label={on(signIn.oidcEnabled)}
			/>
		</DetailRow>
		{#if signIn.oidcEnabled}
			<DetailRow label="Provider" value={signIn.oidcProviderName} />
		{/if}
	</DetailTable>
</Section>
