<script lang="ts">
	import { goto, refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Avatar,
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		confirm,
		toast,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { api } from '#lib/api.js';
	import { resetRoleNames, type Member, type Role } from '#lib/components/users/roles.js';

	let { roles, people, isAdmin }: { roles: Role[]; people: Member[]; isAdmin: boolean } = $props();

	const columns: Column<Role>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'description', label: 'Description' },
		{ key: 'member_count', label: 'Members', align: 'right', mono: true, sortable: true }
	];

	const selected = $derived(
		roles.find((r) => String(r.id) === page.url.searchParams.get('role')) ?? null
	);
	const members = $derived(
		selected ? people.filter((p) => p.roles?.some((r) => r.id === selected.id)) : []
	);

	let creating = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let name = $state('');
	let description = $state('');
	let busy = $state(false);

	// Editing fields follow the selected role.
	$effect(() => {
		name = selected?.name ?? '';
		description = selected?.description ?? '';
	});
	const dirty = $derived(
		!!selected && (name.trim() !== selected.name || description !== (selected.description ?? ''))
	);

	async function create(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !newName.trim()) return;
		busy = true;
		try {
			const r = await api.post<Role>('/roles', {
				name: newName.trim(),
				description: newDescription.trim() || null
			});
			resetRoleNames();
			toast.success('Role created');
			creating = false;
			newName = newDescription = '';
			await refreshAll();
			await goto(`?role=${r.id}#roles`);
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !selected || !dirty || !name.trim()) return;
		busy = true;
		try {
			await api.patch(`/roles/${selected.id}`, {
				name: name.trim(),
				description: description.trim() || null
			});
			resetRoleNames();
			toast.success('Role saved');
			await refreshAll();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!selected) return;
		const role = selected;
		const ok = await confirm({
			title: `Delete the role ${role.name}?`,
			body: `${role.member_count} ${role.member_count === 1 ? 'user loses' : 'users lose'} it. Template sign-offs naming it can no longer be signed until they name another role.`,
			action: 'DELETE ROLE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/roles/${role.id}`);
			resetRoleNames();
			toast.success('Role deleted');
			await goto('/settings#roles');
			await refreshAll();
		} catch (err) {
			toastError(err);
		}
	}
</script>

<div class="grid grid-cols-1 gap-4">
	{#if creating && isAdmin}
		<Section title="New role">
			<form class="grid grid-cols-1 gap-2 p-3 sm:grid-cols-[14rem_1fr_auto]" onsubmit={create}>
				<Input
					aria-label="Role name"
					placeholder="Name"
					maxlength={50}
					bind:value={newName}
					autofocus
				/>
				<Input
					aria-label="Role description"
					placeholder="Description"
					maxlength={200}
					bind:value={newDescription}
				/>
				<div class="flex gap-1">
					<Button type="submit" size="sm" disabled={busy || !newName.trim()}>CREATE</Button>
					<Button type="button" size="sm" variant="outline" onclick={() => (creating = false)}
						>CANCEL</Button
					>
				</div>
			</form>
		</Section>
	{/if}
	<Section title="Roles" count={roles.length}>
		{#snippet actions()}
			{#if isAdmin}<Button size="xs" variant="outline" onclick={() => (creating = !creating)}
					>+ NEW ROLE</Button
				>{/if}
		{/snippet}
		<DataTable
			rows={roles}
			{columns}
			key={(r) => r.id}
			href={(r) => `?role=${r.id}#roles`}
			rowClass={(r) => (r.id === selected?.id ? 'bg-muted/60' : undefined)}
			emptyLabel="roles"
		>
			{#snippet cell(r, col)}
				{#if col.key === 'name'}
					<span class="font-medium">{r.name}</span>
				{:else if col.key === 'description'}
					{#if r.description}{r.description}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					{r.member_count}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
	{#if selected}
		<Section title={selected.name}>
			{#snippet actions()}
				{#if isAdmin}
					<Button size="xs" variant="destructive" onclick={remove}>DELETE</Button>
				{/if}
			{/snippet}
			{#if isAdmin}
				<form onsubmit={save}>
					<DetailTable>
						<DetailRow label="Name">
							<Input aria-label="Name" class="h-7 max-w-xs" maxlength={50} bind:value={name} />
						</DetailRow>
						<DetailRow label="Description">
							<Input
								aria-label="Description"
								class="h-7"
								maxlength={200}
								bind:value={description}
							/>
						</DetailRow>
					</DetailTable>
					<div class="flex justify-end border-t border-border px-3 py-1.5">
						<Button type="submit" size="xs" disabled={busy || !dirty || !name.trim()}>SAVE</Button>
					</div>
				</form>
			{:else}
				<DetailTable>
					<DetailRow label="Name" value={selected.name} />
					<DetailRow label="Description" value={selected.description} />
				</DetailTable>
			{/if}
		</Section>
		<Section title="Members" count={members.length}>
			{#if members.length === 0}
				<EmptyLine label="members" />
			{:else}
				<ul>
					{#each members as m (m.id)}
						<li class="border-b border-border last:border-b-0">
							<a
								href={`/users/${m.id}`}
								class="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/60"
							>
								<Avatar user={m} size="xs" />
								<span class="font-medium">{m.name}</span>
								<span class="font-mono text-xs text-muted-foreground">{m.username}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Section>
	{/if}
</div>
