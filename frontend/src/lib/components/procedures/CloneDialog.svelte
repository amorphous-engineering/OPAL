<script lang="ts">
	import { goto } from '$app/navigation';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { api } from '#lib/api.js';
	import { toastError } from '#lib/components/opal/index.js';

	let {
		open = $bindable(false),
		procedureId,
		name
	}: { open: boolean; procedureId: number; name: string } = $props();

	let newName = $state('');
	let copyKit = $state(true);
	let copyOutputs = $state(true);
	let busy = $state(false);

	$effect(() => {
		if (open) {
			newName = `Copy of ${name}`;
			copyKit = true;
			copyOutputs = true;
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const clone = await api.post<{ id: number }>(`/procedures/${procedureId}/clone`, {
				new_name: newName.trim() || null,
				copy_kit: copyKit,
				copy_outputs: copyOutputs
			});
			open = false;
			await goto(`/procedures/${clone.id}`);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header><Dialog.Title>Clone template</Dialog.Title></Dialog.Header>
		<form class="grid gap-3" onsubmit={submit}>
			<div class="grid gap-1.5">
				<Label for="clone-name">Name</Label>
				<Input id="clone-name" bind:value={newName} required maxlength={255} />
			</div>
			<div class="flex items-center gap-2">
				<Checkbox id="clone-kit" bind:checked={copyKit} />
				<Label for="clone-kit">Copy kit and step kits</Label>
			</div>
			<div class="flex items-center gap-2">
				<Checkbox id="clone-out" bind:checked={copyOutputs} />
				<Label for="clone-out">Copy outputs</Label>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !newName.trim()}>CLONE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
