<script lang="ts">
	// Launch Control's own shell. It is a separate app from OPAL with the same design language:
	// a printed form on a grey desk. The status bar shows both links the count depends on.
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { ModeWatcher } from 'mode-watcher';
	import { page } from '$app/state';
	import { cn } from '#lib/utils.js';
	import StatusBar from '#lib/components/shell/StatusBar.svelte';
	import { OPAL_URL } from '#lib/opal/link.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const trigger =
		'inline-flex h-7 items-center border border-transparent px-2 font-mono text-xs font-medium tracking-wider uppercase hover:bg-accent';
	const here = 'border-foreground bg-foreground text-background hover:bg-foreground';
	const onFlights = $derived(page.url.pathname === '/' || page.url.pathname.startsWith('/flights'));
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Launch Control</title>
</svelte:head>

<ModeWatcher defaultMode="light" />

<a
	href="#main"
	class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:border focus:border-border focus:bg-background focus:px-3 focus:py-1.5 focus:text-sm"
	>Skip to content</a
>

<div class="flex min-h-svh min-w-0 flex-col" style:--shell-h="4.25rem">
	<header
		class="sticky top-0 z-30 flex h-11 items-center gap-3 border-b border-border bg-background px-3"
	>
		<a href="/" class="font-mono text-sm font-bold tracking-[0.2em] whitespace-nowrap uppercase"
			>Launch&nbsp;Control</a
		>
		<nav aria-label="Primary" class="flex items-center gap-0.5">
			<a
				href="/"
				class={cn(trigger, onFlights && here)}
				aria-current={onFlights ? 'page' : undefined}>Flights</a
			>
		</nav>
		<div class="ml-auto flex items-center gap-3">
			<a
				href={OPAL_URL}
				target="_blank"
				rel="noopener"
				class="font-mono text-xs font-medium tracking-wider text-info uppercase hover:underline"
				>OPAL</a
			>
			<span class="inline-flex h-7 items-center gap-2 border border-border px-2 text-xs">
				<span class="font-mono font-semibold">AR</span>
				<span class="max-[560px]:hidden">A. Rivera</span>
			</span>
		</div>
	</header>
	<main id="main" tabindex="-1" class="min-w-0 flex-1 bg-desk outline-none">
		{@render children()}
	</main>
	<StatusBar />
</div>
