<script lang="ts">
	// One step: a single dense line (number, title, what stops it, evidence, stamp) that expands
	// into its body. The host decides `open`. Actions live in the body, not on the line.
	// In author mode the title is a field and the line carries structure tools.
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import Check from 'phosphor-svelte/lib/Check';
	import { Button } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import GateReason from './GateReason.svelte';
	import CursorChips from './CursorChips.svelte';
	import StepBody from './StepBody.svelte';
	import StepBadges from './StepBadges.svelte';
	import StepStamp from './StepStamp.svelte';
	import AuthorChips from './author/AuthorChips.svelte';
	import RowTools from './author/RowTools.svelte';
	import SaveBadge from './author/SaveBadge.svelte';
	import TitleInput from './author/TitleInput.svelte';
	import { dragOver, dropHere, dropMarker } from './author/dnd.js';
	import { isBlocked, isShort, isTerminal, type DocOp, type DocStep } from './types.js';

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
	const au = $derived(ctl.mode === 'author' ? ctl.author : undefined);
	const terminal = $derived(isTerminal(step.status));
	const key = $derived(`step:${step.order}`);
	// A step with nothing to act on yet (held, waiting) folds to its line.
	const blocked = $derived(ctl.mode === 'execute' && isBlocked(step));
	const open = $derived(ctl.isOpen(key, terminal, blocked));
	const focused = $derived(ctl.focusedOrder === step.order);
	// You are here: the next thing to do.
	const current = $derived(ctl.mode === 'execute' && ctl.currentOrder === step.order);
	const nAtt = $derived(step.attachments.length);
	const nNote = $derived(step.notes.length);
	const count = 'shrink-0 font-mono text-xs whitespace-nowrap text-muted-foreground';

	// A short step (title and nothing else) completes from one tick on its row. The tick is the
	// primary key only on the current step. Elsewhere it shows when it will work, and when it will
	// not it shows, inert with the reason, only on the step the work is waiting on.
	const slot = $derived(step.signoffs?.[0]);
	const workable = $derived(step.status === 'pending' || step.status === 'in_progress');
	const short = $derived(ctl.mode === 'execute' && isShort(step, op));
	const canTick = $derived(
		short && ctl.active && workable && !!ctl.actions.sign && !!slot && (slot.can_sign || current)
	);
	// Steps of an OP that is gated as a whole: the OP's row already says what it waits on.
	const quietWait = $derived(
		ctl.active && op.waiting_on_ops.length > 0 && step.waiting === op.step.waiting
	);
	let busy = $state(false);

	async function tick() {
		if (!ctl.actions.sign || busy) return;
		busy = true;
		try {
			await ctl.actions.sign(step, 0);
		} finally {
			busy = false;
		}
	}
</script>

<div
	id={`step-${step.order}`}
	data-order={step.order}
	role={au ? 'group' : undefined}
	data-status={step.status}
	data-drop-row={au ? '' : undefined}
	class={cn(
		'group/row border-b border-dotted last:border-b-0',
		current && 'border-y border-solid',
		focused && 'bg-accent/40 outline outline-1 -outline-offset-1 outline-foreground/25',
		au && dropMarker(au, step.order),
		au?.drag.id === step.order && 'opacity-40'
	)}
	ondragover={au ? (e) => dragOver(au, e, step.order) : undefined}
	ondrop={au ? (e) => dropHere(au, e, step.order) : undefined}
>
	<div
		class={cn(
			'sticky top-[calc(--spacing(11)+var(--op-head))] z-10 flex min-h-8 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 bg-card px-3 py-1 hover:bg-accent lg:top-(--op-head)',
			(terminal || blocked) && 'text-muted-foreground'
		)}
		role="button"
		tabindex="-1"
		aria-expanded={open}
		onclick={() => {
			ctl.setFocus(step.order);
			ctl.toggle(key, terminal, blocked);
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				ctl.toggle(key, terminal, blocked);
			}
		}}
	>
		<CaretRight
			weight="bold"
			class={cn(
				'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
				open && 'rotate-90'
			)}
			aria-hidden="true"
		/>
		<span class="w-10 shrink-0 font-mono text-xs font-medium tabular-nums"
			><span class={cn(current && '-ml-1 bg-foreground px-1 py-px font-semibold text-background')}
				>{step.number}</span
			></span
		>
		{#if au}
			<TitleInput {step} />
		{:else}
			<span
				class={cn(
					// A short step's title is the whole step, so it wraps in place instead of truncating.
					short ? 'min-w-0 flex-1 basis-64 text-sm' : 'min-w-0 truncate text-sm',
					terminal && 'line-through',
					current && 'font-semibold'
				)}>{step.title}</span
			>
			<StepBadges {step} {quietWait} />
		{/if}
		{#if nNote}
			<span class={count} title="Operator notes">{nNote} {nNote === 1 ? 'NOTE' : 'NOTES'}</span>
		{/if}
		{#if nAtt}
			{#if ctl.actions.showEvidence}
				<a
					class={cn(count, 'hover:text-foreground')}
					href="#evidence"
					title="Attachments"
					onclick={(e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						ctl.actions.showEvidence?.(step);
					}}>{nAtt} {nAtt === 1 ? 'FILE' : 'FILES'}</a
				>
			{:else}
				<span class={count} title="Attachments">{nAtt} {nAtt === 1 ? 'FILE' : 'FILES'}</span>
			{/if}
		{/if}
		{#if !au && !short}<span class="flex-1"></span>{/if}
		{#if au}<AuthorChips {step} />{/if}
		<CursorChips cursors={step.cursors} viewerId={ctl.viewerId} />
		{#if au}
			<SaveBadge {step} quiet />
			<RowTools {step} {op} isOp={false} />
		{:else}
			{#if canTick && slot}
				{#if !slot.can_sign}<GateReason blockers={slot.blockers} />{/if}
				<span
					class="shrink-0"
					role="presentation"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => e.stopPropagation()}
					><Button
						size="icon"
						variant={current ? 'default' : 'outline'}
						disabled={!slot.can_sign || busy}
						aria-label={`Complete ${step.number}`}
						title="Complete"
						data-tick={step.order}
						onclick={tick}><Check weight="bold" /></Button
					></span
				>
			{/if}
			<StepStamp {step} />
		{/if}
	</div>
	{#if open && !bodyless}
		<div class="bg-background"><StepBody {step} {op} /></div>
	{/if}
</div>
