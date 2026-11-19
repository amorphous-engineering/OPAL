<script lang="ts">
	// A finished step as paper shows it: initials and time beside a struck title. A declared
	// sign-off lists each signer, and WAIVED for a slot its one person set aside (the reason is in
	// the tooltip and the sign-off table). What stops an open step shows as badges instead (StepBadges).
	import { waiverLine } from '@opal/shared';
	import { datetime, dayTime, initials, iso } from '#lib/format.js';
	import { isTerminal, type DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	const signers = $derived(
		(step.signoffs ?? [])
			.filter((s) => s.signed_by && s.signed_at)
			.sort((a, b) => (a.signed_at! < b.signed_at! ? -1 : 1))
	);
	const waived = $derived((step.signoffs ?? []).filter((s) => s.waived));
	const lastWaiver = $derived(
		waived
			.map((s) => s.waived!.at)
			.sort((a, b) => (a < b ? -1 : 1))
			.at(-1)
	);
	const lastSigned = $derived(signers.at(-1)?.signed_at);
	const at = $derived(
		(lastWaiver && (!lastSigned || lastWaiver > lastSigned) ? lastWaiver : lastSigned) ??
			step.completed?.at
	);
	const who = $derived(
		signers.length
			? signers.map((s) => initials(s.signed_by!.name)).join(' ')
			: (step.completed?.initials ?? '')
	);
	const names = $derived(
		signers.length ? signers.map((s) => s.signed_by!.name).join(', ') : (step.completed?.by ?? '')
	);
	const tip = $derived(
		[
			iso(at),
			names,
			...waived.map((s) =>
				waiverLine(s.label, {
					by: s.waived!.by?.name ?? null,
					at: datetime(s.waived!.at),
					reason: s.waived!.reason
				})
			)
		]
			.filter(Boolean)
			.join(' · ') || undefined
	);
</script>

{#if isTerminal(step.status)}
	<span
		class="shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground"
		title={tip}
		data-stamp
	>
		{#if step.status === 'skipped'}SKIPPED{/if}
		{who}
		{#if waived.length}WAIVED{/if}
		{#if at}<time datetime={iso(at)}>{dayTime(at)}</time>{/if}
	</span>
{/if}
