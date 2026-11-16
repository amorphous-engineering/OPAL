<script lang="ts">
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.js';
	// Page title row: identifier (mono), title, meta (a count), actions. Breadcrumbs above, with the
	// record's state at their right end: the same spot on every record, whatever the title.
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

{#if crumbs.length || state}
	<!-- Breadcrumbs: shadcn's Breadcrumb in a compact row above the title, ruled below. Long
	     crumbs scroll on their own so the state stays in view. -->
	<div class="flex h-8 items-center gap-4 border-b border-border bg-background px-4">
		<Breadcrumb.Root class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
			<Breadcrumb.List class="flex-nowrap">
				{#each crumbs as c, i (i)}
					{#if i > 0}<Breadcrumb.Separator />{/if}
					<Breadcrumb.Item>
						{#if c.href && i < crumbs.length - 1}
							<Breadcrumb.Link href={c.href}>{c.label}</Breadcrumb.Link>
						{:else if i === crumbs.length - 1}
							<Breadcrumb.Page>{c.label}</Breadcrumb.Page>
						{:else}
							<span>{c.label}</span>
						{/if}
					</Breadcrumb.Item>
				{/each}
			</Breadcrumb.List>
		</Breadcrumb.Root>
		{#if state}<div class="flex-none" data-record-state>{@render state()}</div>{/if}
	</div>
{/if}
<div class="border-b border-border bg-background px-4 py-2.5">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<!-- Baseline row: the count reads as part of the title, not as a centered chip. -->
		<div class="flex min-w-0 flex-wrap items-baseline gap-x-3">
			{#if identifier}<span class="font-mono text-lg font-semibold whitespace-nowrap text-info"
					>{identifier}</span
				>{/if}
			{#if heading}{@render heading()}{:else}<h1 class="text-lg font-semibold tracking-tight">
					{title}
				</h1>{/if}
			{#if meta}<span class="text-sm text-muted-foreground">{@render meta()}</span>{/if}
		</div>
		<div class="ml-auto flex flex-wrap items-center gap-2">{@render actions?.()}</div>
	</div>
</div>
