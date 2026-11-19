<script lang="ts">
	// The template's own fields: name, project, type, description (markdown). Without a
	// procedureId it creates the template: it shows the T-number the template would take, and
	// nothing is written (and no number is used) until CREATE.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { opal } from '#lib/api.js';
	import { Field, FormKeys, needs, toastError } from '#lib/components/opal/index.js';
	import type { Procedure, ProcedureType } from '@opal/shared';
	import ProjectSelect from './ProjectSelect.svelte';

	let {
		open = $bindable(false),
		procedureId,
		name = '',
		description = null,
		type = 'op',
		projectId = 0,
		onsaved,
		oncreated,
		oncancel
	}: {
		open: boolean;
		/** Absent: create a new template. */
		procedureId?: number;
		name?: string;
		description?: string | null;
		type?: ProcedureType;
		projectId?: number;
		onsaved?: () => void | Promise<void>;
		oncreated?: (p: Procedure) => void | Promise<void>;
		/** Closed without saving. */
		oncancel?: () => void;
	} = $props();

	const creating = $derived(procedureId === undefined);
	let f = $state({ name: '', description: '', type: 'op' as ProcedureType, projectId: 0 });
	let busy = $state(false);
	/** Saved: closing now is not a cancel. */
	let done = false;
	let nextNumber = $state<string | null>(null);

	$effect(() => {
		if (!open) return;
		done = false;
		f = { name, description: description ?? '', type, projectId };
		if (creating) {
			opal.procedures
				.nextNumber({})
				.then((r) => (nextNumber = r.templateNumber))
				.catch(toastError);
		}
	});

	function close() {
		done = true;
		open = false;
		oncancel?.();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const fields = {
				name: f.name.trim(),
				description: f.description.trim() || null,
				procedureType: f.type,
				projectId: f.projectId
			};
			if (procedureId === undefined) {
				const p = await opal.procedures.create(fields);
				done = true;
				open = false;
				await oncreated?.(p);
			} else {
				await opal.procedures.update({ id: procedureId, ...fields });
				done = true;
				open = false;
				await onsaved?.();
			}
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(v) => {
		if (!v && !done) oncancel?.();
	}}
>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{creating ? 'New template' : 'Edit details'}</Dialog.Title>
		</Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			{#if creating}
				<div class="grid grid-cols-1 gap-1.5">
					<span class="label">Number</span>
					<span class="font-mono text-sm" data-next-number>{nextNumber ?? '…'}</span>
				</div>
			{/if}
			<Field label="Name" for="edit-name" required>
				<Input id="edit-name" bind:value={f.name} required maxlength={255} autofocus />
			</Field>
			<Field label="Project" for="edit-project" required>
				<ProjectSelect
					id="edit-project"
					bind:value={f.projectId}
					keep={creating ? undefined : projectId}
				/>
			</Field>
			<Field label="Type" for="edit-type">
				<NativeSelect id="edit-type" bind:value={f.type} class="max-w-xs">
					<NativeSelectOption value="op">OP</NativeSelectOption>
					<NativeSelectOption value="build">BUILD</NativeSelectOption>
				</NativeSelect>
			</Field>
			<Field label="Description" for="edit-desc">
				<MarkdownField id="edit-desc" bind:value={f.description} minRows={4} />
			</Field>
			<FormKeys
				submit={creating ? 'CREATE' : 'SAVE'}
				cancel={close}
				cancelLabel={creating ? 'EXIT WITHOUT SAVING' : 'CANCEL'}
				missing={needs({ name: f.name.trim(), project: f.projectId })}
				{busy}
			/>
		</form>
	</Dialog.Content>
</Dialog.Root>
