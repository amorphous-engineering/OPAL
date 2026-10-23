<script lang="ts">
	// Title-bar actions of a step (or a leaf OP): SKIP while it is workable, inert
	// with the blockers' reason as its title; + ISSUE TICKET. Execute mode, active WO only.
	import { Button } from '#lib/components/ui/button/index.js';
	import { useDoc } from './controller.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();
	const ctl = useDoc();
	const a = $derived(ctl.actions);
	const on = $derived(ctl.mode === 'execute' && ctl.active);
	const workable = $derived(step.status === 'pending' || step.status === 'in_progress');
	const skipWhy = $derived(
		[...new Set(step.skip_blockers.map((b) => b.message))].join('; ') || undefined
	);
</script>

{#if on}
	<!-- The buttons sit inside the clickable title bar: keep clicks and keys from toggling it. -->
	<span
		class="flex shrink-0 items-center gap-1.5"
		role="presentation"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		{#if a.skip && workable}
			<Button
				size="xs"
				variant="outline"
				disabled={step.skip_blockers.length > 0}
				title={skipWhy}
				onclick={() => a.skip!(step)}>SKIP</Button
			>
		{/if}
		{#if a.raiseIssue}
			<Button size="xs" variant="outline" onclick={() => a.raiseIssue!(step)}>+ ISSUE TICKET</Button
			>
		{/if}
	</span>
{/if}
