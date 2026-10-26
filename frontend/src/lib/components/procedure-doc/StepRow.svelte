<script lang="ts">
	// One step: a single dense line (number, title, who, evidence, state) that
	// expands into its body. Expanded until complete; the host decides `open`.
	// In author mode the title is a field and the line carries structure tools.
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import CursorChips from './CursorChips.svelte';
	import StepBody from './StepBody.svelte';
	import StepBadges from './StepBadges.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import StepState from './StepState.svelte';
	import StepTitleActions from './StepTitleActions.svelte';
	import AuthorChips from './author/AuthorChips.svelte';
	import RowTools from './author/RowTools.svelte';
	import SaveBadge from './author/SaveBadge.svelte';
	import TitleInput from './author/TitleInput.svelte';
	import { dragOver, dropHere, dropMarker } from './author/dnd.js';
	import { isBlocked, isTerminal, type DocOp, type DocStep } from './types.js';

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
	// The one accent on the page: the next thing to do.
	const current = $derived(ctl.mode === 'execute' && ctl.currentOrder === step.order);
	const nAtt = $derived(step.attachments.length);
	const nNote = $derived(step.notes.length);
	const countBadge = 'font-mono tracking-wider text-muted-foreground';
</script>

<div
	id={`step-${step.order}`}
	data-order={step.order}
	role={au ? 'group' : undefined}
	data-status={step.status}
	data-drop-row={au ? '' : undefined}
	class={cn(
		'group/row border-b border-border last:border-b-0',
		current && 'shadow-[inset_2px_0_0_var(--info)]',
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
		<span class="w-10 shrink-0 font-mono text-xs font-medium tabular-nums">{step.number}</span>
		{#if au}
			<TitleInput {step} />
		{:else}
			<span class={cn('min-w-0 truncate text-sm', step.status === 'skipped' && 'line-through')}
				>{step.title}</span
			>
			<StepState {step} />
			<StepBadges {step} />
		{/if}
		{#if nNote}
			<Badge variant="outline" class={countBadge} title="Operator notes">NOTES · {nNote}</Badge>
		{/if}
		{#if nAtt}
			{#if ctl.actions.showEvidence}
				<Badge
					variant="outline"
					class={cn(countBadge, 'cursor-pointer hover:text-foreground')}
					href="#evidence"
					title="Attachments"
					onclick={(e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						ctl.actions.showEvidence?.(step);
					}}>FILES · {nAtt}</Badge
				>
			{:else}
				<Badge variant="outline" class={countBadge} title="Attachments">FILES · {nAtt}</Badge>
			{/if}
		{/if}
		{#if !au}<span class="flex-1"></span>{/if}
		{#if au}<AuthorChips {step} />{/if}
		<CursorChips cursors={step.cursors} viewerId={ctl.viewerId} />
		{#if au}
			<SaveBadge {step} quiet />
			<RowTools {step} {op} isOp={false} />
		{:else}
			<StepTitleActions {step} />
		{/if}
	</div>
	{#if open && !bodyless}
		<div class="border-t border-border/60 bg-background pl-8"><StepBody {step} {op} /></div>
	{/if}
</div>
