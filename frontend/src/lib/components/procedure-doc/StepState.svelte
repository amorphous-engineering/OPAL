<script lang="ts">
	// The state cell of a step row: words in state colours, exactly one of
	// complete · skipped · held · awaiting sign-off · waiting · nothing.
	import { datetime, iso } from '#lib/format.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	// Completion stamp: local ISO date and minute, then who (name, initials as fallback).
	// The last signature is the completion when sign-offs exist.
	const last = $derived(
		[...(step.signoffs ?? [])]
			.filter((x) => x.signed_by && x.signed_at)
			.sort((x, y) => (x.signed_at! < y.signed_at! ? -1 : 1))
			.at(-1)
	);
	const stamp = $derived(last?.signed_at ?? step.completed?.at);
	const who = $derived(
		last?.signed_by?.name ?? step.completed?.by ?? step.completed?.initials ?? ''
	);
	const raised = $derived(step.holds.filter((h) => h.kind === 'raised'));
	const bound = $derived(step.holds.filter((h) => h.kind === 'bound'));
</script>

<span class="font-mono text-xs font-medium whitespace-nowrap">
	{#if step.status === 'completed' || step.status === 'signed_off'}
		<span
			class="inline-flex items-baseline gap-1.5 font-normal text-muted-foreground"
			title={iso(stamp)}
			><time datetime={iso(stamp)}>{datetime(stamp)}</time><span class="max-w-[9rem] truncate"
				>{who}</span
			></span
		>
	{:else if step.status === 'skipped'}
		<span class="inline-flex items-baseline gap-1.5 text-muted-foreground" title={iso(stamp)}
			>SKIPPED <time datetime={iso(stamp)}>{datetime(stamp)}</time><span
				class="max-w-[9rem] truncate">{who}</span
			></span
		>
	{:else if raised.length}
		<span class="text-warn"
			>HELD BY
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
		<span class="text-muted-foreground">{step.waiting.replace(/^WAITING ON /, 'AFTER ')}</span>
	{/if}
</span>
