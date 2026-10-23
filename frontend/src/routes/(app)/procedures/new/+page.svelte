<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { api } from '#lib/api.js';
	import { PageHeader, toastError, ErrorBanner } from '#lib/components/opal/index.js';

	let name = $state('');
	let description = $state('');
	let type = $state('op');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const p = await api.post<{ id: number }>('/procedures', {
				name: name.trim(),
				description: description.trim() || null,
				procedure_type: type
			});
			await goto(`/procedures/${p.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not create template';
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New template"
	crumbs={[{ label: 'Templates', href: '/procedures' }, { label: 'New' }]}
/>

<form class="grid max-w-2xl grid-cols-1 gap-4 px-4 py-4" onsubmit={submit}>
	<ErrorBanner message={error} />
	<div class="grid grid-cols-1 gap-1.5">
		<Label for="name">Name</Label>
		<Input id="name" bind:value={name} required maxlength={255} autofocus />
	</div>
	<div class="grid grid-cols-1 gap-1.5">
		<Label for="type">Type</Label>
		<NativeSelect id="type" bind:value={type} class="max-w-xs">
			<NativeSelectOption value="op">OP — work order, no output</NativeSelectOption>
			<NativeSelectOption value="build">BUILD — produces an assembly</NativeSelectOption>
		</NativeSelect>
	</div>
	<div class="grid grid-cols-1 gap-1.5">
		<Label for="description">Description (markdown)</Label>
		<Textarea id="description" rows={6} bind:value={description} />
	</div>
	<div class="flex gap-2">
		<Button type="submit" disabled={busy || !name.trim()}>CREATE</Button>
		<Button type="button" variant="outline" href="/procedures">CANCEL</Button>
	</div>
</form>
