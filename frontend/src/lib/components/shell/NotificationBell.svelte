<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { api } from '#lib/api.js';
	import { onMount } from 'svelte';
	import Timestamp from '#lib/components/opal/Timestamp.svelte';
	import { goto } from '$app/navigation';
	import { onNotificationsChanged, type Notification } from './notifications.js';

	let open = $state(false);
	let unread = $state(0);
	let items = $state<Notification[]>([]);

	async function refreshCount() {
		try {
			unread = (await api.get<{ unread_count: number }>('/notifications/unread-count'))
				.unread_count;
		} catch {
			/* signed out or offline; the bell just stays quiet */
		}
	}

	async function load() {
		const r = await api.get<{ items: Notification[]; unread_count: number }>('/notifications', {
			limit: 20
		});
		items = r.items;
		unread = r.unread_count;
	}

	async function openItem(n: Notification) {
		if (!n.read_at) await api.post(`/notifications/${n.id}/read`).catch(() => {});
		open = false;
		goto(n.href);
		refreshCount();
	}

	async function readAll() {
		await api.post('/notifications/read-all');
		await load();
	}

	onMount(() => {
		refreshCount();
		const t = setInterval(refreshCount, 30000);
		// The inbox page changed something: keep the count (and open list) in step.
		const off = onNotificationsChanged(() => (open ? load() : refreshCount()));
		return () => {
			clearInterval(t);
			off();
		};
	});

	$effect(() => {
		if (open) load();
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		class="relative inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-xs tracking-wider uppercase hover:bg-accent"
		aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
	>
		Inbox
		{#if unread > 0}<span class="rounded-sm bg-error px-1 text-xs text-white tabular-nums"
				>{unread}</span
			>{/if}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-96 p-0">
		<div class="flex h-8 items-center border-b border-border px-3">
			<span class="label text-foreground">Notifications</span>
			<span class="mono ml-2 text-xs text-muted-foreground">{unread} unread</span>
			{#if unread > 0}
				<Button
					variant="link"
					class="ml-auto h-auto border-0 p-0 font-mono font-normal text-info uppercase"
					onclick={readAll}>Mark all read</Button
				>
			{/if}
		</div>
		<div class="max-h-96 overflow-y-auto">
			{#each items as n (n.id)}
				<button
					class="block w-full border-b border-border px-3 py-2 text-left hover:bg-accent {n.read_at
						? 'text-muted-foreground'
						: ''}"
					onclick={() => openItem(n)}
				>
					<div class="flex items-baseline gap-2">
						{#if !n.read_at}<span class="size-1.5 shrink-0 bg-info" aria-label="Unread"></span>{/if}
						<span class="truncate text-sm {n.read_at ? '' : 'font-medium'}">{n.title}</span>
						<span class="ml-auto shrink-0"><Timestamp value={n.created_at} relative /></span>
					</div>
					{#if n.body}<div class="mt-0.5 truncate text-xs text-muted-foreground">{n.body}</div>{/if}
				</button>
			{:else}
				<div class="px-3 py-2 font-mono text-xs text-muted-foreground">NOTIFICATIONS — none</div>
			{/each}
		</div>
		<a
			href="/notifications"
			class="block border-t border-border px-3 py-1.5 text-center font-mono text-xs text-info uppercase hover:underline"
			onclick={() => (open = false)}>All notifications</a
		>
	</Popover.Content>
</Popover.Root>
