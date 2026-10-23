<script lang="ts">
	import TopNav from '#lib/components/shell/TopNav.svelte';
	import GlobalKeys from '#lib/components/shell/GlobalKeys.svelte';
	import CommandPalette from '#lib/components/shell/CommandPalette.svelte';
	import NotificationBell from '#lib/components/shell/NotificationBell.svelte';
	import UserMenu from '#lib/components/shell/UserMenu.svelte';
	import VersionBadge from '#lib/components/shell/VersionBadge.svelte';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { api } from '#lib/api.js';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
	let paletteOpen = $state(false);

	// Presence: the Users pages show who is online, which needs a pulse while a tab is open.
	$effect(() => {
		const beat = () => {
			if (document.visibilityState === 'visible') api.post('/users/heartbeat', {}).catch(() => {});
		};
		beat();
		const timer = setInterval(beat, 15_000);
		document.addEventListener('visibilitychange', beat);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', beat);
		};
	});
</script>

<a
	href="#main"
	class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:border focus:border-border focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm"
	>Skip to content</a
>

<!-- --shell-h: height of the chrome above <main> (demo banner + header bar), for pages that
     lock themselves to the viewport (the execution document). -->
<div
	class="flex min-h-svh min-w-0 flex-col"
	style:--shell-h={data.demoActive ? '4.5rem' : '2.75rem'}
>
	{#if data.demoActive}
		<div
			role="status"
			class="flex h-7 items-center gap-3 border-b border-warn/40 bg-warn-muted px-3 font-mono text-xs tracking-wider text-warn uppercase"
		>
			<span>Demo database active — changes are deleted on exit</span>
			{#if data.user.is_admin}<a class="underline" href="/settings">Exit demo</a>{/if}
		</div>
	{/if}
	<header
		class="sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-border bg-background px-3"
	>
		<div class="mr-1 max-w-56 min-w-0 shrink max-[560px]:hidden"><VersionBadge /></div>
		<TopNav />
		<button
			type="button"
			class="ml-auto flex h-7 max-w-xs min-w-8 flex-1 items-center gap-2 border border-border px-2 text-left text-xs text-muted-foreground hover:bg-accent"
			aria-haspopup="dialog"
			aria-keyshortcuts="Control+K Meta+K"
			onclick={() => (paletteOpen = true)}
		>
			<span class="truncate">Search</span>
			<span class="ml-auto hidden sm:inline"><Kbd>⌘K</Kbd></span>
		</button>
		<div class="flex shrink-0 items-center gap-2">
			<NotificationBell />
			<UserMenu />
		</div>
	</header>
	<main id="main" tabindex="-1" class="min-w-0 flex-1 outline-none">
		{@render children()}
	</main>
</div>

<CommandPalette bind:open={paletteOpen} />
<GlobalKeys />
