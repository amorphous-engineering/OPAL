<script lang="ts">
	import { ActionLink, State, Timestamp } from '#lib/components/opal/index.js';
	// One OP: a card with a header bar (number, title, what is exceptional, claim, count) over
	// its steps. An OP without sub-steps is its own single step and shows that step's body
	// directly, with its stamp in place of the count.
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
	import StepStamp from './StepStamp.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
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
	/** A redline not yet released: pencil, shown dashed, open, and not workable. */
	const draftRl = $derived(!!op.redline && op.redline.released_at === null);
	// Fold what cannot be acted on yet: a leaf OP that is held or waiting, an OP
	// waiting on another OP or a redline. Unfinished sub-steps never fold an OP.
	const blocked = $derived(
		ctl.mode === 'execute' &&
			!draftRl &&
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
		draftRl && !!op.redline?.can_edit && !!ctl.actions.deleteRedline && ctl.active
	);
	const draftKeys = $derived(ctl.mode === 'execute' && draftRl && ctl.active);
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
	const footer = $derived(opSignoffs || draftKeys);

	let deleting = $state(false);

	const holdBadge =
		'border-error-fill bg-error-fill font-mono dark:bg-error-fill font-bold tracking-wider text-error-on';
	const warnBadge =
		'border-warn-fill bg-warn-fill font-mono dark:bg-warn-fill font-bold tracking-wider text-warn-on';
	const mutedBadge =
		'border-dotted border-foreground font-mono tracking-wider text-foreground dark:bg-transparent';
</script>

<section
	id={`op-${op.order}`}
	data-drop-row={au ? '' : undefined}
	data-op-order={op.order}
	data-op-status={op.status}
	style:--op-head={`${headHeight}px`}
	class={cn(
		// clip, not hidden: hidden makes a scroll container, which stops the title bars from sticking.
		'overflow-clip border border-border bg-card',
		op.is_ad_hoc && (draftRl ? 'border-dashed border-foreground' : 'border-warn')
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
		<span
			class={cn(
				'shrink-0 font-mono text-xs font-semibold',
				draftRl && 'text-tan',
				current && 'bg-foreground px-1 py-px text-background'
			)}>OP {op.number}</span
		>
		{#if au}
			<TitleInput step={op.step} class="font-medium" />
		{:else}
			<span
				class={cn(
					'min-w-0 truncate text-sm font-medium',
					terminal && 'text-muted-foreground',
					(op.status === 'skipped' || (leaf && terminal)) && 'line-through'
				)}>{op.title}</span
			>
		{/if}
		{#if op.is_contingency}
			<Badge variant="outline" class={mutedBadge}>CONTINGENCY</Badge>
		{/if}
		{#if draftRl}<State value="draft" />{/if}
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
						class={holdBadge}
						title={`OP COMPLETE is held until disposition: ${op.holds.map((h) => h.issue_number).join(', ')}`}
						>HELD{op.holds.length > 1 ? ` ×${op.holds.length}` : ''}</Badge
					>
				{/if}
				{#if op.step.status === 'awaiting_signoff'}
					<Badge variant="outline" class={warnBadge}>AWAITING SIGN-OFF</Badge>
				{:else if ctl.active && op.waiting_on_ops.length}
					<span class="font-mono text-xs whitespace-nowrap text-muted-foreground"
						>AFTER OP {op.waiting_on_ops.join(', ')}</span
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
					><Button size="sm" variant="outline" onclick={() => ctl.actions.redline?.(op)}
						>+ REDLINE</Button
					></span
				>
			{/if}
			{#if leaf || op.status === 'skipped'}
				<StepStamp step={op.step} />
			{:else if ctl.mode === 'execute'}
				<span
					class={cn(
						'shrink-0 font-mono text-xs tabular-nums',
						terminal ? 'text-ok' : 'text-muted-foreground'
					)}
					title="Steps complete">{op.progress.done}/{op.progress.total}</span
				>
			{/if}
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
						<div class="prose-opal max-w-3xl text-step leading-normal">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- markdown() sanitizes -->
							{@html markdown(op.instructions)}
						</div>
					{/if}
				</div>
			{/if}
			{#if op.redline && !au}
				{@const rl = op.redline}
				<!-- What authorises the redline, laid out like the steps and parts below it. -->
				<dl
					class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-sm"
				>
					<dt class="label pt-0.5">Issue</dt>
					<dd class="min-w-0">
						<a href={`/issues/${rl.issue_id}`} class="font-mono text-info hover:underline"
							>{rl.issue_number}</a
						>
						{rl.title}
					</dd>
					<dt class="label pt-0.5">Disposition</dt>
					<dd class="font-mono">
						{#if rl.disposition_type}{rl.disposition_type
								.replaceAll('_', ' ')
								.toUpperCase()}{:else}<span class="text-quiet">—</span>{/if}
					</dd>
					<dt class="label pt-0.5">Released</dt>
					<dd>
						{#if rl.released_at}
							<span class="inline-flex flex-wrap gap-x-3"
								><span>{rl.released_by ?? '—'}</span><Timestamp value={rl.released_at} /></span
							>
						{:else}
							<span class="block h-6 border border-dashed border-foreground"></span>
						{/if}
					</dd>
					{#if rl.strikes.length}
						<dt class="label pt-0.5">Replaces</dt>
						<dd class="grid grid-cols-1 gap-0.5">
							{#each rl.strikes as x (`${x.step_order}:${x.part_id}`)}
								<span class="flex flex-wrap gap-x-3 line-through"
									><span>{x.part_number} {x.part_name}</span><span class="font-mono"
										>{x.quantity} {x.uom}</span
									><span class="font-mono text-muted-foreground">{x.step_number ?? 'kit'}</span
									></span
								>
							{/each}
						</dd>
					{/if}
				</dl>
			{/if}
			{#each op.steps as s (s.order)}
				<StepRow step={s} {op} />
			{/each}
			{#if au}
				<div class="border-t border-border bg-muted/20 px-3 py-1">
					<ActionLink onclick={() => au.addStep(op, op.steps[op.steps.length - 1] ?? op.step)}
						>+ STEP</ActionLink
					>
				</div>
			{/if}
			{#if footer}
				<div class="grid grid-cols-1 gap-2 border-t border-border bg-muted/30 px-3 py-3">
					{#if opSignoffs}<SignoffTable step={op.step} {op} />{/if}
					{#if draftKeys && op.redline}
						<div class="flex flex-wrap items-center gap-2">
							{#if op.redline.can_release}
								<Button size="sm" onclick={() => ctl.actions.releaseRedline?.(op)}>RELEASE</Button>
							{:else}
								<Button size="sm" href={`/issues/${op.redline.issue_id}`}
									>BACK TO {op.redline.issue_number}</Button
								>
							{/if}
							{#if op.redline.can_edit}
								<Button size="sm" variant="outline" onclick={() => ctl.actions.editRedline?.(op)}
									>EDIT</Button
								>
							{/if}
						</div>
					{/if}
					{#if deletable}
						<div class="flex items-center gap-2">
							<Button
								size="sm"
								variant={deleting ? 'default' : 'outline'}
								class={deleting ? 'bg-error-fill text-error-on shadow-key hover:bg-error-fill' : ''}
								onclick={() => (deleting ? ctl.actions.deleteRedline?.(op) : (deleting = true))}
								>{deleting ? 'CONFIRM DELETE' : 'DELETE DRAFT'}</Button
							>
							{#if deleting}
								<ActionLink onclick={() => (deleting = false)}>CANCEL</ActionLink>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	{/if}
</section>
