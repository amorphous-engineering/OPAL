<script lang="ts">
	// Import the organization requirement catalog into one project. The project is required.
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { invalidateAll } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { toast, toastError } from '#lib/components/opal/index.js';
	import ProjectSelect from '#lib/components/projects/ProjectSelect.svelte';

	let {
		open = $bindable(false),
		projectId = 0,
		count
	}: { open?: boolean; projectId?: number; count: number } = $props();

	let chosen = $state(0);
	let busy = $state(false);

	$effect(() => {
		if (open) chosen = projectId;
	});

	async function run(e: SubmitEvent) {
		e.preventDefault();
		if (!chosen || busy) return;
		busy = true;
		try {
			const r = await opal.requirements.importCatalog({ projectId: chosen });
			toast.success(
				`Imported ${r.created.length} requirement(s), ${r.skipped.length} already present`
			);
			open = false;
			await invalidateAll();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Import catalog · {count}</Dialog.Title>
		</Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={run}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="ic-project">Project</Label>
				<ProjectSelect id="ic-project" bind:value={chosen} class="w-full" />
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}<Button variant="outline" {...props}>CANCEL</Button>{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={busy || !chosen}>IMPORT</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
