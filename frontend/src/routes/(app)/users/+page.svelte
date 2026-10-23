<script lang="ts">
	import { page } from '$app/state';
	import {
		Avatar,
		DataTable,
		FilterBar,
		FilterSelect,
		ListFrame,
		PageHeader,
		SearchInput,
		State,
		Timestamp,
		hasParams,
		urlSort,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { signInMethods, type UserRecord } from '#lib/components/users/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const sort = urlSort({ key: 'name', dir: 'asc' });
	const FILTERS = ['q', 'status'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	const columns: Column<UserRecord>[] = [
		{ key: 'name', label: 'Name', sortable: true },
		{ key: 'username', label: 'Username', mono: true, sortable: true },
		{
			key: 'job_title',
			label: 'Job title',
			sortable: true,
			sortValue: (u) => u.job_title ?? ''
		},
		{
			key: 'workcenter',
			label: 'Workcenter',
			sortable: true,
			sortValue: (u) => u.workcenter?.name ?? ''
		},
		{ key: 'email', label: 'Email', sortable: true },
		{ key: 'roles', label: 'Roles', sortable: false },
		{ key: 'sign_in', label: 'Sign-in', sortable: false },
		{
			key: 'last_seen_at',
			label: 'Last seen',
			sortable: true,
			sortValue: (u) => u.last_seen_at ?? ''
		},
		{ key: 'created_at', label: 'Created', sortable: true }
	];
</script>

<PageHeader title="Users">
	{#snippet actions()}
		<Button size="sm" href="/users/new">+ NEW USER</Button>
	{/snippet}
	{#snippet meta()}<span class="mono">{data.total}</span>
		{data.status === 'all' ? 'total' : data.status}{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS}>
		<SearchInput label="Search users" placeholder="Name, username or email" />
		<FilterSelect
			param="status"
			label="Status"
			allLabel=""
			fallback="active"
			options={[
				{ value: 'active', label: 'Active' },
				{ value: 'inactive', label: 'Inactive' },
				{ value: 'all', label: 'All' }
			]}
		/>
	</FilterBar>

	<DataTable
		rows={data.users}
		{columns}
		bind:sort={() => sort.value, sort.set}
		href={(u) => `/users/${u.id}`}
		key={(u) => u.id}
		emptyLabel="USERS"
		rowClass={(u) => (u.is_active ? undefined : 'text-muted-foreground')}
	>
		{#snippet emptyAction()}
			{#if filtered}
				<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
			{:else}
				<a href="/users/new" class="font-medium text-info hover:underline">+ NEW USER</a>
			{/if}
		{/snippet}
		{#snippet cell(u, col)}
			{#if col.key === 'name'}
				<span class="inline-flex items-center gap-2">
					<Avatar user={u} size="xs" />
					<span class="font-medium">{u.name}</span>
				</span>
				{#if !u.is_active}<State value="inactive" tone="muted" class="ml-2" />{/if}
			{:else if col.key === 'job_title'}
				{#if u.job_title}{u.job_title}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'workcenter'}
				{#if u.workcenter}{u.workcenter.name}{:else}<span class="text-muted-foreground">—</span
					>{/if}
			{:else if col.key === 'email'}
				{#if u.email}{u.email}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'roles'}
				{@const held = (u as { roles?: { id: number; name: string }[] }).roles ?? []}
				{#if held.length}
					<span class="text-xs">{held.map((r) => r.name).join(' · ')}</span>
				{:else}
					<span class="text-muted-foreground">—</span>
				{/if}
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
</ListFrame>
