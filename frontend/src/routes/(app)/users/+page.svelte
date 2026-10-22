<script lang="ts">
	import { goto } from '$app/navigation';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		DataTable,
		PageHeader,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { signInMethods, type UserRecord } from '#lib/components/users/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let q = $derived(data.q);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Filters live in the URL: shareable and back-button safe.
	function apply(next: { q?: string; status?: string }) {
		const params = new SvelteURLSearchParams();
		const query = next.q ?? q;
		const status = next.status ?? data.status;
		if (query) params.set('q', query);
		if (status !== 'active') params.set('status', status);
		const qs = params.toString();
		goto(qs ? `?${qs}` : '?', { replace: true, reset: false });
	}

	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(() => apply({ q }), 250);
	}

	const columns: Column<UserRecord>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'username', label: 'Username', mono: true, sortable: true },
		{ key: 'email', label: 'Email', sortable: true },
		{
			key: 'is_admin',
			label: 'Role',
			sortable: true,
			sortValue: (u) => (u.is_admin ? 0 : 1)
		},
		{ key: 'sign_in', label: 'Sign-in', sortable: false },
		{
			key: 'last_seen_at',
			label: 'Last seen',
			sortable: true,
			sortValue: (u) => u.last_seen_at ?? ''
		},
		{ key: 'created_at', label: 'Created', sortable: true }
	];

	let sort = $state<{ key: string; dir: 'asc' | 'desc' } | null>({ key: 'name', dir: 'asc' });
</script>

<PageHeader title="Users" crumbs={[{ label: 'System' }, { label: 'Users' }]}>
	{#snippet actions()}
		<Button size="sm" href="/users/new">+ NEW USER</Button>
	{/snippet}
	{#snippet meta()}<span class="mono">{data.total}</span>
		{data.status === 'all' ? 'total' : data.status}{/snippet}
</PageHeader>

<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
	<Input
		type="search"
		class="h-7 w-64"
		placeholder="Name, username or email"
		aria-label="Search users"
		bind:value={q}
		oninput={onSearch}
	/>
	<NativeSelect.Root
		size="sm"
		aria-label="Status"
		value={data.status}
		onchange={(e) => apply({ status: e.currentTarget.value })}
	>
		<NativeSelect.Option value="active">Active</NativeSelect.Option>
		<NativeSelect.Option value="inactive">Inactive</NativeSelect.Option>
		<NativeSelect.Option value="all">All</NativeSelect.Option>
	</NativeSelect.Root>
</div>

<DataTable
	rows={data.users}
	{columns}
	bind:sort
	href={(u) => `/users/${u.id}`}
	key={(u) => u.id}
	emptyLabel="USERS"
	rowClass={(u) => (u.is_active ? undefined : 'text-muted-foreground')}
>
	{#snippet emptyAction()}
		<a href="/users/new" class="font-medium text-info hover:underline">+ ADD</a>
	{/snippet}
	{#snippet cell(u, col)}
		{#if col.key === 'name'}
			<span class="font-medium">{u.name}</span>
			{#if !u.is_active}<State value="inactive" tone="muted" class="ml-2" />{/if}
		{:else if col.key === 'email'}
			{#if u.email}{u.email}{:else}<span class="text-muted-foreground">—</span>{/if}
		{:else if col.key === 'is_admin'}
			{#if u.is_admin}<State value="admin" tone="warn" />{:else}<span
					class="font-mono text-xs text-muted-foreground">USER</span
				>{/if}
		{:else if col.key === 'sign_in'}
			{@const methods = signInMethods(u)}
			{#if methods.length}
				<span class="font-mono text-xs">{methods.join(' · ')}</span>
			{:else}
				<State value="unclaimed" tone="warn" />
			{/if}
		{:else if col.key === 'last_seen_at'}
			{#if u.is_online}
				<State value="online" tone="ok" />
			{:else}
				<Timestamp value={u.last_seen_at} relative />
			{/if}
		{:else if col.key === 'created_at'}
			<Timestamp value={u.created_at} dateOnly />
		{:else}
			{(u as unknown as Record<string, unknown>)[col.key]}
		{/if}
	{/snippet}
</DataTable>
