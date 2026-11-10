<script lang="ts">
	// The checklist lives in OPAL. Launch Control shows one line: which work order, which step the
	// crew is on there, and a way to open it. Nothing here completes a step.
	import { opalHref } from '#lib/opal/link.js';
	import type { LaunchSim } from '#lib/launch/sim.svelte.js';

	let { sim }: { sim: LaunchSim } = $props();

	const cur = $derived(sim.current);
	const done = $derived(sim.steps.filter((s) => s.doneBy).length);
	const last = $derived([...sim.steps].reverse().find((s) => s.doneBy));
</script>

<div
	class="flex flex-wrap items-center gap-x-3 gap-y-1 border border-border bg-card px-3 py-1.5 text-sm"
>
	<span class="label text-foreground">OPAL</span>
	<a
		class="font-mono text-xs font-medium text-info hover:underline"
		href={opalHref('/executions?q=WO-0041')}
		target="_blank"
		rel="noopener">WO-0041</a
	>
	<a
		class="font-mono text-xs text-info hover:underline"
		href={opalHref('/procedures?q=PROC-0012')}
		target="_blank"
		rel="noopener">PROC-0012 rev C</a
	>
	<span class="font-mono text-xs text-quiet">{done}/{sim.steps.length}</span>
	{#if cur}
		<span class="min-w-0 truncate">
			<span class="font-mono text-xs font-semibold">STEP {cur.n}</span>
			{cur.title}
		</span>
	{:else}
		<span class="font-mono text-xs text-ok">COMPLETE</span>
	{/if}
	{#if last}
		<span class="font-mono text-xs text-quiet max-[900px]:hidden"
			>Last: {last.n} {last.doneBy} {last.doneAt?.slice(11, 19)}Z</span
		>
	{/if}
	<a
		class="ml-auto font-mono text-xs font-medium tracking-wide text-info hover:underline"
		href={opalHref('/executions?q=WO-0041')}
		target="_blank"
		rel="noopener">OPEN IN OPAL</a
	>
</div>
