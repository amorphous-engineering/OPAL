<script lang="ts">
	import TopNav from '#lib/components/shell/TopNav.svelte';
	import GlobalKeys from '#lib/components/shell/GlobalKeys.svelte';
	import CommandPalette from '#lib/components/shell/CommandPalette.svelte';
	import NotificationBell from '#lib/components/shell/NotificationBell.svelte';
	import UserMenu from '#lib/components/shell/UserMenu.svelte';
	import VersionBadge from '#lib/components/shell/VersionBadge.svelte';
	import StatusBar from '#lib/components/shell/StatusBar.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { opal } from '#lib/api.js';
	import { page } from '$app/state';
	import { afterNavigate, beforeNavigate } from '$app/navigation';
	import type { LayoutProps } from './$types';

	let { children, data }: LayoutProps = $props();
	let paletteOpen = $state(false);

	// <main> scrolls, not the window, so the scroll bar runs between the header and the status
	// bar. The router only resets the window, so main does what it would: the top of a new page,
	// the old position on Back and Forward, and a #hash left to the router's scrollIntoView.
	let main = $state<HTMLElement>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
	const positions = new Map<string, number>();
	beforeNavigate(({ from }) => {
		if (from && main) positions.set(from.url.href, main.scrollTop);
	});
	afterNavigate(({ type, to }) => {
		if (!main || type === 'enter' || !to) return;
		if (type === 'popstate') main.scrollTop = positions.get(to.url.href) ?? 0;
		else if (!to.url.hash) main.scrollTop = 0;
	});

	// Presence: the Users pages show who is online and what they are doing. The pulse runs
	// while a tab is visible; the activity is the page the person is on.
	$effect(() => {
		const activity = page.url.pathname;
		const beat = () => {
			if (document.visibilityState === 'visible')
				opal.platform.presence.heartbeat({ activity }).catch(() => undefined);
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

<!-- --shell-h: height of the chrome around <main> (demo banner + header bar above, status bar
     below, 1.5rem), for pages that lock themselves to the viewport (the execution document). -->
<div
	class="flex h-svh min-w-0 flex-col overflow-hidden print:h-auto print:overflow-visible"
	style:--shell-h={data.demoActive ? '6rem' : '4.25rem'}
>
	{#if data.demoActive}
		<div
			role="status"
			class="flex h-7 shrink-0 items-center gap-3 border-b border-warn-fill bg-warn-fill px-3 font-mono text-xs font-medium tracking-wider text-warn-on uppercase"
		>
			<span>Demo database active — changes are deleted on exit</span>
			{#if data.user.is_admin}<a class="underline" href="/settings">Exit demo</a>{/if}
		</div>
	{/if}
	<header
		class="z-30 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3"
	>
		<div class="mr-1 max-w-56 min-w-0 shrink max-[560px]:hidden">
			<VersionBadge about={data.about} />
		</div>
		<TopNav />
		<Button
			variant="ghost"
			class="ml-auto h-7 max-w-xs min-w-8 flex-1 justify-start gap-2 border-border px-2 text-left font-normal text-muted-foreground hover:bg-accent hover:text-muted-foreground"
			aria-haspopup="dialog"
			aria-keyshortcuts="Control+K Meta+K"
			onclick={() => (paletteOpen = true)}
		>
			<span class="truncate">Search</span>
			<span class="ml-auto hidden sm:inline"><Kbd class="text-xs">⌘K</Kbd></span>
		</Button>
		<div class="flex shrink-0 items-center gap-2">
			<NotificationBell initialUnread={data.unreadCount} />
			<UserMenu />
		</div>
	</header>
	<main
		id="main"
		tabindex="-1"
		bind:this={main}
		class="relative min-h-0 min-w-0 flex-1 overflow-auto bg-desk outline-none print:overflow-visible"
	>
		{@render children()}
	</main>
	<StatusBar dbPath={data.about?.dbPath ?? '-'} />
</div>

<CommandPalette bind:open={paletteOpen} />
<GlobalKeys />
