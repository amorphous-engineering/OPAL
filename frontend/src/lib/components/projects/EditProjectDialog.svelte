<script lang="ts">
	import { opal } from '#lib/api.js';
	import { ErrorBanner, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { Project } from '@opal/shared';

	let {
		open = $bindable(false),
		project,
		onsaved
	}: { open: boolean; project: Project; onsaved: () => void | Promise<void> } = $props();

	let code = $state('');
	let name = $state('');
	let description = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open) {
			code = project.code;
			name = project.name;
			description = project.description ?? '';
			error = null;
		}
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await opal.org.projects.update({
				id: project.id,
				code: code.trim(),
				name: name.trim(),
				description: description.trim() || null
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
		<Dialog.Header><Dialog.Title>Edit project</Dialog.Title></Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ep-code">Code</Label>
				<Input id="ep-code" class="font-mono uppercase" bind:value={code} maxlength={24} required />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ep-name">Name</Label>
				<Input id="ep-name" bind:value={name} required />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ep-desc">Description</Label>
				<Textarea id="ep-desc" bind:value={description} rows={3} />
			</div>
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !code.trim() || !name.trim()}>SAVE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
