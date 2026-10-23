<script lang="ts">
	// An error stated where it lands: one muted-red box (role=alert). It renders only while
	// `message` is set, so callers need no {#if}. `children` replaces the message when the
	// error has structure (a list of problems).
	import type { Snippet } from 'svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { cn } from '#lib/utils.js';

	let {
		message,
		children,
		class: className
	}: { message?: string | null; children?: Snippet; class?: string } = $props();
</script>

{#if children || message}
	<Alert.Root
		class={cn('block rounded-md border-error/40 bg-error-muted text-xs text-error', className)}
	>
		{#if children}{@render children()}{:else}{message}{/if}
	</Alert.Root>
{/if}
