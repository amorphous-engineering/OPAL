<script lang="ts">
	// One step: a single dense line (number, title, who, evidence, state) that
	// expands into its body. Expanded until complete; the host decides `open`.
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import CursorChips from './CursorChips.svelte';
	import RoleChip from './RoleChip.svelte';
	import StepBody from './StepBody.svelte';
	import StepState from './StepState.svelte';
	import { isTerminal, type DocOp, type DocStep } from './types.js';

	let {
		step,
		op,
		bodyless = false
	}: {
		step: DocStep;
		op: DocOp;
		/** Render only the line (the OP card shows the body for a leaf OP itself). */
		bodyless?: boolean;
	} = $props();

	const ctl = useDoc();
	const terminal = $derived(isTerminal(step.status));
	const key = $derived(`step:${step.order}`);
	const open = $derived(ctl.isOpen(key, terminal));
	const focused = $derived(ctl.focusedOrder === step.order);
	const claimed = $derived(ctl.claimedOrder === step.order);
	const nAtt = $derived(step.attachments.length);
	const nNote = $derived(step.notes.length);
	const opHeld = $derived(op.holds.length > 0);
</script>

<div
	id={`step-${step.order}`}
	data-order={step.order}
	data-status={step.status}
	class={cn(
		'border-b border-border last:border-b-0',
		claimed && 'shadow-[inset_2px_0_0_var(--primary)]',
		focused && 'bg-accent/40 outline outline-1 -outline-offset-1 outline-ring/60'
	)}
>
	<div
		class={cn(
			'flex min-h-8 cursor-pointer items-center gap-2 px-3 py-1 hover:bg-accent/50',
			terminal && 'text-muted-foreground'
		)}
		role="button"
		tabindex="-1"
		aria-expanded={open}
		onclick={() => {
			ctl.setFocus(step.order);
			ctl.toggle(key, terminal);
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				ctl.toggle(key, terminal);
			}
		}}
	>
		<span
			class="w-3 shrink-0 text-center font-mono text-[11px] text-muted-foreground"
			aria-hidden="true">{open ? '▾' : '▸'}</span
		>
		<span class="w-10 shrink-0 font-mono text-xs font-medium tabular-nums">{step.number}</span>
		<span class={cn('min-w-0 flex-1 truncate text-sm', step.status === 'skipped' && 'line-through')}
			>{step.title}</span
		>
		<RoleChip role={step.role} />
		{#if step.caution}
			<span
				class="inline-flex h-5 items-center border border-error/50 px-1.5 font-mono text-[11px] font-medium text-error"
				title={step.caution}>CAUTION</span
			>
		{/if}
		<CursorChips cursors={step.cursors} viewerId={ctl.viewerId} />
		{#if nAtt || nNote}
			<span class="font-mono text-[11px] whitespace-nowrap text-muted-foreground">
				{#if nAtt}
					{#if ctl.actions.showEvidence}
						<button
							type="button"
							class="hover:text-foreground hover:underline"
							title={`${nAtt} attachment(s)`}
							onclick={(e) => {
								e.stopPropagation();
								ctl.actions.showEvidence?.(step);
							}}>{nAtt} ATT</button
						>
					{:else}{nAtt} ATT{/if}
				{/if}
				{#if nAtt && nNote}<span> · </span>{/if}
				{#if nNote}<span title="Operator notes">{nNote} NOTE{nNote > 1 ? 'S' : ''}</span>{/if}
			</span>
		{/if}
		<span class="min-w-24 shrink-0 text-right"><StepState {step} {opHeld} /></span>
	</div>
	{#if open && !bodyless}
		<div class="border-t border-border/60 bg-background pl-8"><StepBody {step} {op} /></div>
	{/if}
</div>
