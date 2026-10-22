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

<div class="border-b border-border bg-background px-4 pt-3 pb-3">
	{#if crumbs.length}
		<nav
			aria-label="Breadcrumb"
			class="mb-1 flex items-center gap-1 font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
		>
			{#each crumbs as c, i (i)}
				{#if i > 0}<span aria-hidden="true">/</span>{/if}
				{#if c.href}<a href={c.href} class="hover:text-foreground hover:underline">{c.label}</a
					>{:else}<span>{c.label}</span>{/if}
			{/each}
		</nav>
	{/if}
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
