<script lang="ts">
	import { goto } from '$app/navigation';
	import { Field, FormKeys, PageHeader, Section } from '#lib/components/opal/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { ApiError, opal } from '#lib/api.js';

	let name = $state('');
	let code = $state('');
	let email = $state('');
	let phone = $state('');
	let website = $state('');
	let address = $state('');
	let description = $state('');
	let notes = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const orNull = (v: string) => v.trim() || null;

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const s = await opal.purchasing.suppliers.create({
				name: name.trim(),
				code: orNull(code),
				email: orNull(email),
				phone: orNull(phone),
				website: orNull(website),
				address: orNull(address),
				description: orNull(description),
				notes: orNull(notes)
			});
			await goto(`/suppliers/${s.id}`);
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Failed to create';
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New supplier"
	crumbs={[{ label: 'Suppliers', href: '/suppliers' }, { label: 'New' }]}
/>

<form class="grid max-w-3xl grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<Section title="Supplier">
		<div class="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
			<Field label="Name" for="s-name" required>
				<Input id="s-name" bind:value={name} required maxlength={255} autofocus />
			</Field>
			<Field label="Code" for="s-code">
				<Input id="s-code" bind:value={code} maxlength={50} class="font-mono" />
			</Field>
			<Field label="Email" for="s-email">
				<Input id="s-email" type="email" bind:value={email} maxlength={255} />
			</Field>
			<Field label="Phone" for="s-phone">
				<Input id="s-phone" type="tel" bind:value={phone} maxlength={50} class="font-mono" />
			</Field>
			<Field label="Website" for="s-web" class="md:col-span-2">
				<Input id="s-web" type="url" bind:value={website} maxlength={255} />
			</Field>
			<Field label="Address" for="s-address" class="md:col-span-2">
				<Textarea id="s-address" bind:value={address} rows={3} />
			</Field>
			<Field label="Description" for="s-desc" class="md:col-span-2">
				<Textarea id="s-desc" bind:value={description} rows={2} />
			</Field>
			<Field label="Notes" for="s-notes" class="md:col-span-2">
				<Textarea id="s-notes" bind:value={notes} rows={2} />
			</Field>
		</div>
	</Section>
	<FormKeys
		submit="CREATE"
		cancel="/suppliers"
		missing={name.trim() ? [] : ['name']}
		{busy}
		{error}
	/>
</form>
