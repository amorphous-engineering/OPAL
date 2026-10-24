<script lang="ts">
	// Edit the template's own fields: name, description (markdown), type.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { api } from '#lib/api.js';
	import { toastError } from '#lib/components/opal/index.js';
	import type { ProcedureType } from './types.js';

	let {
		open = $bindable(false),
		procedureId,
		name,
		description,
		type,
		onsaved
	}: {
		open: boolean;
		procedureId: number;
		name: string;
		description: string | null;
		type: ProcedureType;
		onsaved: () => void | Promise<void>;
	} = $props();

	let f = $state({ name: '', description: '', type: 'op' as ProcedureType });
	let busy = $state(false);

	$effect(() => {
		if (open) f = { name, description: description ?? '', type };
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api.patch(`/procedures/${procedureId}`, {
				name: f.name.trim(),
				description: f.description,
				procedure_type: f.type
			});
			open = false;
			await onsaved();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header><Dialog.Title>Edit template</Dialog.Title></Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="edit-name">Name</Label>
				<Input id="edit-name" bind:value={f.name} required maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="edit-type">Type</Label>
				<NativeSelect id="edit-type" bind:value={f.type}>
					<NativeSelectOption value="op">OP — work order, no output</NativeSelectOption>
					<NativeSelectOption value="build">BUILD — produces an assembly</NativeSelectOption>
				</NativeSelect>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="edit-desc">Description (markdown)</Label>
				<MarkdownField id="edit-desc" bind:value={f.description} minRows={6} />
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !f.name.trim()}>SAVE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
