<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { session, landingFor } from '#lib/session.svelte.js';

	let name = $state(session.user?.name ?? '');
	let error = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		try {
			await opal.org.users.setupProfile({ name });
			// Re-read the identity so the profile-setup flag clears everywhere.
			const user = await session.load();
			goto(user ? landingFor(user, null) : '/', { replace: true });
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Could not save';
		}
	}
</script>

<div class="mx-auto mt-16 max-w-sm rounded-lg border border-border bg-card p-4">
	<h1 class="mb-4 text-lg font-semibold">Display name</h1>
	{#if error}<p role="alert" class="mb-3 text-xs text-error">{error}</p>{/if}
	<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
		<div class="grid grid-cols-1 gap-1.5">
			<Label for="name">Name</Label><Input id="name" bind:value={name} required />
		</div>
		<Button type="submit">SAVE</Button>
	</form>
</div>
