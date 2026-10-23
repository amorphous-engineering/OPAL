<script lang="ts">
	// Admin-only: hand a passwordless account to its owner out of band.
	import { onMount } from 'svelte';
	import { Section, Timestamp, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import CopyField from './CopyField.svelte';
	import { claimUrl, type ClaimLink } from './types.js';

	let { userId, autoIssue = false }: { userId: number; autoIssue?: boolean } = $props();

	let link = $state<ClaimLink | null>(null);
	let busy = $state(false);

	async function issue() {
		busy = true;
		try {
			link = await api.post<ClaimLink>(`/users/${userId}/claim-link`);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		if (autoIssue) void issue();
	});
</script>

<Section title="Account claim">
	{#snippet actions()}
		<Button variant="ghost" size="xs" disabled={busy} onclick={issue}
			>{link ? 'ISSUE NEW LINK' : 'ISSUE CLAIM LINK'}</Button
		>
	{/snippet}
	<div class="grid grid-cols-1 gap-2 p-3">
		{#if link}
			<CopyField value={claimUrl(link)} label="Claim link" />
			<div class="text-xs text-muted-foreground">
				Single use, expires <Timestamp value={link.expires_at} />
			</div>
		{:else}
			<div class="text-xs text-muted-foreground">No password set. No link issued yet.</div>
		{/if}
	</div>
</Section>
