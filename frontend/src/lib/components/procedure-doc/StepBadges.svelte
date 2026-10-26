<script lang="ts">
	// What stops a step, as badges beside its title: held by a raised issue, a bound hold,
	// awaiting sign-off, waiting on another step. A finished step shows none (StepState marks it DONE).
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { outOfSpecFields } from './spec.js';
	import type { DocStep } from './types.js';

	let { step }: { step: DocStep } = $props();

	const done = $derived(['completed', 'signed_off', 'skipped'].includes(step.status));
	const raised = $derived(step.holds.filter((h) => h.kind === 'raised'));
	const bound = $derived(step.holds.filter((h) => h.kind === 'bound'));

	// A value that misses its spec stays flagged after the step is done.
	const off = $derived(outOfSpecFields(step.data_schema?.fields, step.data_captured));
	const error = 'border-error/50 bg-error-muted font-mono tracking-wider text-error';
	const warn = 'border-warn/50 bg-warn-muted font-mono tracking-wider text-warn';
	const muted = 'font-mono tracking-wider text-muted-foreground';
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
			class={warn}
			href={`/issues/${h.issue_id}`}
			title="Held until the issue is dispositioned"
			onclick={(e: MouseEvent) => e.stopPropagation()}>HELD · {h.issue_number}</Badge
		>
	{/each}
	{#each bound as h (h.issue_id)}
		<Badge
			variant="outline"
			class={warn}
			href={`/issues/${h.issue_id}`}
			title="Completion waits for the issue"
			onclick={(e: MouseEvent) => e.stopPropagation()}>HOLD · {h.issue_number}</Badge
		>
	{/each}
	{#if step.status === 'awaiting_signoff'}
		<Badge variant="outline" class={warn}>AWAITING SIGN-OFF</Badge>
	{:else if step.waiting && !step.holds.length}
		<Badge variant="outline" class={muted}>{step.waiting.replace(/^WAITING ON /, 'AFTER ')}</Badge>
	{/if}
{/if}
