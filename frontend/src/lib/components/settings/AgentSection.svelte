<script lang="ts">
	import {
		confirm,
		DetailRow,
		DetailTable,
		Section,
		State,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import type { AgentActivation } from './types.js';

	let { agent, isAdmin }: { agent: AgentActivation; isAdmin: boolean } = $props();

	let state = $derived(agent);

	async function set(enabled: boolean) {
		if (enabled) {
			const ok = await confirm({
				title: 'Let the MCP agent activate parts?',
				body: 'Activations are attributed to you. Sign-offs, dispositions, baselines and risk acceptance stay human only.',
				action: 'ENABLE'
			});
			if (!ok) return;
		}
		try {
			state = await opal.org.settings.setAgentActivation({ enabled });
		} catch (err) {
			toastError(err);
		}
	}
</script>

<Section title="MCP agent">
	{#snippet actions()}
		{#if isAdmin}
			<Button variant="ghost" size="xs" onclick={() => set(!state.enabled)}
				>{state.enabled ? 'DISABLE' : 'ENABLE'}</Button
			>
		{/if}
	{/snippet}
	<DetailTable>
		<DetailRow label="Part activation">
			{#if state.enabled}<State value="agent" tone="warn" label="AGENT ENABLED" />{:else}<State
					value="human"
					tone="muted"
					label="HUMAN ONLY"
				/>{/if}
		</DetailRow>
		{#if state.enabled}<DetailRow label="Authorized by" value={state.authorizedBy} />{/if}
	</DetailTable>
</Section>
