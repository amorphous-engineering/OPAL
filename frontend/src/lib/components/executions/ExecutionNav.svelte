<script lang="ts">
	// Left sidebar: who is working where, the OP index and the issues raised
	// against this work order. Document entries jump
	// to its row in the document (onjump switches to the document tab first).
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { EmptyLine, Section, State } from '#lib/components/opal/index.js';
	import { isTerminal } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, onjump }: { store: ExecutionStore; onjump: (order: number) => void } = $props();

	const doc = $derived(store.doc!);
	const inst = $derived(doc.instance);
	const ops = $derived([...doc.ops, ...doc.contingency_ops]);
	const issueTone = (state: string) =>
		state === 'undispositioned'
			? 'error'
			: state === 'dispositioned'
				? 'ok'
				: state === 'open'
					? 'warn'
					: 'muted';
	const issueLabel = (state: string) =>
		state === 'undispositioned'
			? 'UNDISP'
			: state === 'dispositioned'
				? "DISP'D"
				: state.toUpperCase();
</script>

<!-- Never scrolls sideways: every row fits the sidebar width (truncate or wrap). -->
<!-- On wide screens the sidebar is one viewport tall and never scrolls as a whole: each
     card scrolls its own body. Cards whose content fits keep their natural height; the
     rest share the remaining height evenly (flex 1 1 0, capped at max-content). -->
<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full">
	{#if doc.roster.length}
		<Section
			class="lg:flex lg:max-h-max lg:min-h-0 lg:flex-[1_1_0] lg:flex-col"
			title="Online"
			count={doc.roster.length || undefined}
		>
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each doc.roster as r (r.user_id)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class={cn(
									'flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs hover:bg-accent/60',
									r.stale && 'opacity-50',
									r.user_id === store.viewerId && 'font-semibold'
								)}
								disabled={r.step_order === null}
								onclick={() => r.step_order !== null && onjump(r.step_order)}
							>
								<span class="truncate">{r.name ?? r.initials}</span>
								{#if r.step_number}<span class="ml-auto text-muted-foreground"
										>@{r.step_number}</span
									>{/if}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Online" />
	{/if}

	{#if ops.length}
		<Section
			class="lg:flex lg:max-h-max lg:min-h-0 lg:flex-[1_1_0] lg:flex-col"
			title="Operations"
			count={ops.length || undefined}
		>
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each ops as op (op.order)}
						{@const done = isTerminal(op.status)}
						<li class="border-b border-border last:border-b-0">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/60"
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

	{#if doc.issues.length}
		<Section
			class="lg:flex lg:max-h-max lg:min-h-0 lg:flex-[1_1_0] lg:flex-col"
			title="Issues"
			count={doc.issues.length || undefined}
		>
			{#snippet actions()}
				<Button size="xs" variant="ghost" href={`/issues/new?execution=${inst.id}`}>+ NEW</Button>
			{/snippet}
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				<ul class="m-0 list-none p-0">
					{#each doc.issues as i (i.id)}
						<li class="border-b border-border px-3 py-1.5 text-xs last:border-b-0">
							<div class="flex items-center gap-2">
								<a class="font-mono font-medium text-info hover:underline" href={`/issues/${i.id}`}
									>{i.issue_number}</a
								>
								{#if i.raised_step_number}
									<span class="font-mono text-muted-foreground" title="Raised at step"
										>@{i.raised_step_number}</span
									>
								{/if}
								<span class="ml-auto"
									><State
										value={i.state}
										tone={issueTone(i.state)}
										label={issueLabel(i.state)}
										badge={i.state === 'undispositioned'}
									/></span
								>
							</div>
							<div class="truncate text-muted-foreground" title={i.title}>{i.title}</div>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Issues" addHref={`/issues/new?execution=${inst.id}`} />
	{/if}
</div>
