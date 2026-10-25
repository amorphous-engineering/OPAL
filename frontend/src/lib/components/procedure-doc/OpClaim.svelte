<script lang="ts">
	// CLOCK IN / CLOCK OUT on an OP header (a claim): claims are per OP (one operator works an
	// OP). Absent while the OP is gated by a dependency or a redline (the header
	// says what it waits on); unfinished sub-steps never gate it. Off the OP being
	// worked it shows only on hover or keyboard focus, so headers stay quiet.
	import { Button } from '#lib/components/ui/button/index.js';
	import { useDoc } from './controller.js';
	import { cn } from '#lib/utils.js';
	import { isTerminal, type DocOp } from './types.js';

	let { op, prominent = true }: { op: DocOp; prominent?: boolean } = $props();
	const ctl = useDoc();

	const claimed = $derived(ctl.claimedOrder === op.order);
	const show = $derived(
		ctl.mode === 'execute' &&
			ctl.active &&
			!!ctl.actions.claim &&
			!isTerminal(op.status) &&
			op.status !== 'awaiting_signoff'
	);
	const gates = $derived(
		op.step.complete_blockers.filter((b) => ['sequence', 'dependency', 'redline'].includes(b.kind))
	);
	let busy = $state(false);

	async function toggle(e: MouseEvent) {
		e.stopPropagation();
		if (busy) return;
		busy = true;
		try {
			await (claimed ? ctl.actions.release?.() : ctl.actions.claim?.(op.step));
		} finally {
			busy = false;
		}
	}
</script>

{#if show && (!gates.length || claimed)}
	<Button
		size="xs"
		variant={claimed ? 'outline' : 'default'}
		class={cn(
			!prominent && !claimed && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
		)}
		aria-pressed={claimed}
		title={claimed ? `Clock out of OP ${op.number}` : `Clock in to OP ${op.number}`}
		disabled={busy}
		onclick={toggle}>{claimed ? 'CLOCK OUT' : 'CLOCK IN'}</Button
	>
{/if}
