<script lang="ts">
	// CLAIM / CLAIMED on an OP header: claims are per OP (one operator works an
	// OP). Inert with its reason while the OP is gated by a dependency or a
	// redline; unfinished sub-steps never gate it — working them is the point.
	import { Button } from '#lib/components/ui/button/index.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import { isTerminal, type DocOp } from './types.js';

	let { op }: { op: DocOp } = $props();
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

{#if show}
	{#if gates.length && !claimed}
		<span
			class="inline-flex items-center gap-2"
			role="presentation"
			onclick={(e) => e.stopPropagation()}
		>
			<Button size="xs" variant="outline" disabled>CLAIM</Button>
			<GateReason blockers={gates} />
		</span>
	{:else}
		<Button
			size="xs"
			variant={claimed ? 'default' : 'outline'}
			aria-pressed={claimed}
			title={claimed
				? `Release OP ${op.number}`
				: `Claim OP ${op.number}: mark it as yours to work`}
			disabled={busy}
			onclick={toggle}>{claimed ? 'CLAIMED' : 'CLAIM'}</Button
		>
	{/if}
{/if}
