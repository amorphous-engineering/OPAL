<script lang="ts">
	// Presence: who has claimed this OP. The viewer's own chip is outlined bolder.
	import { Avatar } from '#lib/components/opal/index.js';
	import { cn } from '#lib/utils.js';
	import type { DocCursor } from './types.js';

	let { cursors, viewerId }: { cursors: DocCursor[]; viewerId: number | null } = $props();
</script>

{#if cursors.length}
	<span class="inline-flex items-center gap-1">
		{#each cursors as c (c.user_id)}
			<Avatar
				user={{ id: c.user_id, name: c.name ?? c.initials, avatar_url: c.avatar_url }}
				size="xs"
				class={cn(
					c.user_id === viewerId && 'border-foreground/60 font-semibold',
					c.stale && 'opacity-50'
				)}
			/>
		{/each}
	</span>
{/if}
