<script lang="ts">
	// One OP: a card with a header bar (number, title, state badges, claim, completion stamp)
	// over its steps. An OP without sub-steps is its own single step and shows
	// that step's body directly. Expanded until complete.
	import CaretRight from 'phosphor-svelte/lib/CaretRight';
	import { Button } from '#lib/components/ui/button/index.js';
	import { markdown } from '#lib/markdown.js';
	import { cn } from '#lib/utils.js';
	import { useDoc } from './controller.js';
	import CalloutList from './CalloutList.svelte';
	import CursorChips from './CursorChips.svelte';
	import OpClaim from './OpClaim.svelte';
	import StepBody from './StepBody.svelte';
	import StepRow from './StepRow.svelte';
	import StepBadges from './StepBadges.svelte';
	import StepState from './StepState.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import StepTitleActions from './StepTitleActions.svelte';
	import SignoffTable from './SignoffTable.svelte';
	import SignoffEditor from './author/SignoffEditor.svelte';
	import AuthorChips from './author/AuthorChips.svelte';
	import CalloutAdd from './author/CalloutAdd.svelte';
	import CalloutsEditor from './author/CalloutsEditor.svelte';
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
	// The title bar sticks while the OP scrolls by (below the app bar on narrow screens,
	// where the page scrolls; at the pane top from lg, where the document pane scrolls);
	// steps stick just below it.
	let headHeight = $state(0);
	const focused = $derived(ctl.focusedOrder === op.order);
	const current = $derived(leaf && ctl.mode === 'execute' && ctl.currentOrder === op.order);
	// CLAIM stays visible where it matters (my OP, the OP of the next step); elsewhere on hover.
	const claimHere = $derived(
		ctl.claimedOrder === op.order ||
			(ctl.currentOrder != null &&
				(ctl.currentOrder === op.order || op.steps.some((s) => s.order === ctl.currentOrder)))
	);
	const deletable = $derived(
		op.is_ad_hoc &&
			op.status === 'pending' &&
			op.steps.every((s) => s.status === 'pending') &&
			!!ctl.actions.deleteRedline &&
			ctl.active
	);
	const redlinable = $derived(
		ctl.mode === 'execute' &&
			ctl.active &&
			op.open_ncs.length > 0 &&
			!op.is_ad_hoc &&
			!!ctl.actions.redline
	);
	// OP-level sign-offs (an OP with sub-steps signs after its steps are done).
	const opSignoffs = $derived(
		!leaf && ctl.mode !== 'author' && (op.step.signoffs ?? []).length > 0
	);
	const footer = $derived(opSignoffs || (ctl.mode === 'execute' && deletable));

	const warnBadge = 'border-warn/50 bg-warn-muted font-mono tracking-wider text-warn';
	const mutedBadge = 'font-mono tracking-wider text-muted-foreground';
</script>

{#if op.is_ad_hoc && op.redline}
	<a
		class="mb-px flex h-7 items-center gap-2 rounded-md border border-warn/50 bg-warn-muted px-3 font-mono text-xs text-warn hover:underline"
		href={`/issues/${op.redline.issue_id}`}
		title="Open the authorizing NC">REDLINE · {op.redline.issue_number} · {op.redline.title}</a
	>
{/if}
<section
	id={`op-${op.order}`}
	data-drop-row={au ? '' : undefined}
	data-op-order={op.order}
	data-op-status={op.status}
	style:--op-head={`${headHeight}px`}
	class={cn(
		// clip, not hidden: rounds the corners without becoming a scroll container,
		// which would stop the title bars from sticking.
		'overflow-clip rounded-lg border border-border bg-card',
		op.is_contingency && 'border-dashed',
		op.is_ad_hoc && 'border-warn/50',
		current && 'shadow-[inset_2px_0_0_var(--info)]'
	)}
>
	<div
		id={leaf ? `step-${op.order}` : undefined}
		data-order={leaf ? op.order : undefined}
		bind:clientHeight={headHeight}
		class={cn(
			'group/row sticky top-11 z-20 flex min-h-9 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))] px-3 py-1 hover:bg-accent lg:top-0',
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
		<CaretRight
			weight="bold"
			class={cn(
				'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
				open && 'rotate-90'
			)}
			aria-hidden="true"
		/>
		<span class="shrink-0 font-mono text-xs font-semibold">OP {op.number}</span>
		{#if au}
			<TitleInput step={op.step} class="font-medium" />
		{:else}
			<span
				class={cn(
					'min-w-0 truncate text-sm font-medium',
					terminal && 'text-muted-foreground',
					op.status === 'skipped' && 'line-through'
				)}>{op.title}</span
			>
			<StepState step={op.step} />
		{/if}
		{#if op.is_contingency}
			<Badge variant="outline" class={warnBadge}>CONTINGENCY</Badge>
		{/if}
		{#if op.strict_sequence}
			<Badge variant="outline" class={mutedBadge} title="Sub-steps complete in order">SEQ</Badge>
		{/if}
		{#if !au}
			{#if leaf}
				<StepBadges step={op.step} />
			{:else if !terminal}
				{#if ctl.active && op.holds.length}
					<!-- The hold's issue number lives on the row it blocks; here, only that the OP is held. -->
					<Badge
						variant="outline"
						class={warnBadge}
						title={`OP COMPLETE is held until disposition: ${op.holds.map((h) => h.issue_number).join(', ')}`}
						>HELD{op.holds.length > 1 ? ` ×${op.holds.length}` : ''}</Badge
					>
				{/if}
				{#if op.step.status === 'awaiting_signoff'}
					<Badge variant="outline" class={warnBadge}>AWAITING SIGN-OFF</Badge>
				{:else if ctl.active && op.waiting_on_ops.length}
					<Badge variant="outline" class={mutedBadge}>AFTER OP {op.waiting_on_ops.join(', ')}</Badge
					>
				{/if}
			{/if}
		{/if}
		<span class="flex-1"></span>
		{#if au && op.waiting_on_ops.length}
			<span
				class="hidden font-mono text-xs whitespace-nowrap text-muted-foreground md:inline"
				title="Starts after these OPs are done">AFTER OP {op.waiting_on_ops.join(', ')}</span
			>
		{/if}
		{#if au}<AuthorChips step={op.step} />{/if}
		<CursorChips
			cursors={op.step.cursors}
			viewerId={ctl.viewerId}
			labor={ctl.laborFor?.(op.order)}
			title={`OP ${op.number}`}
		/>
		<OpClaim {op} prominent={claimHere} />
		{#if au && !leaf}
			<span class="font-mono text-xs whitespace-nowrap text-muted-foreground"
				>{op.steps.length} {op.steps.length === 1 ? 'STEP' : 'STEPS'}</span
			>
		{/if}
		<span class="shrink-0 text-right">
			{#if au}
				<span class="flex items-center gap-2">
					<SaveBadge step={op.step} quiet />
					<RowTools step={op.step} {op} isOp={true} />
				</span>
			{/if}
		</span>
		{#if !au}
			{#if redlinable}
				<span
					class="shrink-0"
					role="presentation"
					onclick={(e) => e.stopPropagation()}
					onkeydown={(e) => e.stopPropagation()}
					><Button size="xs" variant="outline" onclick={() => ctl.actions.redline?.(op)}
						>+ REDLINE</Button
					></span
				>
			{/if}
			{#if leaf}<StepTitleActions step={op.step} />{/if}
		{/if}
	</div>
	{#if open}
		{#if leaf}
			<StepBody step={op.step} {op} />
		{:else}
			{#if au}
				<div class="grid grid-cols-1 gap-3 border-b border-border px-3 py-3">
					<MarkdownEditor
						id={`instr-${op.order}`}
						label="Instructions"
						value={op.instructions}
						onchange={(v) => au.edit(op.step, { instructions: v })}
					>
						{#snippet actions()}<CalloutAdd step={op.step} />{/snippet}
						{#snippet badge()}<SaveBadge step={op.step} />{/snippet}
						{#snippet between()}<CalloutsEditor step={op.step} />{/snippet}
					</MarkdownEditor>
					<SignoffEditor step={op.step} {op} />
					<StepProps step={op.step} {op} isOp={true} />
				</div>
			{:else if op.callouts?.length || op.instructions}
				<div class="grid grid-cols-1 gap-3 border-b border-border px-3 py-3">
					<CalloutList callouts={op.callouts ?? []} />
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
				<div class="grid grid-cols-1 gap-2 border-t border-border bg-muted/30 px-3 py-3">
					{#if opSignoffs}<SignoffTable step={op.step} {op} />{/if}
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
