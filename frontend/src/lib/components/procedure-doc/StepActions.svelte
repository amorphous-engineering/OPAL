<script lang="ts">
	// The move the open step is waiting on. Routine work has one action, COMPLETE: no dialog, no
	// signature row. A held step points at the issue that holds it instead. A declared sign-off acts
	// from its own table (SignoffTable).
	import { Button } from '#lib/components/ui/button/index.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import { isRoutine, type DocOp, type DocStep } from './types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const ctl = useDoc();

	const a = $derived(ctl.actions);
	const on = $derived(ctl.mode === 'execute' && ctl.active);
	const workable = $derived(step.status === 'pending' || step.status === 'in_progress');
	const slot = $derived(step.signoffs?.[0]);
	const held = $derived(step.complete_blockers.filter((b) => b.kind === 'nc' && b.issue_id));
	let busy = $state(false);

	async function complete() {
		if (!a.sign || busy) return;
		busy = true;
		try {
			await a.sign(step, 0);
		} finally {
			busy = false;
		}
	}
</script>

{#if on && (held.length || (workable && a.sign && slot && isRoutine(step, op)))}
	<div class="flex flex-wrap items-center gap-2" data-step-actions={step.order}>
		{#if held.length}
			{#each held as h (h.issue_id)}
				<Button size="xs" href={`/issues/${h.issue_id}`}>{h.issue_number}</Button>
			{/each}
		{:else if slot}
			<Button
				size="xs"
				disabled={!slot.can_sign || busy}
				class={slot.can_sign ? '' : 'cursor-not-allowed'}
				onclick={complete}>COMPLETE</Button
			>
			{#if !slot.can_sign}<GateReason blockers={slot.blockers} />{/if}
		{/if}
	</div>
{/if}
