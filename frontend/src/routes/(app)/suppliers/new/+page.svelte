<script lang="ts">
	import { goto } from '$app/navigation';
	import { PageHeader, Section, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
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

<form class="grid max-w-3xl grid-cols-1 gap-4 p-4" onsubmit={submit}>
	<Section title="SUPPLIER">
		<div class="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="s-name">Name</Label>
				<Input id="s-name" bind:value={name} required maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="s-code">Code</Label>
				<Input
					id="s-code"
					bind:value={code}
					maxlength={50}
					class="font-mono"
					placeholder="SUP001"
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="s-email">Email</Label>
				<Input id="s-email" type="email" bind:value={email} maxlength={255} />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="s-phone">Phone</Label>
				<Input id="s-phone" type="tel" bind:value={phone} maxlength={50} class="font-mono" />
			</div>
			<div class="grid grid-cols-1 gap-1.5 md:col-span-2">
				<Label class="label" for="s-web">Website</Label>
				<Input id="s-web" type="url" bind:value={website} maxlength={255} placeholder="https://" />
			</div>
			<div class="grid grid-cols-1 gap-1.5 md:col-span-2">
				<Label class="label" for="s-address">Address</Label>
				<Textarea id="s-address" bind:value={address} rows={3} class="text-xs" />
			</div>
			<div class="grid grid-cols-1 gap-1.5 md:col-span-2">
				<Label class="label" for="s-desc">Description</Label>
				<Textarea id="s-desc" bind:value={description} rows={2} class="text-xs" />
			</div>
			<div class="grid grid-cols-1 gap-1.5 md:col-span-2">
				<Label class="label" for="s-notes">Notes</Label>
				<Textarea id="s-notes" bind:value={notes} rows={2} class="text-xs" />
			</div>
		</div>
	</Section>
	<ErrorBanner message={error} />
	<div class="flex justify-end gap-2">
		<Button variant="outline" href="/suppliers">CANCEL</Button>
		<Button type="submit" disabled={busy}>CREATE SUPPLIER</Button>
	</div>
</form>
