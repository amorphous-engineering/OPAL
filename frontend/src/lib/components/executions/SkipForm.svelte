<script lang="ts">
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { DocStep } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import FormRow from './FormRow.svelte';

	let { store, step }: { store: ExecutionStore; step: DocStep } = $props();
	let reason = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await store.skipStep(step, reason);
			store.closeDialog();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to skip step';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
	<Dialog.Header>
		<Dialog.Title>Skip step</Dialog.Title>
		<Dialog.Description>
			<span class="font-mono text-foreground">{step.number}</span>
			{step.title}
		</Dialog.Description>
	</Dialog.Header>
	<FormRow label="Reason" for="skip-reason" required>
		<Textarea id="skip-reason" rows={3} bind:value={reason} required autofocus />
	</FormRow>
	{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
	<Dialog.Footer>
		<Button variant="outline" onclick={() => store.closeDialog()}>CANCEL</Button>
		<Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>SKIP STEP</Button>
	</Dialog.Footer>
</form>
