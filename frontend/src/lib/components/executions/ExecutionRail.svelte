<script lang="ts">
	// The side rail: people, navigation, issues, evidence, reference documents
	// and work-order facts. Heavy content lives here, never inline in the document.
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		State,
		Timestamp
	} from '#lib/components/opal/index.js';
	import { attachmentUrl, lightbox, isTerminal } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let { store, onedit }: { store: ExecutionStore; onedit: () => void } = $props();

	const doc = $derived(store.doc!);
	const inst = $derived(doc.instance);
	const ops = $derived([...doc.ops, ...doc.contingency_ops]);

	const rows = $derived(
		ops.flatMap((op) => [op.step, ...op.steps]).filter((s) => s.attachments.length > 0)
	);
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
	const size = (n: number) =>
		n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
	const priorityLabel = ['NORMAL', 'HIGH', 'URGENT'];
</script>

<!-- The rail never scrolls sideways: every row fits its width (truncate or wrap). -->
<div
	class="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 [overflow-wrap:anywhere] [&_table]:table-fixed"
>
	{#if doc.roster.length}
		<Section title="Online" count={doc.roster.length || undefined}>
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
							onclick={() => r.step_order !== null && store.jumpTo(r.step_order)}
						>
							<span class="truncate">{r.name ?? r.initials}</span>
							{#if r.step_number}<span class="ml-auto text-muted-foreground">@{r.step_number}</span
								>{/if}
						</button>
					</li>
				{/each}
			</ul>
		</Section>
	{:else}
		<EmptyLine label="Online" />
	{/if}

	{#if ops.length}
		<Section title="Operations" count={ops.length || undefined}>
			<ul class="m-0 list-none p-0">
				{#each ops as op (op.order)}
					{@const done = isTerminal(op.status)}
					<li class="border-b border-border last:border-b-0">
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/60"
							onclick={() => store.jumpTo(op.order)}
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
		</Section>
	{:else}
		<EmptyLine label="Operations" />
	{/if}

	{#if doc.issues.length}
		<Section title="Issues" count={doc.issues.length || undefined}>
			{#snippet actions()}
				<Button size="xs" variant="ghost" href={`/issues/new?execution=${inst.id}`}>+ NEW</Button>
			{/snippet}
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
		</Section>
	{:else}
		<EmptyLine label="Issues" addHref={`/issues/new?execution=${inst.id}`} />
	{/if}

	{#if rows.length || doc.attachments.length}
		<Section
			title="Attachments"
			count={rows.length || doc.attachments.length
				? rows.reduce((n, s) => n + s.attachments.length, doc.attachments.length)
				: undefined}
		>
			{#snippet actions()}
				<Button
					size="xs"
					variant="ghost"
					onclick={() => (store.dialog = { kind: 'attach', step: null })}>+ ATTACH</Button
				>
			{/snippet}
			<div class="grid">
				{#each rows as s (s.order)}
					<div
						id={`evidence-${s.order}`}
						class={cn(
							'border-b border-border px-3 py-1.5 last:border-b-0',
							store.pulse === -s.order && 'bg-accent'
						)}
					>
						<button
							type="button"
							class="mb-1 font-mono text-xs font-medium hover:underline"
							onclick={() => store.jumpTo(s.order)}>{s.number}</button
						>
						{@render files(s.attachments)}
					</div>
				{/each}
				{#if doc.attachments.length}
					<div class="px-3 py-1.5">
						<div class="mb-1 font-mono text-xs font-medium">WORK ORDER</div>
						{@render files(doc.attachments)}
					</div>
				{/if}
			</div>
		</Section>
	{:else}
		<EmptyLine label="Attachments" onadd={() => (store.dialog = { kind: 'attach', step: null })} />
	{/if}

	{#if doc.reference_attachments.length}
		<Section title="Reference documents" count={doc.reference_attachments.length || undefined}>
			<ul class="m-0 list-none p-0">
				{#each doc.reference_attachments as a (a.id)}
					<li
						class="flex items-center gap-2 border-b border-border px-3 py-1 text-xs last:border-b-0"
					>
						<a
							class="min-w-0 flex-1 truncate font-mono text-info hover:underline"
							href={attachmentUrl(a.id)}
							target="_blank"
							rel="noopener">{a.filename}</a
						>
						<span class="font-mono text-muted-foreground">{size(a.size_bytes)}</span>
					</li>
				{/each}
			</ul>
		</Section>
	{:else}
		<EmptyLine label="Reference documents" />
	{/if}

	<Section title="Facts">
		{#snippet actions()}
			{#if inst.active}<Button size="xs" variant="ghost" onclick={onedit}>EDIT</Button>{/if}
		{/snippet}
		<DetailTable>
			<DetailRow label="Procedure"
				><a
					class="block max-w-44 truncate text-info hover:underline"
					title={inst.procedure.name}
					href={`/procedures/${inst.procedure.id}`}>{inst.procedure.name}</a
				></DetailRow
			>
			<DetailRow label="Version" mono>
				v{inst.version.number}
				{#if inst.version.created_at}<span class="text-muted-foreground"
						>· <Timestamp value={inst.version.created_at} dateOnly /></span
					>{/if}
			</DetailRow>
			<DetailRow label="Version author" value={inst.version.created_by} />
			<DetailRow label="Priority" value={priorityLabel[inst.priority] ?? String(inst.priority)} />
			<DetailRow label="Cut by" value={inst.created_by} />
			<DetailRow label="Created"><Timestamp value={inst.created_at} /></DetailRow>
			<DetailRow label="Scheduled"><Timestamp value={inst.scheduled_start_at} /></DetailRow>
			<DetailRow label="Target"><Timestamp value={inst.target_completion_at} /></DetailRow>
			<DetailRow label="Started"><Timestamp value={inst.started_at} /></DetailRow>
			<DetailRow label="Last activity"><Timestamp value={inst.last_activity_at} /></DetailRow>
			<DetailRow label="Completed"><Timestamp value={inst.completed_at} /></DetailRow>
		</DetailTable>
	</Section>
</div>

{#snippet files(list: typeof doc.attachments)}
	<div class="grid gap-1.5">
		{#each list as a (a.id)}
			<div class="flex items-start gap-2">
				{#if a.mime_type.startsWith('image/')}
					<button
						type="button"
						class="shrink-0 border border-border"
						onclick={() => lightbox.open(attachmentUrl(a.id), a.note ?? a.filename)}
						aria-label={`Enlarge ${a.filename}`}
					>
						<img
							loading="lazy"
							src={attachmentUrl(a.id)}
							alt={a.filename}
							class="size-12 object-cover"
						/>
					</button>
				{:else}
					<a
						class="font-mono text-xs text-info hover:underline"
						href={attachmentUrl(a.id)}
						target="_blank"
						rel="noopener">{a.filename}</a
					>
				{/if}
				<div class="min-w-0 font-mono text-[11px] text-muted-foreground">
					{#if a.kind === 'closeout'}<span class="text-ok">CLOSEOUT</span> ·{/if}
					{a.uploaded_by ?? ''}
					<Timestamp value={a.created_at} />
					{#if a.note}<div class="font-sans text-xs text-foreground">{a.note}</div>{/if}
				</div>
			</div>
		{/each}
	</div>
{/snippet}
