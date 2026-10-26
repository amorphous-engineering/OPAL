<script lang="ts">
	// The DETAILS tab: time worked, evidence and work-order facts — the record around
	// the work rather than the work itself.
	import { cn } from '#lib/utils.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		Avatar,
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		Section,
		Timestamp
	} from '#lib/components/opal/index.js';
	import {
		attachmentUrl,
		byPerson,
		clock,
		gallery,
		liveSeconds
	} from '#lib/components/procedure-doc/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { workTime } from '#lib/format.js';
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

	// Time worked, live while anyone is clocked in.
	const now = $derived(doc.labor.some((l) => l.since) ? clock.now : Date.now());
	const opTime = $derived(
		ops
			.map((op) => {
				const ls = doc.labor.filter((l) => l.op_order === op.order);
				return {
					order: op.order,
					number: op.number,
					title: op.title,
					people: ls.length,
					clocked_in: ls.filter((l) => l.since).length,
					seconds: ls.reduce((n, l) => n + liveSeconds(l, now), 0)
				};
			})
			.filter((r) => r.people)
	);
	const personTime = $derived(byPerson(doc.labor, now));
	const total = $derived(opTime.reduce((n, r) => n + r.seconds, 0));
	const opCols: Column<(typeof opTime)[number]>[] = [
		{ key: 'number', label: 'OP', mono: true, width: '4rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'people', label: 'People', mono: true, align: 'right', width: '6rem' },
		{ key: 'seconds', label: 'Time', mono: true, align: 'right', width: '8rem' }
	];
	const personCols: Column<(typeof personTime)[number]>[] = [
		{ key: 'name', label: 'Person' },
		{ key: 'ops', label: 'OPs', mono: true, align: 'right', width: '5rem' },
		{ key: 'seconds', label: 'Time', mono: true, align: 'right', width: '8rem' }
	];
</script>

<div
	class="grid max-w-5xl min-w-0 grid-cols-1 content-start gap-3 [overflow-wrap:anywhere] [&_table]:table-fixed"
>
	{#if rows.length || doc.attachments.length}
		<Section
			title="Attachments"
			count={rows.length || doc.attachments.length
				? rows.reduce((n, s) => n + s.attachments.length, doc.attachments.length)
				: undefined}
		>
			<div class="grid grid-cols-1">
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

	{#if opTime.length}
		<Section title="Time" count={workTime(total)}>
			<DataTable rows={opTime} columns={opCols} emptyLabel="Time" key={(r) => r.order}>
				{#snippet cell(r, col)}
					{#if col.key === 'number'}
						<button type="button" class="hover:underline" onclick={() => onjump(r.order)}
							>{r.number}</button
						>
					{:else if col.key === 'people'}
						{r.people}{#if r.clocked_in}<span class="text-info">{` · ${r.clocked_in} IN`}</span
							>{/if}
					{:else if col.key === 'seconds'}
						{workTime(r.seconds)}
					{:else}
						{r.title}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
		<Section title="Time by person" count={personTime.length}>
			<DataTable rows={personTime} columns={personCols} emptyLabel="Time" key={(r) => r.user_id}>
				{#snippet cell(r, col)}
					{#if col.key === 'name'}
						<span class="flex items-center gap-2">
							<Avatar user={{ id: r.user_id, name: r.name, avatar_url: r.avatar_url }} size="xs" />
							<span class="truncate">{r.name ?? '—'}</span>
							{#if r.clocked_in}<Badge
									variant="outline"
									class="border-info/50 bg-info-muted font-mono tracking-wider text-info">IN</Badge
								>{/if}
						</span>
					{:else if col.key === 'ops'}
						{r.ops}
					{:else}
						{workTime(r.seconds)}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine label="Time" />
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
			<DetailRow label="Project"
				><a class="text-info hover:underline" href={`/projects/${inst.project.id}`}
					>{inst.project.code}</a
				>
				{inst.project.name}</DetailRow
			>
			<DetailRow label="Priority" value={inst.priority.toUpperCase()} />
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
	<div class="grid grid-cols-1 gap-1.5" use:gallery>
		{#each list as a (a.id)}
			<div class="flex flex-wrap items-start gap-x-2 gap-y-0.5">
				{#if a.mime_type.startsWith('image/')}
					<a
						data-pswp
						href={attachmentUrl(a.id)}
						data-pswp-caption={a.note ?? a.filename}
						class="shrink-0 rounded-md border border-border"
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
				<div class="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
					{#if a.kind === 'closeout'}<span class="text-ok">CLOSEOUT</span> ·{/if}
					{a.uploaded_by ?? ''}
					<Timestamp value={a.created_at} />
					{#if a.note}<div class="font-sans text-xs text-foreground">{a.note}</div>{/if}
				</div>
			</div>
		{/each}
	</div>
{/snippet}
