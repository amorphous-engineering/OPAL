<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { opal } from '#lib/api.js';
	import { onMount } from 'svelte';
	import Timestamp from '#lib/components/opal/Timestamp.svelte';
	import { goto } from '$app/navigation';
	import { onServerEvent } from './events.js';
	import { onNotificationsChanged, type Notification } from './notifications.js';

	/** Count from the shell's page data, so the first paint has it. */
	let { initialUnread = 0 }: { initialUnread?: number } = $props();

	let open = $state(false);
	// svelte-ignore state_referenced_locally
	let unread = $state(initialUnread);
	let items = $state<Notification[]>([]);

	async function refreshCount() {
		try {
			unread = (await opal.platform.notifications.unreadCount({})).unreadCount;
		} catch {
			/* signed out or offline; the bell just stays quiet */
		}
	}

	async function load() {
		const r = await opal.platform.notifications.list({ limit: 20, sort: 'recent' });
		items = r.items;
		unread = r.unreadCount;
	}

	async function openItem(n: Notification) {
		if (!n.readAt) await opal.platform.notifications.read({ id: n.id }).catch(() => {});
		open = false;
		goto(n.href);
		refreshCount();
	}

	async function readAll() {
		await opal.platform.notifications.readAll({});
		await load();
	}

	onMount(() => {
		refreshCount();
		const sync = () => (open ? load() : refreshCount());
		// A slow poll covers a dropped event stream.
		const t = setInterval(refreshCount, 60000);
		// The inbox page changed something, or the server raised a notification for us.
		const offChanged = onNotificationsChanged(sync);
		const offEvent = onServerEvent('notification', sync);
		return () => {
			clearInterval(t);
			offChanged();
			offEvent();
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
					class="block w-full border-b border-border px-3 py-2 text-left hover:bg-accent {n.readAt
						? 'text-muted-foreground'
						: ''}"
					onclick={() => openItem(n)}
				>
					<div class="flex items-baseline gap-2">
						{#if !n.readAt}<span class="size-1.5 shrink-0 bg-info" aria-label="Unread"></span>{/if}
						<span class="truncate text-sm {n.readAt ? '' : 'font-medium'}">{n.title}</span>
						<span class="ml-auto shrink-0"><Timestamp value={n.createdAt} relative /></span>
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
