<script lang="ts">
	// FAA AC 25.1322-1 hierarchy: warning (red), caution (amber), advisory (neither red nor green).
	import type { AlertLevel, LaunchSim } from '#lib/launch/sim.svelte.js';
	import EmptyLine from '#lib/components/opal/EmptyLine.svelte';
	import Section from '#lib/components/opal/Section.svelte';
	import { cn } from '#lib/utils.js';

	let { sim }: { sim: LaunchSim } = $props();

	const RANK: Record<AlertLevel, number> = { warning: 0, caution: 1, advisory: 2 };
	const BLOCK: Record<AlertLevel, string> = {
		warning: 'border-error-fill bg-error-fill text-error-on',
		caution: 'border-warn-fill bg-warn-fill text-warn-on',
		advisory: 'border-dotted border-foreground text-foreground'
	};

	const rows = $derived(
		[...sim.alerts].sort((a, b) => RANK[a.level] - RANK[b.level] || b.at.localeCompare(a.at))
	);
	const clock = (iso: string) => iso.slice(11, 19) + 'Z';
</script>

<Section title="Alerts" count={rows.length}>
	{#if rows.length === 0}
		<EmptyLine label="Alerts" />
	{:else}
		<ul role="log" aria-live="polite" aria-label="Alerts">
			{#each rows as a (a.id)}
				<li
					class={cn(
						'flex items-center gap-3 border-b border-dotted border-border px-3 py-1.5 text-sm last:border-b-0',
						!a.acked && 'font-semibold'
					)}
				>
					<span
						class={cn(
							'inline-block w-20 shrink-0 border px-1.5 text-center font-mono text-xs tracking-wide uppercase',
							BLOCK[a.level]
						)}>{a.level}</span
					>
					<span class="min-w-0 flex-1">{a.text}</span>
					<span class="mono shrink-0 text-xs font-normal text-quiet">{clock(a.at)}</span>
					{#if a.acked}
						<span class="mono shrink-0 text-xs font-normal text-quiet">ACK</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Section>
