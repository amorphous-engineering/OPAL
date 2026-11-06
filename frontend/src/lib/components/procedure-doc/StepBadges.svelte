<script lang="ts">
	// What stops a step, as badges beside its title: held by a raised issue, a bound hold,
	// awaiting sign-off. Waiting on another step is plain text. A finished step shows none (StepStamp).
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { outOfSpecFields } from './spec.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	const done = $derived(['completed', 'signed_off', 'skipped'].includes(step.status));
	const raised = $derived(step.holds.filter((h) => h.kind === 'raised'));
	const bound = $derived(step.holds.filter((h) => h.kind === 'bound'));

	// A value that misses its spec stays flagged after the step is done.
	const off = $derived(outOfSpecFields(step.data_schema?.fields, step.data_captured));
	const error =
		'border-error-fill bg-error-fill font-mono dark:bg-error-fill font-bold tracking-wider text-error-on';
	const warn =
		'border-warn-fill bg-warn-fill font-mono dark:bg-warn-fill font-bold tracking-wider text-warn-on';
</script>

{#if off.length}
	<Badge variant="outline" class={error} title={off.map((f) => f.label ?? f.name).join(', ')}
		>OUT OF SPEC</Badge
	>
{/if}
{#if !done}
	{#each raised as h (h.issue_id)}
		<Badge
			variant="outline"
			class={error}
			href={`/issues/${h.issue_id}`}
			title="Held until the issue is dispositioned"
			onclick={(e: MouseEvent) => e.stopPropagation()}>HELD · {h.issue_number}</Badge
		>
	{/each}
	{#each bound as h (h.issue_id)}
		<Badge
			variant="outline"
			class={error}
			href={`/issues/${h.issue_id}`}
			title="Completion waits for the issue"
			onclick={(e: MouseEvent) => e.stopPropagation()}>HOLD · {h.issue_number}</Badge
		>
	{/each}
	{#if step.status === 'awaiting_signoff'}
		<Badge variant="outline" class={warn}>AWAITING SIGN-OFF</Badge>
	{:else if step.waiting && !step.holds.length}
		<span class="font-mono text-xs whitespace-nowrap text-muted-foreground"
			>{step.waiting.replace(/^WAITING ON /, 'AFTER ')}</span
		>
	{/if}
{/if}
