<script lang="ts">
	import { toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import type { DocStep } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import FormRow from './FormRow.svelte';

	let { store, step }: { store: ExecutionStore; step: DocStep | null } = $props();
	let files = $state<FileList | undefined>();
	let note = $state('');
	let closeout = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!files?.length) return;
		busy = true;
		error = null;
		try {
			await store.attachFiles(step, Array.from(files), note, closeout);
			store.closeDialog();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Upload failed';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<form class="grid gap-3" onsubmit={submit}>
	<Dialog.Header>
		<Dialog.Title>Attach</Dialog.Title>
		<Dialog.Description>
			To {#if step}<span class="font-mono text-foreground">{step.number}</span>
				{step.title}{:else}the work order{/if}
		</Dialog.Description>
	</Dialog.Header>
	<FormRow label="Files" for="att-files" required>
		<Input id="att-files" type="file" capture="environment" multiple required bind:files />
	</FormRow>
	<FormRow label="Note" for="att-note">
		<Input id="att-note" bind:value={note} maxlength={500} />
	</FormRow>
	{#if !step}
		<label class="flex items-center gap-2 text-xs">
			<Checkbox bind:checked={closeout} />
			<span class="font-mono">CLOSEOUT</span>
		</label>
	{/if}
	{#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
	<Dialog.Footer>
		<Button variant="outline" onclick={() => store.closeDialog()}>CANCEL</Button>
		<Button type="submit" disabled={busy || !files?.length}>UPLOAD</Button>
	</Dialog.Footer>
</form>
