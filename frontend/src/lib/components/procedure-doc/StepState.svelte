<script lang="ts">
	// A finished step: DONE (or SKIPPED) as the first badge right of its title. When and who
	// sit in the tooltip. What stops an open step shows as badges after it (StepBadges).
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { iso } from '#lib/format.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

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
	const tip = $derived([iso(stamp), who].filter(Boolean).join(' · ') || undefined);
</script>

{#if step.status === 'completed' || step.status === 'signed_off'}
	<Badge
		variant="outline"
		class="border-ok/50 bg-ok-muted font-mono tracking-wider text-ok"
		title={tip}>DONE</Badge
	>
{:else if step.status === 'skipped'}
	<Badge variant="outline" class="font-mono tracking-wider text-muted-foreground" title={tip}
		>SKIPPED</Badge
	>
{/if}
