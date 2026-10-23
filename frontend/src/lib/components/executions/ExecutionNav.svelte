<script lang="ts">
	// Left sidebar: the OP index. Each entry jumps to its OP in the document
	// (onjump switches to the document tab first).
	import { cn } from '#lib/utils.js';
	import { EmptyLine, Section } from '#lib/components/opal/index.js';
	import { isTerminal } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, onjump }: { store: ExecutionStore; onjump: (order: number) => void } = $props();

	const doc = $derived(store.doc!);
	const ops = $derived([...doc.ops, ...doc.contingency_ops]);
	const pct = $derived(doc.progress.total ? (doc.progress.done / doc.progress.total) * 100 : 0);
</script>

<!-- Never scrolls sideways: every row fits the sidebar width (truncate or wrap). -->
<!-- On wide screens the sidebar is one viewport tall and never scrolls as a whole;
     the operations card is only as tall as its content, scrolling inside when the
     column runs out. -->
<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full">
	<Section
		class="lg:flex-none"
		title="Progress"
		count={`${doc.progress.done}/${doc.progress.total}`}
	>
		<div class="px-3 py-2.5" title="Steps complete">
			<div
				class="h-1.5 w-full bg-border"
				role="progressbar"
				aria-label="Steps complete"
				aria-valuenow={Math.round(pct)}
				aria-valuemin={0}
				aria-valuemax={100}
			>
				<div class="h-full bg-ok" style:width={`${pct}%`}></div>
			</div>
		</div>
	</Section>
	{#if ops.length}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-[0_1_auto] lg:flex-col"
			title="Operations"
			count={ops.length || undefined}
		>
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each ops as op (op.order)}
						{@const done = isTerminal(op.status)}
						{@const selected = store.focusMode && store.focusOp === op.order}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/60',
									selected && 'bg-accent shadow-[inset_2px_0_0_var(--info)]'
								)}
								aria-current={selected ? 'true' : undefined}
								onclick={() => onjump(op.order)}
							>
								<span class="w-8 shrink-0 font-mono font-medium">{op.number}</span>
								<span class={cn('min-w-0 flex-1 truncate', done && 'text-muted-foreground')}
									>{op.title}</span
								>
								{#if op.steps.length}
									<span
										class={cn('font-mono tabular-nums', done ? 'text-ok' : 'text-muted-foreground')}
										>{op.progress.done}/{op.progress.total}</span
									>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Operations" />
	{/if}
</div>
