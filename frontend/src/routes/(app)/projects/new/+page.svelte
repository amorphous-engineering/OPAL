<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import {
		Field,
		FormKeys,
		needs,
		PageHeader,
		Section,
		toastError
	} from '#lib/components/opal/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';

	let code = $state('');
	let name = $state('');
	let description = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	const missing = $derived(needs({ code: code.trim(), name: name.trim() }));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const created = await opal.org.projects.create({
				code: code.trim(),
				name: name.trim(),
				description: description.trim() || null
			});
			await goto(`/projects/${created.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create the project';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New project"
	crumbs={[{ label: 'Projects', href: '/projects' }, { label: 'New' }]}
/>

<form class="grid max-w-3xl grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<Section title="Project">
		<div class="grid grid-cols-1 gap-3 p-3">
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
				<Field label="Code" for="pr-code" required>
					<Input
						id="pr-code"
						class="font-mono uppercase"
						bind:value={code}
						maxlength={24}
						required
						autofocus
						autocomplete="off"
					/>
				</Field>
				<Field label="Name" for="pr-name" required>
					<Input id="pr-name" bind:value={name} required autocomplete="off" />
				</Field>
			</div>
			<Field label="Description" for="pr-desc">
				<Textarea id="pr-desc" bind:value={description} rows={3} />
			</Field>
		</div>
	</Section>
	<FormKeys submit="CREATE" cancel="/projects" {missing} {busy} {error} />
</form>
