<script lang="ts">
	// The completion stamp of a step: when and who, for a completed or skipped step.
	// What stops an open step shows as badges beside its title (StepBadges).
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
	{/if}
</span>
