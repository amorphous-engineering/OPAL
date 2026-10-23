<script lang="ts">
	// Page title row: identifier (mono), title, state, actions. Breadcrumbs above.
	import type { Snippet } from 'svelte';

	let {
		title,
		identifier,
		crumbs = [],
		state,
		actions,
		meta,
		heading
	}: {
		title: string;
		identifier?: string | null;
		crumbs?: { label: string; href?: string }[];
		state?: Snippet;
		actions?: Snippet;
		meta?: Snippet;
		/** Replaces the plain title (in-place editing); `title` still names the browser tab. */
		heading?: Snippet;
	} = $props();
</script>

<svelte:head><title>{identifier ? `${identifier} ${title}` : title} · OPAL</title></svelte:head>

{#if crumbs.length}
	<!-- Breadcrumbs: their own compact strip, segments ruled apart, a divider below. -->
	<nav
		aria-label="Breadcrumb"
		class="flex h-7 items-stretch overflow-x-auto border-b border-border bg-muted/30 font-mono text-[11px] tracking-wider whitespace-nowrap text-muted-foreground uppercase"
	>
		{#each crumbs as c, i (i)}
			{#if c.href}
				<a
					href={c.href}
					class="flex items-center border-r border-border px-3 hover:bg-accent hover:text-foreground"
					>{c.label}</a
				>
			{:else}
				<span
					class="flex items-center border-r border-border px-3 text-foreground"
					aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.label}</span
				>
			{/if}
		{/each}
	</nav>
{/if}
<div class="border-b border-border bg-background px-4 py-2.5">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		{#if identifier}<span class="font-mono text-base font-semibold text-info">{identifier}</span
			>{/if}
		{#if heading}{@render heading()}{:else}<h1 class="text-lg font-semibold tracking-tight">
				{title}
			</h1>{/if}
		{@render state?.()}
		<div class="ml-auto flex flex-wrap items-center gap-2">{@render actions?.()}</div>
	</div>
	{#if meta}<div class="mt-1 text-xs text-muted-foreground">{@render meta()}</div>{/if}
</div>
