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
	import { attachmentUrl, gallery } from '#lib/components/procedure-doc/index.js';
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
	const priorityLabel = ['NORMAL', 'HIGH', 'URGENT'];
</script>

<div
	class="grid max-w-5xl min-w-0 content-start gap-3 [overflow-wrap:anywhere] [&_table]:table-fixed"
>
	{#if rows.length || doc.attachments.length}
		<Section
			title="Attachments"
			count={rows.length || doc.attachments.length
				? rows.reduce((n, s) => n + s.attachments.length, doc.attachments.length)
				: undefined}
		>
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
		<EmptyLine label="Attachments" />
	{/if}

	<Section title="Facts">
		{#snippet actions()}
			{#if inst.active}<Button size="xs" variant="ghost" onclick={onedit}>EDIT</Button>{/if}
		{/snippet}
		<DetailTable>
			<DetailRow label="Procedure"
				><a
					class="text-info hover:underline"
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
	<div class="grid gap-1.5" use:gallery>
		{#each list as a (a.id)}
			<div class="flex flex-wrap items-start gap-x-2 gap-y-0.5">
				{#if a.mime_type.startsWith('image/')}
					<a
						data-pswp
						href={attachmentUrl(a.id)}
						data-pswp-caption={a.note ?? a.filename}
						class="shrink-0 border border-border"
						aria-label={`Enlarge ${a.filename}`}
					>
						<img
							loading="lazy"
							src={attachmentUrl(a.id)}
							alt={a.filename}
							class="size-12 object-cover"
						/>
					</a>
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
