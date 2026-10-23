<script lang="ts">
	// The qualifications an account holds. Administrators tick roles on and off (saved at
	// once); everyone else reads the list. Roles themselves are managed in Settings.
	import { refreshAll } from '$app/navigation';
	import { EmptyLine, Section, toast, toastError } from '#lib/components/opal/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { api } from '#lib/api.js';
	import { roleList, type Role, type RoleRef } from './roles.js';

	let {
		userId,
		roles,
		isAdmin
	}: { userId: number; roles: RoleRef[] | undefined; isAdmin: boolean } = $props();

	let all = $state<Role[]>([]);
	let busy = $state(false);
	const held = $derived(new Set((roles ?? []).map((r) => r.id)));

	$effect(() => {
		if (!isAdmin) return;
		api
			.get<Role[] | { items: Role[] }>('/roles')
			.then((r) => (all = roleList(r)))
			.catch(toastError);
	});

	async function toggle(role: Role, on: boolean) {
		if (busy) return;
		busy = true;
		const ids = (roles ?? []).map((r) => r.id).filter((id) => id !== role.id);
		if (on) ids.push(role.id);
		try {
			await api.put(`/users/${userId}/roles`, { role_ids: ids });
			toast.success(on ? `${role.name} granted` : `${role.name} removed`);
			await refreshAll();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

{#if isAdmin}
	<Section title="Roles" count={held.size}>
		{#snippet actions()}
			<a
				href="/settings#roles"
				class="font-mono text-xs font-medium tracking-wider text-info uppercase hover:underline"
				>MANAGE ROLES</a
			>
		{/snippet}
		{#if all.length === 0}
			<EmptyLine label="roles" addHref="/settings#roles" addLabel="+ NEW ROLE" />
		{:else}
			<ul>
				{#each all as r (r.id)}
					<li class="border-b border-border last:border-b-0">
						<label class="flex items-center gap-2 px-3 py-1.5 text-sm">
							<Checkbox
								checked={held.has(r.id)}
								disabled={busy}
								onCheckedChange={(v) => toggle(r, !!v)}
								aria-label={r.name}
							/>
							<span class="font-medium">{r.name}</span>
							{#if r.description}<span class="text-muted-foreground">{r.description}</span>{/if}
						</label>
					</li>
				{/each}
			</ul>
		{/if}
	</Section>
{:else}
	<Section title="Roles" count={held.size}>
		{#if !roles?.length}
			<EmptyLine label="roles" />
		{:else}
			<ul>
				{#each roles as r (r.id)}
					<li class="border-b border-border px-3 py-1.5 text-sm font-medium last:border-b-0">
						{r.name}
					</li>
				{/each}
			</ul>
		{/if}
	</Section>
{/if}
