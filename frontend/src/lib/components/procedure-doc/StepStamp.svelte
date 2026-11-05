<script lang="ts">
	// A finished step as paper shows it: initials and time beside a struck title. A declared
	// sign-off lists each signer. What stops an open step shows as badges instead (StepBadges).
	import { dayTime, initials, iso } from '#lib/format.js';
	import { isTerminal, type DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	const signers = $derived(
		(step.signoffs ?? [])
			.filter((s) => s.signed_by && s.signed_at)
			.sort((a, b) => (a.signed_at! < b.signed_at! ? -1 : 1))
	);
	const at = $derived(signers.at(-1)?.signed_at ?? step.completed?.at);
	const who = $derived(
		signers.length
			? signers.map((s) => initials(s.signed_by!.name)).join(' ')
			: (step.completed?.initials ?? '')
	);
	const names = $derived(
		signers.length ? signers.map((s) => s.signed_by!.name).join(', ') : (step.completed?.by ?? '')
	);
	const tip = $derived([iso(at), names].filter(Boolean).join(' · ') || undefined);
</script>

{#if isTerminal(step.status)}
	<span
		class="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground"
		title={tip}
		data-stamp
	>
		{#if step.status === 'skipped'}SKIPPED{/if}
		{who}
		{#if at}<time datetime={iso(at)}>{dayTime(at)}</time>{/if}
	</span>
{/if}
