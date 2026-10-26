<script lang="ts">
	// Left sidebar: progress, the OP index and the reference documents. Each OP entry
	// jumps to its OP in the document (onjump switches to the document tab first).
	import { cn } from '#lib/utils.js';
	import { datetime, iso } from '#lib/format.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { EmptyLine, Section } from '#lib/components/opal/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { CursorChips, isTerminal, type DocOp } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import ExecutionReferences from './ExecutionReferences.svelte';
	import { fillColumn } from './fill-column.js';

	let { store, onjump }: { store: ExecutionStore; onjump: (order: number) => void } = $props();

	const doc = $derived(store.doc!);
	const ops = $derived([...doc.ops, ...doc.contingency_ops]);
	const pct = $derived(doc.progress.total ? (doc.progress.done / doc.progress.total) * 100 : 0);

	// Where an OP stands: a badge label and its state colours.
	function opState(op: DocOp): { label: string; tone: string } {
		const st = op.step.status;
		if (st === 'completed' || st === 'signed_off')
			return { label: 'DONE', tone: 'border-ok/50 bg-ok-muted text-ok' };
		if (st === 'skipped') return { label: 'SKIPPED', tone: 'text-muted-foreground' };
		if (op.holds.length || st === 'on_hold')
			return { label: 'HELD', tone: 'border-warn/50 bg-warn-muted text-warn' };
		if (st === 'awaiting_signoff')
			return { label: 'SIGN-OFF', tone: 'border-warn/50 bg-warn-muted text-warn' };
		if (st === 'in_progress' || op.progress.done > 0)
			return { label: 'IN WORK', tone: 'border-info/50 bg-info-muted text-info' };
		if (op.waiting_on_ops.length)
			return { label: `AFTER OP ${op.waiting_on_ops.join(', ')}`, tone: 'text-muted-foreground' };
		return { label: 'NOT STARTED', tone: 'text-muted-foreground' };
	}
</script>

<!-- Never scrolls sideways: every row fits the sidebar width (truncate or wrap). -->
<!-- On wide screens the sidebar is one viewport tall and never scrolls as a whole;
     cards are only as tall as their content, and fillColumn caps the tallest ones
     when the column runs out (each scrolls inside). -->
<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full" use:fillColumn>
	<Section
		class="lg:flex-none"
		title="Progress"
		count={`${doc.progress.done}/${doc.progress.total}`}
	>
		<div class="px-3 py-2.5" title="Steps complete">
			<Progress
				value={Math.round(pct)}
				aria-label="Steps complete"
				class="h-1.5 bg-border [&_[data-slot=progress-indicator]]:bg-ok"
			/>
		</div>
	</Section>
	{#if ops.length}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-none lg:flex-col"
			title="Operations"
			count={ops.length || undefined}
		>
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each ops as op (op.order)}
						{@const done = isTerminal(op.status)}
						{@const selected = store.focusMode && store.focusOp === op.order}
						{@const s = opState(op)}
						{@const stamp = op.step.completed?.at}
						<li class="relative border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'grid w-full grid-cols-1 gap-0.5 px-3 py-2 text-left hover:bg-accent/60',
									selected && 'bg-accent shadow-[inset_2px_0_0_var(--info)]'
								)}
								aria-current={selected ? 'true' : undefined}
								onclick={() => onjump(op.order)}
							>
								<span class="flex min-w-0 items-baseline gap-2">
									<span class="shrink-0 font-mono text-xs font-semibold">OP {op.number}</span>
									<span
										class={cn('min-w-0 flex-1 truncate text-sm', done && 'text-muted-foreground')}
										title={op.title}>{op.title}</span
									>
								</span>
								<span class="flex min-w-0 items-center gap-2 font-mono text-xs">
									<Badge variant="outline" class={cn('font-mono tracking-wider', s.tone)}
										>{s.label}</Badge
									>
									{#if done && stamp}
										<time class="text-muted-foreground" datetime={iso(stamp)} title={iso(stamp)}
											>{datetime(stamp)}</time
										>
									{/if}
								</span>
							</button>
							<!-- Outside the row button: the chips are a button of their own. -->
							<span class="absolute right-3 bottom-2">
								<CursorChips
									cursors={op.step.cursors}
									viewerId={store.viewerId}
									labor={store.laborFor(op.order)}
									title={`OP ${op.number}`}
								/>
							</span>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Operations" />
	{/if}

	<ExecutionReferences {store} />
</div>
