<script lang="ts">
	// The DETAILS tab: issues, evidence, reference documents and work-order
	// facts — the record around the work rather than the work itself.
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		Timestamp
	} from '#lib/components/opal/index.js';
	import { attachmentUrl, lightbox } from '#lib/components/procedure-doc/index.js';
	import type { ExecutionStore } from '#lib/execution/store.svelte.js';

	let {
		store,
		onedit,
		onjump
	}: { store: ExecutionStore; onedit: () => void; onjump: (order: number) => void } = $props();

	const doc = $derived(store.doc!);
	const inst = $derived(doc.instance);
	const ops = $derived([...doc.ops, ...doc.contingency_ops]);

	const rows = $derived(
		ops.flatMap((op) => [op.step, ...op.steps]).filter((s) => s.attachments.length > 0)
	);
	const size = (n: number) =>
		n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
	const priorityLabel = ['NORMAL', 'HIGH', 'URGENT'];
</script>

<div
	class="grid min-w-0 grid-cols-1 content-start gap-3 [overflow-wrap:anywhere] xl:grid-cols-2 [&_table]:table-fixed"
>
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
							onclick={() => onjump(s.order)}>@{s.number}</button
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
			<div class="flex flex-wrap items-start gap-x-2 gap-y-0.5">
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
						class="basis-full font-mono text-xs text-info hover:underline"
						href={attachmentUrl(a.id)}
						target="_blank"
						rel="noopener">{a.filename}</a
					>
				{/if}
				<div class="min-w-0 flex-1 font-mono text-[11px] text-muted-foreground">
					{#if a.kind === 'closeout'}<span class="text-ok">CLOSEOUT</span> ·{/if}
					{a.uploaded_by ?? ''}
					<Timestamp value={a.created_at} />
					{#if a.note}<div class="font-sans text-xs text-foreground">{a.note}</div>{/if}
				</div>
			</div>
		{/each}
	</div>
{/snippet}
