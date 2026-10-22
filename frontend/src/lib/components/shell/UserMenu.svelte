<script lang="ts">
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { goto } from '$app/navigation';
	import { mode, setMode } from 'mode-watcher';
	import { ACCOUNT_GROUP, NAV } from '#lib/nav.js';
	import { session } from '#lib/session.svelte.js';

	async function signOut() {
		await session.logout().catch(() => {});
		goto('/login');
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		aria-label="Account menu"
		class="inline-flex h-7 items-center gap-2 border border-border px-2 font-mono text-[11px] tracking-wider uppercase hover:bg-accent"
	>
		{session.user?.username ?? '—'}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-48">
		<DropdownMenu.Label class="text-xs">{session.user?.name}</DropdownMenu.Label>
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
