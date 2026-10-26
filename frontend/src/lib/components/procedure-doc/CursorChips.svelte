<script lang="ts">
	// Presence: who has claimed this OP. The viewer's own chip is outlined bolder. At most
	// MAX chips: past that, MAX - 1 people and a +N chip that names the rest in its tooltip.
	// With `labor`, the chips open the time each person worked on the OP.
	import { Avatar } from '#lib/components/opal/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { workTime } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import { clock, liveSeconds } from './labor.svelte.js';
	import type { DocCursor, DocLabor } from './types.js';

	let {
		cursors,
		viewerId,
		labor,
		title
	}: {
		cursors: DocCursor[];
		viewerId: number | null;
		labor?: DocLabor[];
		/** Heading of the time list, e.g. "OP 6". */
		title?: string;
	} = $props();

	const MAX = 5;
	// The viewer always gets a visible chip.
	const ordered = $derived([
		...cursors.filter((c) => c.user_id === viewerId),
		...cursors.filter((c) => c.user_id !== viewerId)
	]);
	const shown = $derived(ordered.length > MAX ? ordered.slice(0, MAX - 1) : ordered);
	const hidden = $derived(ordered.slice(shown.length));

	let open = $state(false);
</script>

{#snippet chips()}
	{#each shown as c (c.user_id)}
		<Avatar
			user={{ id: c.user_id, name: c.name ?? c.initials, avatar_url: c.avatar_url }}
			size="xs"
			class={cn(
				c.user_id === viewerId && 'border-foreground/60 font-semibold',
				c.stale && 'opacity-50'
			)}
		/>
	{/each}
	{#if hidden.length}
		<span
			class="squircle inline-flex h-5 min-w-5 shrink-0 items-center justify-center border border-border bg-muted px-1 font-mono text-xs font-medium text-muted-foreground"
			title={hidden.map((c) => c.name ?? c.initials).join(', ')}>+{hidden.length}</span
		>
	{/if}
{/snippet}

{#if cursors.length && labor}
	<Popover.Root bind:open>
		<Popover.Trigger
			class="inline-flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
			aria-label="Time worked"
			onclick={(e: MouseEvent) => e.stopPropagation()}
		>
			{@render chips()}
		</Popover.Trigger>
		<Popover.Content
			class="w-72 gap-0 p-0"
			align="end"
			onclick={(e: MouseEvent) => e.stopPropagation()}
		>
			{@render times(labor)}
		</Popover.Content>
	</Popover.Root>
{:else if cursors.length}
	<span class="inline-flex items-center gap-1">{@render chips()}</span>
{/if}

{#snippet times(rows: DocLabor[])}
	{@const now = clock.now}
	{@const here = new Set(cursors.map((c) => c.user_id))}
	{@const people = [
		...rows.map((l) => ({ ...l, live: liveSeconds(l, now) })),
		// Clocked in before time was recorded: no row yet.
		...cursors
			.filter((c) => !rows.some((l) => l.user_id === c.user_id))
			.map((c) => ({
				user_id: c.user_id,
				name: c.name,
				avatar_url: c.avatar_url ?? null,
				since: null,
				live: 0
			}))
	].sort((a, b) => b.live - a.live)}
	<div
		class="flex items-center border-b border-border px-3 py-2 font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase"
	>
		<span class="flex-1">{title ? `Time · ${title}` : 'Time'}</span>
		<span>{people.length}</span>
	</div>
	<ul class="m-0 max-h-72 list-none overflow-y-auto p-0">
		{#each people as p (p.user_id)}
			<li
				class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm last:border-b-0"
			>
				<Avatar user={{ id: p.user_id, name: p.name, avatar_url: p.avatar_url }} size="xs" />
				<span class="min-w-0 flex-1 truncate">{p.name ?? '—'}</span>
				{#if here.has(p.user_id)}
					<Badge
						variant="outline"
						class="border-info/50 bg-info-muted font-mono tracking-wider text-info">IN</Badge
					>
				{/if}
				<span class="w-20 text-right font-mono text-xs tabular-nums"
					>{p.live || p.since ? workTime(p.live) : '—'}</span
				>
			</li>
		{/each}
	</ul>
	<div class="flex items-center border-t border-border px-3 py-2 font-mono text-xs font-semibold">
		<span class="flex-1 tracking-wider text-muted-foreground">TOTAL</span>
		<span class="tabular-nums">{workTime(people.reduce((n, p) => n + p.live, 0))}</span>
	</div>
{/snippet}
