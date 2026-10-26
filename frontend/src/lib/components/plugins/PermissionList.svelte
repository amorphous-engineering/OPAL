<script lang="ts">
	// Permissions of a manifest. With `before`, added entries are marked ADDED and
	// entries the new manifest drops are listed as REMOVED.
	import { DetailRow, DetailTable, State } from '#lib/components/opal/index.js';
	import type { PluginManifest } from '@opal/shared';

	type Perms = PluginManifest['permissions'];
	let { now, before = null }: { now: Perms; before?: Perms | null } = $props();

	const rows = (a: string[], b: string[] | undefined) => [
		...a.map((v) => ({ v, mark: b && !b.includes(v) ? 'added' : null })),
		...(b ?? []).filter((v) => !a.includes(v)).map((v) => ({ v, mark: 'removed' }))
	];
	const ops = $derived(rows(now.ops, before?.ops));
	const events = $derived(rows(now.events, before?.events));
</script>

{#snippet list(items: { v: string; mark: string | null }[])}
	{#if items.length === 0}
		<span class="text-muted-foreground">None</span>
	{:else}
		<ul class="grid gap-0.5">
			{#each items as it (it.v + it.mark)}
				<li class="flex items-center gap-2 font-mono text-xs">
					<span class={it.mark === 'removed' ? 'text-muted-foreground line-through' : ''}
						>{it.v}</span
					>
					{#if it.mark}<State
							value={it.mark}
							badge
							tone={it.mark === 'added' ? 'warn' : 'muted'}
						/>{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<DetailTable>
	<DetailRow label="Operations">{@render list(ops)}</DetailRow>
	<DetailRow label="Events">{@render list(events)}</DetailRow>
	<DetailRow label="Hooks">
		<span class="inline-flex items-center gap-2 font-mono text-xs">
			{now.hooks ? 'YES' : 'NO'}
			{#if before && before.hooks !== now.hooks}<State
					value={now.hooks ? 'added' : 'removed'}
					badge
					tone={now.hooks ? 'warn' : 'muted'}
				/>{/if}
		</span>
	</DetailRow>
</DetailTable>
