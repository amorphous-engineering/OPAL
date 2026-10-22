<script lang="ts">
	import './layout.css';
	import favicon from '#lib/assets/favicon.svg';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import ConfirmHost from '#lib/components/opal/ConfirmHost.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>OPAL</title>
</svelte:head>

<!-- Dark is OPAL's default (seeded in app.html); the user menu toggles and remembers a choice. -->
<ModeWatcher defaultMode="dark" />
<Toaster position="bottom-right" />
<ConfirmHost />
{@render children()}
