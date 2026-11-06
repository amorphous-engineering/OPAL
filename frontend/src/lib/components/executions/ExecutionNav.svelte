<script lang="ts">
	// Left sidebar: progress, the OP index and the reference documents. Each OP entry
	// jumps to its OP in the document (onjump switches to the document tab first).
	import { cn } from '#lib/utils.js';
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

	// Only what is exceptional gets a word. Everything else is its count.
	function flag(op: DocOp): string | null {
		const st = op.step.status;
		if (st === 'skipped') return 'SKIPPED';
		if (isTerminal(st)) return null;
		if (op.holds.length || st === 'on_hold') return 'HELD';
		if (st === 'awaiting_signoff') return 'SIGN-OFF';
		return null;
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
				class="h-1.5 bg-desk [&_[data-slot=progress-indicator]]:bg-foreground"
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
						{@const word = flag(op)}
						<li class="flex min-w-0 items-center border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex min-w-0 flex-1 items-baseline gap-2 px-3 py-1 text-left hover:bg-accent/60',
									selected && 'bg-accent shadow-[inset_2px_0_0_var(--info)]'
								)}
								aria-current={selected ? 'true' : undefined}
								onclick={() => onjump(op.order)}
							>
								<span class="shrink-0 font-mono text-xs font-semibold tabular-nums"
									>{op.number}</span
								>
								<span
									class={cn('min-w-0 flex-1 truncate text-sm', done && 'text-muted-foreground')}
									title={op.title}>{op.title}</span
								>
								{#if word}<span
										class={cn(
											'shrink-0 font-mono text-xs',
											word === 'SKIPPED'
												? 'text-muted-foreground'
												: word === 'HELD'
													? 'text-error'
													: 'text-warn'
										)}>{word}</span
									>{/if}
								<span
									class={cn(
										'shrink-0 font-mono text-xs tabular-nums',
										done && op.status !== 'skipped' ? 'text-ok' : 'text-muted-foreground'
									)}>{op.progress.done}/{op.progress.total}</span
								>
							</button>
							<!-- Outside the row button: the chips are a button of their own. -->
							<span class="shrink-0 pr-2 empty:hidden">
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
