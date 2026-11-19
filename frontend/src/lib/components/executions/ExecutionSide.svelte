<script lang="ts">
	// Right column: who is working where, the work order's issues, and its comment
	// thread. Roster entries jump into the document.
	import { cn } from '#lib/utils.js';
	import { ActionLink, Avatar, EmptyLine, Section, State } from '#lib/components/opal/index.js';
	import { ticketLabel, ticketTone } from '#lib/components/issues/issues.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';
	import ExecutionComments from './ExecutionComments.svelte';
	import { fillColumn } from './fill-column.js';

	let { store, onjump }: { store: ExecutionStore; onjump: (order: number) => void } = $props();

	const doc = $derived(store.doc!);
	// The form takes the project and the work order from the URL, and opens beside the work.
	const newIssue = $derived(store.issueUrl());

	// Issues grouped by when their hold must be cleared: what stops the work now first, then
	// what is due within each OP (by the step it is bound to), then by the end of the work order.
	type Issue = (typeof doc.issues)[number];
	const opOfNumber = (n: string | null) =>
		n === null
			? null
			: (store.allOps.find((o) => o.number === n || o.steps.some((s) => s.number === n))?.order ??
				null);
	const opOf = (i: Issue) => i.holds_at?.op_order ?? opOfNumber(i.raised_step_number);
	const scopeOp = $derived(store.focusOp);
	const scopeOpNumber = $derived(store.allOps.find((o) => o.order === scopeOp)?.number ?? '');
	let showAll = $state(true);
	let showClosed = $state(false);
	const open = $derived(doc.issues.filter((i) => i.status === 'open'));
	const closed = $derived(doc.issues.filter((i) => i.status !== 'open'));
	const inScope = (i: Issue) => showAll || scopeOp === null || opOf(i) === scopeOp;
	const outside = $derived(open.some((i) => opOf(i) !== scopeOp));
	const bySeq = (a: Issue, b: Issue) =>
		(a.holds_at?.seq ?? 0) - (b.holds_at?.seq ?? 0) || a.id - b.id;
	const groups = $derived.by(() => {
		const out: { key: string; label: string; now: boolean; items: Issue[] }[] = [];
		const now = open.filter((i) => i.holds_at?.now).sort(bySeq);
		if (now.length) out.push({ key: 'now', label: 'Blocking now', now: true, items: now });
		const later = open.filter((i) => i.holds_at && !i.holds_at.now);
		const ops = [
			...new Set(later.filter((i) => i.holds_at!.kind !== 'wo').map((i) => i.holds_at!.op_order))
		];
		for (const op of ops) {
			const items = later
				.filter((i) => i.holds_at!.kind !== 'wo' && i.holds_at!.op_order === op && inScope(i))
				.sort(bySeq);
			if (items.length)
				out.push({
					key: `op${op}`,
					label: `Due by end of OP ${items[0]!.holds_at!.op_number}`,
					now: false,
					items
				});
		}
		const wo = later.filter((i) => i.holds_at!.kind === 'wo').sort(bySeq);
		if (wo.length) out.push({ key: 'wo', label: 'Due by end of WO', now: false, items: wo });
		const other = open.filter((i) => !i.holds_at && inScope(i));
		if (other.length) out.push({ key: 'other', label: 'Other open', now: false, items: other });
		return out;
	});
</script>

{#snippet line(i: Issue)}
	<div
		class="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-baseline gap-x-2 px-3 py-0.5 text-xs"
	>
		<a class="font-mono font-semibold text-info hover:underline" href={`/issues/${i.id}`}
			>{i.issue_number}</a
		>
		<span class="font-mono text-muted-foreground">{i.raised_step_number ?? ''}</span>
		<span class="truncate text-muted-foreground" title={i.title}>{i.title}</span>
		<span class="font-mono text-[11px] whitespace-nowrap text-muted-foreground"
			>{i.status === 'open' && i.holds_at?.kind === 'step' && !i.holds_at.now
				? `by ${i.holds_at.step_number}`
				: ''}</span
		>
		<State
			value={i.status === 'void' ? 'void' : i.ticket_state}
			tone={i.status === 'void' ? 'muted' : ticketTone(i.ticket_state)}
			label={i.status === 'void' ? 'VOID' : ticketLabel(i.ticket_state)}
			class="text-[11px]"
		/>
	</div>
{/snippet}

<!-- One viewport tall on wide screens and never scrolls as a whole, nor sideways.
     Cards are only as tall as their content and never stretch to fill the column.
     When they do not fit, fillColumn caps the tallest ones (each scrolls inside). -->
<div class="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere] lg:h-full" use:fillColumn>
	{#if doc.roster.length}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-none lg:flex-col"
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
								<Avatar
									user={{ id: r.user_id, name: r.name ?? r.initials, avatar_url: r.avatar_url }}
									size="xs"
								/>
								<span class="truncate">{r.name ?? r.initials}</span>
								{#if r.step_number}<span class="ml-auto text-muted-foreground"
										>OP {r.step_number}</span
									>{/if}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</Section>
	{:else}
		<EmptyLine label="Online" empty="No one online." />
	{/if}

	{#if doc.issues.length}
		<Section
			class="lg:flex lg:min-h-0 lg:flex-none lg:flex-col"
			title="Issues"
			count={doc.issues.length || undefined}
		>
			{#snippet actions()}
				{#if scopeOp !== null && outside}
					<span class="inline-flex border border-border" role="group" aria-label="Which issues">
						{#each [[true, 'ALL'], [false, `OP ${scopeOpNumber}`]] as const as [all, label] (label)}
							<button
								type="button"
								aria-pressed={showAll === all}
								class={cn(
									'h-5 px-1.5 font-mono text-[11px] font-semibold tracking-wider',
									showAll === all ? 'bg-foreground text-background' : 'hover:bg-accent'
								)}
								onclick={() => (showAll = all)}>{label}</button
							>
						{/each}
					</span>
				{/if}
				<ActionLink href={newIssue} target="_blank" rel="noopener">+ NEW</ActionLink>
			{/snippet}
			<div class="min-h-0 overflow-x-hidden overflow-y-auto">
				{#each groups as g (g.key)}
					<div class="border-b border-border pb-1 last:border-b-0">
						<div
							class={cn(
								'flex items-center px-3 pt-1.5 pb-0.5 font-mono text-[11px] font-semibold tracking-wider uppercase',
								g.now ? 'text-error' : 'text-muted-foreground'
							)}
						>
							{g.label}{#if g.items.length > 1}<span class="ml-auto font-normal"
									>{g.items.length}</span
								>{/if}
						</div>
						{#each g.items as i (i.id)}
							{@render line(i)}
						{/each}
					</div>
				{/each}
				{#if closed.length}
					<button
						type="button"
						class="flex w-full items-center px-3 py-1.5 font-mono text-[11px] font-semibold tracking-wider hover:bg-accent/60"
						aria-expanded={showClosed}
						onclick={() => (showClosed = !showClosed)}
						>CLOSED<span class="ml-auto font-normal text-muted-foreground"
							>{closed.length} {showClosed ? '⌄' : '›'}</span
						></button
					>
					{#if showClosed}
						<div class="pb-1">
							{#each closed as i (i.id)}{@render line(i)}{/each}
						</div>
					{/if}
				{/if}
			</div>
		</Section>
	{:else}
		<EmptyLine label="Issues">
			{#snippet action()}
				<a
					class="font-mono text-xs font-medium tracking-wider text-info uppercase hover:underline"
					href={newIssue}
					target="_blank"
					rel="noopener">+ NEW</a
				>
			{/snippet}
		</EmptyLine>
	{/if}

	<ExecutionComments {store} />
</div>
