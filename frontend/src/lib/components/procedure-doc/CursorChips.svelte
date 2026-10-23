<script lang="ts">
	// Presence: who has claimed this OP. The viewer's own chip is outlined bolder.
	import { cn } from '#lib/utils.js';
	import type { DocCursor } from './types.js';

	let { cursors, viewerId }: { cursors: DocCursor[]; viewerId: number | null } = $props();
</script>

{#if cursors.length}
	<span class="inline-flex items-center gap-1">
		{#each cursors as c (c.user_id)}
			<span
				class={cn(
					'inline-flex h-5 min-w-6 items-center justify-center border px-1 font-mono text-xs font-medium',
					c.user_id === viewerId
						? 'border-foreground/60 font-semibold text-foreground'
						: 'border-border text-foreground',
					c.stale && 'opacity-50'
				)}
				title={c.name ? `${c.name}${c.stale ? ' (idle)' : ''}` : ''}>{c.initials}</span
			>
		{/each}
	</span>
{/if}
