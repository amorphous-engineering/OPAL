<script lang="ts">
	// One OP: a card with a header bar (number, title, flags, progress, holds)
	// over its steps. An OP without sub-steps is its own single step and shows
	// that step's body directly. Expanded until complete.
	import { Button } from '#lib/components/ui/button/index.js';
	import { markdown } from '#lib/markdown.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import CautionBlock from './CautionBlock.svelte';
	import CursorChips from './CursorChips.svelte';
	import OpClaim from './OpClaim.svelte';
	import RoleChip from './RoleChip.svelte';
	import StepActions from './StepActions.svelte';
	import StepBody from './StepBody.svelte';
	import StepRow from './StepRow.svelte';
	import StepState from './StepState.svelte';
	import AuthorChips from './author/AuthorChips.svelte';
	import CautionEditor from './author/CautionEditor.svelte';
	import MarkdownEditor from './author/MarkdownEditor.svelte';
	import RowTools from './author/RowTools.svelte';
	import SaveBadge from './author/SaveBadge.svelte';
	import StepProps from './author/StepProps.svelte';
	import TitleInput from './author/TitleInput.svelte';
	import { dragOver, dropHere, dropMarker } from './author/dnd.js';
	import { isBlocked, isTerminal, type DocOp } from './types.js';

	let { op }: { op: DocOp } = $props();
	const ctl = useDoc();

	const au = $derived(ctl.mode === 'author' ? ctl.author : undefined);
	const leaf = $derived(op.steps.length === 0);
	const terminal = $derived(isTerminal(op.status));
	const key = $derived(`op:${op.order}`);
	// Fold what cannot be acted on yet: a leaf OP that is held or waiting, an OP
	// waiting on another OP or a redline. Unfinished sub-steps never fold an OP.
	const blocked = $derived(
		ctl.mode === 'execute' &&
			(leaf
				? isBlocked(op.step)
				: !terminal &&
					op.step.complete_blockers.some((b) => b.kind === 'dependency' || b.kind === 'redline'))
	);
	const open = $derived(ctl.isOpen(key, terminal, blocked));
	const focused = $derived(ctl.focusedOrder === op.order);
	const current = $derived(leaf && ctl.mode === 'execute' && ctl.currentOrder === op.order);
	// CLAIM stays visible where it matters (my OP, the OP of the next step); elsewhere on hover.
	const claimHere = $derived(
		ctl.claimedOrder === op.order ||
			(ctl.currentOrder != null &&
				(ctl.currentOrder === op.order || op.steps.some((s) => s.order === ctl.currentOrder)))
	);
	const pct = $derived(op.progress.total ? (op.progress.done / op.progress.total) * 100 : 0);
	const deletable = $derived(
		op.is_ad_hoc &&
			op.status === 'pending' &&
			op.steps.every((s) => s.status === 'pending') &&
			!!ctl.actions.deleteRedline &&
			ctl.active
	);
	const footer = $derived(
		ctl.mode === 'execute' &&
			ctl.active &&
			!leaf &&
			((op.open_ncs.length > 0 && !op.is_ad_hoc && !!ctl.actions.redline) ||
				op.step.status === 'awaiting_signoff' ||
				deletable)
	);
</script>

{#if op.is_ad_hoc && op.redline}
	<a
		class="mb-px flex h-7 items-center gap-2 border border-warn/50 bg-warn-muted px-3 font-mono text-xs text-warn hover:underline"
		href={`/issues/${op.redline.issue_id}`}
		title="Open the authorizing NC">REDLINE · {op.redline.issue_number} · {op.redline.title}</a
	>
{/if}
<section
	id={`op-${op.order}`}
	data-drop-row={au ? '' : undefined}
	data-op-order={op.order}
	data-op-status={op.status}
	class={cn(
		'border border-border bg-card',
		op.is_contingency && 'border-dashed',
		op.is_ad_hoc && 'border-warn/50',
		current && 'shadow-[inset_2px_0_0_var(--info)]'
	)}
>
	<div
		id={leaf ? `step-${op.order}` : undefined}
		data-order={leaf ? op.order : undefined}
		class={cn(
			'group/row flex min-h-9 cursor-pointer items-center gap-2 bg-muted/60 px-3 py-1 hover:bg-accent/60',
			open && 'border-b border-border',
			focused && 'outline outline-1 -outline-offset-1 outline-foreground/25',
			au && dropMarker(au, op.order),
			au?.drag.id === op.order && 'opacity-40'
		)}
		ondragover={au
			? (e) => dragOver(au, e, op.order, !au.ops().some((o) => o.order === au.drag.id))
			: undefined}
		ondrop={au ? (e) => dropHere(au, e, op.order) : undefined}
		role="button"
		tabindex="-1"
		aria-expanded={open}
		onclick={() => {
			ctl.setFocus(op.order);
			ctl.toggle(key, terminal, blocked);
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				ctl.toggle(key, terminal, blocked);
			}
		}}
	>
		<span
			class="w-3 shrink-0 text-center font-mono text-[11px] text-muted-foreground"
			aria-hidden="true">{open ? '▾' : '▸'}</span
		>
		<span class="shrink-0 font-mono text-xs font-semibold">OP {op.number}</span>
		{#if au}
			<TitleInput step={op.step} class="font-medium" />
		{:else}
			<span
				class={cn(
					'min-w-0 flex-1 truncate text-sm font-medium',
					terminal && 'text-muted-foreground',
					op.status === 'skipped' && 'line-through'
				)}>{op.title}</span
			>
		{/if}
		{#if op.is_contingency}
			<span
				class="inline-flex h-5 items-center border border-warn/50 px-1.5 font-mono text-[11px] font-medium text-warn"
				>CONTINGENCY</span
			>
		{/if}
		{#if op.strict_sequence}
			<span
				class="inline-flex h-5 items-center border border-border px-1.5 font-mono text-[11px] font-medium text-muted-foreground"
				title="Sub-steps complete in order">SEQ</span
			>
		{/if}
		<RoleChip role={op.role} />
		{#if au && op.waiting_on_ops.length}
			<span
				class="hidden font-mono text-[11px] whitespace-nowrap text-muted-foreground md:inline"
				title="Starts after these OPs are done">AFTER OP {op.waiting_on_ops.join(', ')}</span
			>
		{/if}
		{#if op.step.requires_signoff && !terminal}
			<span
				class="inline-flex h-5 items-center border border-info/50 px-1.5 font-mono text-[11px] font-medium text-info"
				title="Requires sign-off">SIGN-OFF</span
			>
		{/if}
		{#if au}<AuthorChips step={op.step} />{/if}
		<CursorChips cursors={op.step.cursors} viewerId={ctl.viewerId} />
		<OpClaim {op} prominent={claimHere} />
		{#if au && !leaf}
			<span class="font-mono text-xs whitespace-nowrap text-muted-foreground"
				>{op.steps.length} {op.steps.length === 1 ? 'STEP' : 'STEPS'}</span
			>
		{:else if !leaf}
			<span class="flex items-center gap-2">
				<span class="hidden h-1.5 w-16 bg-border sm:block" aria-hidden="true"
					><span class="block h-full bg-ok" style:width={`${pct}%`}></span></span
				>
				<span
					class={cn(
						'font-mono text-xs tabular-nums',
						terminal ? 'text-ok' : 'text-muted-foreground'
					)}
					title="Steps complete">{op.progress.done}/{op.progress.total}</span
				>
			</span>
		{/if}
		<span class="shrink-0 text-right">
			{#if au}
				<span class="flex items-center gap-2">
					<SaveBadge step={op.step} quiet />
					<RowTools step={op.step} {op} isOp={true} />
				</span>
			{:else if ctl.active && op.holds.length}
				<!-- The hold's issue number lives on the row it blocks; here, only that the OP is held. -->
				<span
					class="font-mono text-xs font-medium whitespace-nowrap text-warn"
					title={`OP COMPLETE is held until disposition: ${op.holds.map((h) => h.issue_number).join(', ')}`}
					>HELD{op.holds.length > 1 ? ` ×${op.holds.length}` : ''}</span
				>
			{:else if ctl.active && op.waiting_on_ops.length}
				<span class="font-mono text-xs font-medium whitespace-nowrap text-muted-foreground"
					>AFTER OP {op.waiting_on_ops.join(', ')}</span
				>
			{:else if leaf || terminal || op.step.status === 'awaiting_signoff'}
				<StepState step={op.step} />
			{/if}
		</span>
	</div>
	{#if open}
		{#if leaf}
			<StepBody step={op.step} {op} />
		{:else}
			{#if au}
				<div class="grid gap-3 border-b border-border px-3 py-3">
					<div class="-mb-1 flex min-h-4 justify-end"><SaveBadge step={op.step} /></div>
					<CautionEditor step={op.step} />
					<MarkdownEditor
						id={`instr-${op.order}`}
						label="Instructions"
						value={op.instructions}
						onchange={(v) => au.edit(op.step, { instructions: v })}
					/>
					<StepProps step={op.step} {op} isOp={true} />
				</div>
			{:else if op.caution || op.instructions}
				<div class="grid gap-3 border-b border-border px-3 py-3">
					<CautionBlock text={op.caution} />
					{#if op.instructions}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown() sanitizes -->
						<div class="prose-opal max-w-3xl">{@html markdown(op.instructions)}</div>
					{/if}
				</div>
			{/if}
			{#each op.steps as s (s.order)}
				<StepRow step={s} {op} />
			{/each}
			{#if au}
				<div class="border-t border-border bg-muted/20 px-3 py-1">
					<Button
						size="xs"
						variant="ghost"
						onclick={() => au.addStep(op, op.steps[op.steps.length - 1] ?? op.step)}>+ STEP</Button
					>
				</div>
			{/if}
			{#if footer}
				<div class="flex flex-wrap items-center gap-3 border-t border-border bg-muted/30 px-3 py-2">
					<StepActions step={op.step} {op} scope="op" />
					{#if deletable}
						<Button size="xs" variant="destructive" onclick={() => ctl.actions.deleteRedline?.(op)}
							>DELETE REDLINE</Button
						>
					{/if}
				</div>
			{/if}
		{/if}
	{/if}
</section>
