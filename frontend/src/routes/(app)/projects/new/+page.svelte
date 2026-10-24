<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { ErrorBanner, PageHeader, Section, toastError } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';

	let code = $state('');
	let name = $state('');
	let description = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

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

<form class="grid max-w-3xl grid-cols-1 gap-4 p-4" onsubmit={submit}>
	<ErrorBanner message={error} />
	<Section title="Project">
		<div class="grid grid-cols-1 gap-3 p-3">
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="pr-code">Code</Label>
					<Input
						id="pr-code"
						class="font-mono uppercase"
						bind:value={code}
						maxlength={24}
						required
						autofocus
						autocomplete="off"
					/>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="pr-name">Name</Label>
					<Input id="pr-name" bind:value={name} required autocomplete="off" />
				</div>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="pr-desc">Description</Label>
				<Textarea id="pr-desc" bind:value={description} rows={3} />
			</div>
		</div>
	</Section>
	<div class="flex gap-2">
		<Button type="submit" disabled={busy || !code.trim() || !name.trim()}>CREATE</Button>
		<Button variant="outline" href="/projects">CANCEL</Button>
	</div>
</form>
