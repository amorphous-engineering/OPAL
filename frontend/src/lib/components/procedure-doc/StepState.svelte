<script lang="ts">
	// The state cell of a step row: words in state colours, exactly one of
	// complete · skipped · held · awaiting sign-off · waiting · nothing.
	import { datetime, iso } from '#lib/format.js';
	import type { DocStep } from './types.js';

	let { step, opHeld = false }: { step: DocStep; opHeld?: boolean } = $props();

	const hm = (v: string | null | undefined) => (v ? datetime(v).slice(11) : '');
	const raised = $derived(step.holds.filter((h) => h.kind === 'raised'));
	const bound = $derived(step.holds.filter((h) => h.kind === 'bound'));
</script>

<span class="font-mono text-xs font-medium whitespace-nowrap">
	{#if step.status === 'completed' || step.status === 'signed_off'}
		<span class="text-ok" title={iso(step.completed?.at)}
			>{step.completed?.initials ?? ''} {hm(step.completed?.at)}</span
		>
	{:else if step.status === 'skipped'}
		<span class="text-muted-foreground">SKIPPED {step.completed?.initials ?? ''}</span>
	{:else if raised.length}
		<span class="text-warn"
			>HELD
			{#each raised as h, i (h.issue_id)}
				{#if i > 0},
				{/if}<a
					class="underline"
					href={`/issues/${h.issue_id}`}
					onclick={(e) => e.stopPropagation()}>{h.issue_number}</a
				>{/each}</span
		>
	{:else if bound.length}
		<span class="text-warn"
			>HOLD
			{#each bound as h, i (h.issue_id)}
				{#if i > 0},
				{/if}<a
					class="underline"
					href={`/issues/${h.issue_id}`}
					onclick={(e) => e.stopPropagation()}>{h.issue_number}</a
				>{/each}</span
		>
	{:else if step.status === 'awaiting_signoff'}
		<span class="text-warn">AWAITING SIGN-OFF</span>
	{:else if step.waiting}
		<span class="text-warn">{step.waiting}</span>
	{:else if opHeld && step.status === 'pending'}
		<span class="text-warn">OP ON HOLD</span>
	{/if}
</span>
