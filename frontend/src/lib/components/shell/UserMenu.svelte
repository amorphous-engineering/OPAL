<script lang="ts">
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { goto } from '$app/navigation';
	import { mode, setMode } from 'mode-watcher';
	import { ACCOUNT_GROUP, NAV } from '#lib/nav.js';
	import { Avatar } from '#lib/components/opal/index.js';
	import { session } from '#lib/session.svelte.js';

	async function signOut() {
		await session.logout().catch(() => {});
		goto('/login');
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		aria-label="Account menu"
		class="inline-flex h-7 items-center gap-2 border border-border px-1.5 text-sm hover:bg-accent data-[state=open]:bg-accent sm:px-2"
	>
		<Avatar user={session.user} size="xs" />
		<span class="hidden max-w-48 truncate sm:inline">{session.user?.name ?? '—'}</span>
		<span aria-hidden="true" class="text-xs text-muted-foreground">▾</span>
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-64">
		<div class="flex items-center gap-3 px-2 py-2">
			<Avatar user={session.user} size="md" />
			<div class="min-w-0">
				<div class="truncate text-sm font-medium">{session.user?.name}</div>
				<div class="truncate font-mono text-xs text-muted-foreground">
					{session.user?.job_title || session.user?.username}
				</div>
			</div>
		</div>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => goto(`/users/${session.user?.id}`)}
			>Profile</DropdownMenu.Item
		>
		{#each NAV.filter((g) => g.label === ACCOUNT_GROUP).flatMap((g) => g.items) as item (item.href)}
			{#if !item.adminOnly || session.user?.is_admin}
				<DropdownMenu.Item onSelect={() => goto(item.href)}>{item.label}</DropdownMenu.Item>
			{/if}
		{/each}
		<DropdownMenu.Item onSelect={() => setMode(mode.current === 'dark' ? 'light' : 'dark')}>
			{mode.current === 'dark' ? 'Light theme' : 'Dark theme'}
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive" onSelect={signOut}>Sign out</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
