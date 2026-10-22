<script lang="ts">
	// The control row of a step (or of an OP with sub-steps). Every control is
	// either active or inert with its reason beside it, never silently absent:
	// the server computed the blockers, this only renders them.
	import { Button } from '#lib/components/ui/button/index.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import type { DocOp, DocStep } from './types.js';

	let { step, op, scope = 'step' }: { step: DocStep; op: DocOp; scope?: 'step' | 'op' } = $props();

	const ctl = useDoc();
	const a = $derived(ctl.actions);

	const workable = $derived(
		ctl.active && (step.status === 'pending' || step.status === 'in_progress')
	);
	const awaiting = $derived(ctl.active && step.status === 'awaiting_signoff');
	let busy = $state(false);

	async function run(fn: (() => Promise<void>) | undefined) {
		if (!fn || busy) return;
		busy = true;
		try {
			await fn();
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-2" data-actions={step.order}>
	{#if scope === 'step'}
		{#if a.attach}
			<Button size="xs" variant="outline" onclick={() => a.attach!(step)}>ATTACH</Button>
		{/if}
		{#if a.raiseIssue && ctl.active}
			<Button size="xs" variant="outline" onclick={() => a.raiseIssue!(step)}>RAISE ISSUE</Button>
		{/if}
	{/if}
	{#if a.redline && ctl.active && op.open_ncs.length && !op.is_ad_hoc && (scope === 'op' || op.steps.length === 0)}
		<Button size="xs" variant="outline" onclick={() => a.redline!(op)}>+ REDLINE</Button>
	{/if}
	{#if scope === 'step'}
		{#if a.skip && workable}
			{#if step.skip_blockers.length}
				<span class="inline-flex items-center gap-2">
					<Button size="xs" variant="outline" disabled>SKIP</Button>
					<GateReason blockers={step.skip_blockers} />
				</span>
			{:else}
				<Button size="xs" variant="outline" onclick={() => a.skip!(step)}>SKIP</Button>
			{/if}
		{/if}
	{/if}
	{#if a.signoff && awaiting}
		<Button size="xs" disabled={busy} onclick={() => run(() => a.signoff!(step))}>SIGN OFF</Button>
	{:else if scope === 'step' && a.complete && workable}
		{#if step.complete_blockers.length}
			<span class="inline-flex items-center gap-2">
				<Button size="xs" disabled>COMPLETE</Button>
				<GateReason blockers={step.complete_blockers} />
			</span>
		{:else}
			<Button size="xs" disabled={busy} onclick={() => run(() => a.complete!(step))}
				>COMPLETE</Button
			>
		{/if}
	{/if}
</div>
