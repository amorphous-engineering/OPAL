<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		DataTable,
		FilterBar,
		FilterSelect,
		ListFrame,
		PageHeader,
		State,
		Timestamp,
		hasParams,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import { notifyChanged, type Notification } from '#lib/components/shell/notifications.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(['state', 'category']);
	});

	const columns: Column<Notification>[] = [
		{ key: 'createdAt', label: 'When', width: '10.5rem' },
		{ key: 'category', label: 'Category', width: '8rem' },
		{ key: 'priority', label: 'Priority', width: '6rem' },
		{ key: 'title', label: 'Notification' },
		{ key: 'actorName', label: 'From', width: '10rem' },
		{ key: 'actions', label: '', width: '12rem', align: 'right' }
	];

	async function refresh() {
		await invalidate('app:notifications');
		notifyChanged();
	}

	async function open(n: Notification) {
		try {
			if (!n.readAt) await opal.platform.notifications.read({ id: n.id });
			notifyChanged();
		} catch (e) {
			toastError(e);
		}
		goto(n.href);
	}

	async function markRead(n: Notification) {
		try {
			await opal.platform.notifications.read({ id: n.id });
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	async function dismiss(n: Notification) {
		try {
			await opal.platform.notifications.dismiss({ id: n.id });
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	let busy = $state(false);
	async function readAll() {
		busy = true;
		try {
			await opal.platform.notifications.readAll({});
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	const priorityTone = (p: string) =>
		p === 'critical' ? 'error' : p === 'high' ? 'warn' : 'muted';
</script>

<PageHeader title="Notifications">
	{#snippet meta()}
		<span class="font-mono">{data.unreadCount} unread</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" disabled={busy || data.unreadCount === 0} onclick={readAll}
			>MARK ALL READ</Button
		>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={['state', 'category', 'sort']}>
		<FilterSelect
			param="state"
			label="State"
			allLabel="Any state"
			options={[
				{ value: 'unread', label: 'Unread' },
				{ value: 'read', label: 'Read' }
			]}
		/>
		<FilterSelect
			param="category"
			label="Category"
			allLabel="All categories"
			options={[
				{ value: 'issues', label: 'Issues' },
				{ value: 'executions', label: 'Executions' }
			]}
		/>
		<FilterSelect
			param="sort"
			label="Sort"
			allLabel=""
			fallback="recent"
			options={[
				{ value: 'recent', label: 'Recent' },
				{ value: 'priority', label: 'Priority' },
				{ value: 'unread', label: 'Unread first' }
			]}
		/>
		{#snippet end()}
			<span class="font-mono text-xs text-muted-foreground">
				{data.items.length}{data.total > data.items.length ? ` of ${data.total}` : ''} shown
			</span>
		{/snippet}
	</FilterBar>

	<DataTable
		rows={data.items}
		{columns}
		key={(n) => n.id}
		onrowclick={open}
		emptyLabel="NOTIFICATIONS"
		emptyAction={filtered ? clearAction : undefined}
		rowClass={(n) => (n.readAt ? 'text-muted-foreground' : undefined)}
	>
		{#snippet cell(n, col)}
			{#if col.key === 'createdAt'}
				<span class="inline-flex items-center gap-1.5">
					<span
						class="size-1.5 shrink-0 {n.readAt ? '' : 'bg-info'}"
						role={n.readAt ? undefined : 'img'}
						aria-label={n.readAt ? undefined : 'Unread'}
					></span>
					<Timestamp value={n.createdAt} />
				</span>
			{:else if col.key === 'category'}
				<span class="font-mono text-xs uppercase">{n.category}</span>
			{:else if col.key === 'priority'}
				<State value={n.priority} tone={priorityTone(n.priority)} />
			{:else if col.key === 'title'}
				<a
					href={n.href}
					class="{n.readAt ? '' : 'font-medium'} hover:underline"
					onclick={(e) => {
						e.preventDefault();
						open(n);
					}}>{n.title}</a
				>
				{#if n.body}<div class="text-xs text-muted-foreground">{n.body}</div>{/if}
			{:else if col.key === 'actorName'}
				{#if n.actorName}{n.actorName}{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else}
				<span class="inline-flex gap-1">
					{#if !n.readAt}
						<Button variant="outline" size="xs" onclick={() => markRead(n)}>MARK READ</Button>
					{/if}
					<Button variant="outline" size="xs" onclick={() => dismiss(n)}>DISMISS</Button>
				</span>
			{/if}
		{/snippet}
	</DataTable>
</ListFrame>

{#snippet clearAction()}
	<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a>
{/snippet}
