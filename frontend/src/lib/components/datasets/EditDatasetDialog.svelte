<script lang="ts">
	import { opal } from '#lib/api.js';
	import { toastError, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte'; // added by projects
	import type { Dataset, ProcedureOption } from './types.js';

	let {
		open = $bindable(false),
		dataset,
		procedures,
		onsaved
	}: {
		open: boolean;
		dataset: Dataset;
		procedures: ProcedureOption[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let name = $state('');
	let description = $state('');
	let procedure = $state('');
	let projectId = $state(0); // added by projects
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			name = dataset.name;
			description = dataset.description ?? '';
			procedure = dataset.procedureId ? String(dataset.procedureId) : '';
			projectId = dataset.projectId;
			error = null;
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await opal.datasets.update({
				id: dataset.id,
				projectId, // added by projects
				name: name.trim(),
				description: description.trim() || null,
				procedureId: procedure ? Number(procedure) : null
			});
			open = false;
			await onsaved();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<Dialog.Header><Dialog.Title>Edit dataset</Dialog.Title></Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ed-project">Project</Label>
				<ProjectSelect id="ed-project" bind:value={projectId} keep={dataset.projectId} class="w-full" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ed-name">Name</Label>
				<Input id="ed-name" bind:value={name} required maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ed-desc">Description</Label>
				<Textarea id="ed-desc" bind:value={description} rows={3} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ed-proc">Procedure</Label>
				<NativeSelect id="ed-proc" bind:value={procedure} class="w-full">
					<NativeSelectOption value="">None</NativeSelectOption>
					{#each procedures as p (p.id)}
						<NativeSelectOption value={String(p.id)}>{p.name}</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !name.trim() || !projectId}>SAVE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
