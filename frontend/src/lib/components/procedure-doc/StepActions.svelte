<script lang="ts">
	// What the open step offers. Routine work has one primary action, COMPLETE: no dialog, no
	// signature row. A held step points at the issue that holds it instead, and a declared sign-off
	// acts from its own table (SignoffTable). SKIP and + ISSUE live here, so they exist only on a
	// step someone has open. SKIP asks for its reason in place. The row stays on screen when a step
	// runs long, so nobody scrolls to reach the move the step is waiting on.
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import { isRoutine, isTerminal, type DocOp, type DocStep } from './types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const ctl = useDoc();

	const a = $derived(ctl.actions);
	const on = $derived(ctl.mode === 'execute' && ctl.active);
	const workable = $derived(step.status === 'pending' || step.status === 'in_progress');
	const slot = $derived(step.signoffs?.[0]);
	const held = $derived(step.complete_blockers.filter((b) => b.kind === 'nc' && b.issue_id));
	const completes = $derived(workable && !!a.sign && !!slot && isRoutine(step, op));
	const canSkip = $derived(workable && !!a.skip && step.skip_blockers.length === 0);
	const issueHref = $derived(isTerminal(step.status) ? undefined : a.issueHref?.(step));

	let busy = $state(false);
	let skipping = $state(false);
	let reason = $state('');

	async function complete() {
		if (!a.sign || busy) return;
		busy = true;
		try {
			await a.sign(step, 0);
		} finally {
			busy = false;
		}
	}

	async function skip(e: SubmitEvent) {
		e.preventDefault();
		if (!a.skip || busy || !reason.trim()) return;
		busy = true;
		try {
			if ((await a.skip(step, reason.trim())) !== false) {
				skipping = false;
				reason = '';
			}
		} finally {
			busy = false;
		}
	}
</script>

{#if on && (held.length || completes || canSkip || issueHref)}
	<div
		class="sticky bottom-6 z-[5] -mx-3 -mb-2 grid grid-cols-1 gap-2 border-t border-dotted bg-background px-3 py-1.5 lg:-bottom-4"
		data-step-actions={step.order}
	>
		<div class="flex flex-wrap items-center gap-2">
			{#if held.length}
				{#each held as h (h.issue_id)}
					<Button href={`/issues/${h.issue_id}`}>{h.issue_number}</Button>
				{/each}
			{:else if completes && slot}
				<Button
					disabled={!slot.can_sign || busy}
					class={slot.can_sign ? 'px-3 font-bold' : 'cursor-not-allowed px-3 font-bold'}
					onclick={complete}>COMPLETE</Button
				>
				{#if !slot.can_sign}<GateReason blockers={slot.blockers} />{/if}
			{/if}
			{#if canSkip && !skipping}
				<Button variant="outline" onclick={() => (skipping = true)}>SKIP</Button>
			{/if}
			{#if issueHref}
				<Button variant="outline" href={issueHref} target="_blank" rel="noopener">+ ISSUE</Button>
			{/if}
		</div>
		{#if skipping}
			<form class="flex max-w-xl flex-wrap items-center gap-2" onsubmit={skip}>
				<Input
					class="h-7 min-w-48 flex-1"
					aria-label="Skip reason"
					placeholder="Reason"
					required
					maxlength={2000}
					autofocus
					bind:value={reason}
				/>
				<Button type="submit" disabled={busy || !reason.trim()}>SKIP STEP</Button>
				<Button variant="ghost" onclick={() => (skipping = false)}>CANCEL</Button>
			</form>
		{/if}
	</div>
{/if}
