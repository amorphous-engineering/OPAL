<script lang="ts">
	import { goto } from '$app/navigation';
	import { Field, FormKeys, PageHeader, Section } from '#lib/components/opal/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { ApiError, opal } from '#lib/api.js';

	let name = $state('');
	let username = $state('');
	let email = $state('');
	let password = $state('');
	let isAdmin = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			const created = await opal.org.users.create({
				name: name.trim(),
				username: username.trim() || null,
				email: email.trim() || null,
				password: password || null,
				isAdmin
			});
			// No password means the owner has to claim the account: hand the admin
			// the claim link straight away instead of making them hunt for it.
			await goto(`/users/${created.id}${password ? '' : '?claim=1'}`);
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not create the user';
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New user"
	crumbs={[{ label: 'System' }, { label: 'Users', href: '/users' }, { label: 'New' }]}
/>

<form class="grid max-w-xl grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<Section title="User">
		<div class="grid grid-cols-1 gap-3 p-3">
			<Field label="Name" for="name" required>
				<Input id="name" bind:value={name} maxlength={255} required autocomplete="off" autofocus />
			</Field>
			<Field label="Username" for="username">
				<Input
					id="username"
					class="font-mono"
					bind:value={username}
					maxlength={64}
					autocapitalize="none"
					autocomplete="off"
				/>
			</Field>
			<Field label="Email" for="email">
				<Input id="email" type="email" bind:value={email} maxlength={255} autocomplete="off" />
			</Field>
			<Field label="Initial password" for="password">
				<Input
					id="password"
					type="password"
					bind:value={password}
					minlength={10}
					autocomplete="new-password"
				/>
			</Field>
			<div class="flex items-center gap-2">
				<Switch id="is-admin" bind:checked={isAdmin} />
				<Label for="is-admin">Administrator</Label>
			</div>
		</div>
	</Section>
	<FormKeys submit="CREATE" cancel="/users" missing={name.trim() ? [] : ['name']} {busy} {error} />
</form>
