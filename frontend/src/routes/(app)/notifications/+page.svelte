<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import {
		DataTable,
		PageHeader,
		State,
		Timestamp,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { notifyChanged, type Notification } from '#lib/components/shell/notifications.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(page.url.searchParams);
	const readState = $derived(q.get('state') ?? '');
	const category = $derived(q.get('category') ?? '');
	const sort = $derived(q.get('sort') ?? 'recent');

	const STATES = [
		['', 'Any'],
		['unread', 'Unread'],
		['read', 'Read']
	] as const;
	const CATEGORIES = [
		['', 'All'],
		['issues', 'Issues'],
		['executions', 'Executions']
	] as const;
	const SORTS = [
		['recent', 'Recent'],
		['priority', 'Priority'],
		['unread', 'Unread first']
	] as const;

	function link(key: string, value: string): string {
		const next = new SvelteURLSearchParams(page.url.search);
		if (value && !(key === 'sort' && value === 'recent')) next.set(key, value);
		else next.delete(key);
		const qs = next.toString();
		return qs ? `?${qs}` : page.url.pathname;
	}

	const columns: Column<Notification>[] = [
		{ key: 'created_at', label: 'When', width: '10.5rem' },
		{ key: 'category', label: 'Category', width: '8rem' },
		{ key: 'priority', label: 'Priority', width: '6rem' },
		{ key: 'title', label: 'Notification' },
		{ key: 'actor_name', label: 'From', width: '10rem' },
		{ key: 'actions', label: '', width: '12rem', align: 'right' }
	];

	async function refresh() {
		await invalidate('app:notifications');
		notifyChanged();
	}

	async function open(n: Notification) {
		try {
			if (!n.read_at) await api.post(`/notifications/${n.id}/read`);
			notifyChanged();
		} catch (e) {
			toastError(e);
		}
		goto(n.href);
	}

	async function markRead(n: Notification) {
		try {
			await api.post(`/notifications/${n.id}/read`);
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	async function dismiss(n: Notification) {
		try {
			await api.post(`/notifications/${n.id}/dismiss`);
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	let busy = $state(false);
	async function readAll() {
		busy = true;
		try {
			await api.post('/notifications/read-all');
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
		<span class="font-mono">{data.unread_count} unread</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" disabled={busy || data.unread_count === 0} onclick={readAll}
			>MARK ALL READ</Button
		>
	{/snippet}
</PageHeader>

{#snippet group(
	label: string,
	items: readonly (readonly [string, string])[],
	key: string,
	current: string
)}
	<div class="flex items-center gap-1.5" role="group" aria-label={label}>
		<span class="label">{label}</span>
		<div class="flex border border-border">
			{#each items as [value, text] (value)}
				<a
					href={link(key, value)}
					data-sveltekit-reset="false"
					aria-current={current === value ? 'true' : undefined}
					class="h-7 border-r border-border px-2.5 font-mono text-[11px] leading-7 tracking-wider uppercase last:border-r-0 {current ===
					value
						? 'bg-primary text-primary-foreground'
						: 'hover:bg-accent'}">{text}</a
				>
			{/each}
		</div>
	</div>
{/snippet}

<div class="space-y-3 p-4">
	<div class="flex flex-wrap items-center gap-x-5 gap-y-2">
		{@render group('State', STATES, 'state', readState)}
		{@render group('Category', CATEGORIES, 'category', category)}
		{@render group('Sort', SORTS, 'sort', sort)}
		<span class="ml-auto font-mono text-xs text-muted-foreground">
			{data.items.length}{data.total > data.items.length ? ` of ${data.total}` : ''} shown
		</span>
	</div>

	<div class="border border-border bg-card">
		<DataTable
			rows={data.items}
			{columns}
			key={(n) => n.id}
			onrowclick={open}
			emptyLabel={readState || category ? 'NOTIFICATIONS MATCHING' : 'NOTIFICATIONS'}
			rowClass={(n) => (n.read_at ? 'text-muted-foreground' : undefined)}
		>
			{#snippet cell(n, col)}
				{#if col.key === 'created_at'}
					<span class="inline-flex items-center gap-1.5">
						<span
							class="size-1.5 shrink-0 {n.read_at ? '' : 'bg-info'}"
							role={n.read_at ? undefined : 'img'}
							aria-label={n.read_at ? undefined : 'Unread'}
						></span>
						<Timestamp value={n.created_at} />
					</span>
				{:else if col.key === 'category'}
					<span class="font-mono text-xs uppercase">{n.category}</span>
				{:else if col.key === 'priority'}
					<State value={n.priority} tone={priorityTone(n.priority)} />
				{:else if col.key === 'title'}
					<a
						href={n.href}
						class="{n.read_at ? '' : 'font-medium'} hover:underline"
						onclick={(e) => {
							e.preventDefault();
							open(n);
						}}>{n.title}</a
					>
					{#if n.body}<div class="text-xs text-muted-foreground">{n.body}</div>{/if}
				{:else if col.key === 'actor_name'}
					{#if n.actor_name}{n.actor_name}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<span class="inline-flex gap-1">
						{#if !n.read_at}
							<Button variant="outline" size="xs" onclick={() => markRead(n)}>MARK READ</Button>
						{/if}
						<Button variant="outline" size="xs" onclick={() => dismiss(n)}>DISMISS</Button>
					</span>
				{/if}
			{/snippet}
		</DataTable>
	</div>
</div>
