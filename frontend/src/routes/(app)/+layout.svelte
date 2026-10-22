<script lang="ts">
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import AppSidebar from '#lib/components/shell/AppSidebar.svelte';
	import GlobalKeys from '#lib/components/shell/GlobalKeys.svelte';
	import CommandPalette from '#lib/components/shell/CommandPalette.svelte';
	import NotificationBell from '#lib/components/shell/NotificationBell.svelte';
	import UserMenu from '#lib/components/shell/UserMenu.svelte';
	import VersionBadge from '#lib/components/shell/VersionBadge.svelte';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	let paletteOpen = $state(false);
</script>

<Sidebar.Provider style="--sidebar-width: 13rem">
	<AppSidebar />
	<Sidebar.Inset class="min-w-0">
		<header
			class="sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-border bg-background px-3"
		>
			<Sidebar.Trigger class="-ml-1" />
			<div class="mr-2 max-w-64 min-w-0 shrink"><VersionBadge /></div>
			<button
				type="button"
				class="flex h-7 w-full max-w-sm items-center gap-2 border border-border px-2 text-left text-xs text-muted-foreground hover:bg-accent"
				onclick={() => (paletteOpen = true)}
			>
				<span>Search</span>
				<span class="ml-auto"><Kbd>⌘K</Kbd></span>
			</button>
			<div class="ml-auto flex items-center gap-2">
				<NotificationBell />
				<UserMenu />
			</div>
		</header>
		<main class="min-w-0 flex-1">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>

<CommandPalette bind:open={paletteOpen} />
<GlobalKeys />
