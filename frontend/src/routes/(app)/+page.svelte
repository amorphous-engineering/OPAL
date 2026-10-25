<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		DataTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp,
		type Column,
		type Tone
	} from '#lib/components/opal/index.js';
	import { FilterSelect } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { changeSummary, type AuditEntry } from '#lib/components/audit/audit.js';
	import type {
		ExecutionRow,
		IssueRow,
		LowStockRow,
		PurchaseRow,
		RiskRow,
		StockAttentionRow
	} from '#lib/components/overview/types.js';
	import { qty, stateLabel } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const o = $derived(data.overview);

	// The page answers "what needs me now": keep it fresh without a manual reload.
	onMount(() => {
		const t = setInterval(() => {
			if (document.visibilityState === 'visible') invalidate('app:overview');
		}, 60_000);
		return () => clearInterval(t);
	});

	const CREATE = [
		['Part', '/parts/new'],
		['Template', '/procedures/new'],
		['Execution', '/executions/new'],
		['Issue', '/issues/new'],
		['Risk', '/risks/new'],
		['Dataset', '/datasets/new']
	] as const;

	interface Stat {
		label: string;
		value: number;
		sub: string;
		tone: Tone;
		href: string;
	}

	const stats = $derived<Stat[]>([
		{
			label: 'Open issues',
			value: o.issues.counts.open,
			sub: `${o.issues.counts.critical} critical · ${o.issues.counts.high} high`,
			tone: o.issues.counts.critical > 0 ? 'error' : 'default',
			href: '/issues?status=open'
		},
		{
			label: 'Assigned to you',
			value: o.issues.counts.mine,
			sub: `${o.issues.counts.unassigned} unassigned`,
			tone: 'default',
			href: '/issues?status=open&assignee=me'
		},
		{
			label: 'Executions active',
			value: o.executions.total,
			sub: `${o.executions.flagged} blocked or overdue`,
			tone: o.executions.flagged > 0 ? 'warn' : 'default',
			href: '/executions'
		},
		{
			label: 'Low stock',
			value: o.lowStock.total,
			sub: 'below reorder point',
			tone: o.lowStock.total > 0 ? 'warn' : 'default',
			href: '/inventory?flag=low'
		},
		{
			label: 'POs awaiting receipt',
			value: o.purchases.total,
			sub: `${o.purchases.flagged} overdue`,
			tone: o.purchases.flagged > 0 ? 'warn' : 'default',
			href: '/purchases?status=awaiting'
		},
		{
			label: 'Calibration / expiry',
			value: o.stockAttention.total,
			sub: `${o.stockAttention.flagged} overdue or expired`,
			tone: o.stockAttention.flagged > 0 ? 'error' : o.stockAttention.total ? 'warn' : 'default',
			href: '/inventory?flag=attention'
		},
		{
			label: 'High risks',
			value: o.risks.total,
			sub: 'open, score above 12',
			tone: o.risks.total > 0 ? 'warn' : 'default',
			href: '/risks?severity=high&active=1'
		}
	]);

	const valueClass: Record<Tone, string> = {
		ok: 'text-ok',
		warn: 'text-warn',
		error: 'text-error',
		info: 'text-info',
		muted: 'text-muted-foreground',
		default: 'text-foreground'
	};

	const priorityTone = (p: string): Tone =>
		p === 'critical' ? 'error' : p === 'high' ? 'warn' : 'muted';

	const issueCols: Column<IssueRow>[] = [
		{ key: 'issueNumber', label: 'Issue', width: '6rem' },
		{ key: 'title', label: 'Title', class: 'max-w-0' },
		{ key: 'priority', label: 'Priority', width: '5.5rem' },
		{ key: 'assignee', label: 'Assignee', width: '9rem' },
		{ key: 'holding', label: 'Hold', width: '3.5rem' }
	];
	const execCols: Column<ExecutionRow>[] = [
		{ key: 'label', label: 'Execution', width: '8rem' },
		{ key: 'procedure', label: 'Template' },
		{ key: 'progress', label: 'Steps', align: 'right', width: '5rem', mono: true },
		{ key: 'flag', label: 'Flag', width: '7rem' },
		{ key: 'targetCompletionAt', label: 'Due', width: '6.5rem' }
	];
	const stockCols: Column<LowStockRow>[] = [
		{ key: 'partNumber', label: 'PN', width: '8rem' },
		{ key: 'name', label: 'Name' },
		{ key: 'onHand', label: 'On hand', align: 'right', mono: true, width: '6rem' },
		{ key: 'reorderPoint', label: 'Reorder at', align: 'right', mono: true, width: '6rem' }
	];
	const poCols: Column<PurchaseRow>[] = [
		{ key: 'reference', label: 'PO', width: '7rem' },
		{ key: 'supplier', label: 'Supplier' },
		{ key: 'status', label: 'Status', width: '5.5rem' },
		{ key: 'targetDate', label: 'Due', width: '6.5rem' },
		{ key: 'linesOpen', label: 'Open lines', align: 'right', mono: true, width: '5.5rem' }
	];
	const attentionCols: Column<StockAttentionRow>[] = [
		{ key: 'opalNumber', label: 'OPAL', width: '8rem' },
		{ key: 'partNumber', label: 'PN', width: '8rem' },
		{ key: 'partName', label: 'Name' },
		{ key: 'kind', label: 'Condition', width: '7.5rem' },
		{ key: 'due', label: 'Date', width: '6.5rem' }
	];
	const riskCols: Column<RiskRow>[] = [
		{ key: 'riskNumber', label: 'Risk', width: '6rem' },
		{ key: 'title', label: 'Title' },
		{ key: 'score', label: 'Score', align: 'right', mono: true, width: '4rem' },
		{ key: 'disposition', label: 'Disposition', width: '6.5rem' }
	];
	/** Consecutive entries by the same person doing the same thing to the same record: one row. */
	interface ActivityRow extends AuditEntry {
		times: number;
		summary: string;
	}
	const activity = $derived.by(() => {
		const rows: ActivityRow[] = [];
		for (const e of o.activity) {
			const prev = rows.at(-1);
			const summary = changeSummary(e);
			if (
				prev &&
				prev.userId === e.userId &&
				prev.action === e.action &&
				prev.entity === e.entity &&
				prev.recordLabel === e.recordLabel &&
				prev.href === e.href
			) {
				prev.times += 1;
				if (!prev.summary.split(', ').includes(summary))
					prev.summary = `${prev.summary}, ${summary}`;
				continue;
			}
			rows.push({ ...e, times: 1, summary });
		}
		return rows;
	});

	const activityCols: Column<ActivityRow>[] = [
		{ key: 'at', label: 'When', width: '9rem' },
		{ key: 'userName', label: 'User', width: '9rem' },
		{ key: 'action', label: 'Action', width: '5rem' },
		{ key: 'entityLabel', label: 'Entity', width: '9rem' },
		{ key: 'recordLabel', label: 'Record', width: '16rem' },
		{ key: 'change', label: 'Change' }
	];

	const conditionLabel = {
		calibration_overdue: 'CAL OVERDUE',
		expired: 'EXPIRED',
		expiring: 'EXPIRING'
	};
	const conditionTone = {
		calibration_overdue: 'error',
		expired: 'error',
		expiring: 'warn'
	} as const;
	const dash = '—';

	/** Header count only when the list is cut short; the strip above carries the totals. */
	const shown = (c: { items: unknown[]; total: number }) =>
		c.total > c.items.length ? `${c.items.length} of ${c.total}` : undefined;
</script>

<PageHeader title="Overview">
	{#snippet actions()}
		<FilterSelect
			param="project"
			label="Project"
			allLabel="All projects"
			options={data.projects.map((p) => ({ value: String(p.id), label: p.code }))}
		/>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button variant="outline" class="gap-2 font-mono font-normal tracking-wider" {...props}
						>+ NEW</Button
					>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-40">
				{#each CREATE as [label, href] (href)}
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a {href} {...props}>{label}</a>
						{/snippet}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/snippet}
</PageHeader>

<div class="space-y-4 p-4">
	<div
		class="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-4 xl:grid-cols-7"
		aria-label="Attention summary"
	>
		{#each stats as s (s.label)}
			<a
				href={s.href}
				class="border-r border-b border-border px-3 py-2 hover:bg-accent/60 xl:border-b-0"
			>
				<div class="label">{s.label}</div>
				<div
					class="font-mono text-2xl leading-8 tabular-nums {s.value === 0
						? 'text-muted-foreground/50'
						: `font-semibold ${valueClass[s.tone]}`}"
				>
					{s.value}
				</div>
				<div
					class="font-mono text-xs {s.value === 0
						? 'text-muted-foreground/50'
						: 'text-muted-foreground'}"
				>
					{s.sub}
				</div>
			</a>
		{/each}
	</div>

	<div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
		{#if o.issues.items.length}
			<Section title="Issues" count={shown(o.issues)}>
				{#snippet actions()}
					<a
						href="/issues?status=open"
						class="font-mono text-xs text-info uppercase hover:underline">All open</a
					>
				{/snippet}
				<DataTable
					rows={o.issues.items}
					columns={issueCols}
					href={(r) => r.href}
					key={(r) => r.issueNumber}
					emptyLabel="OPEN ISSUES"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'issueNumber'}
							<span class="font-mono whitespace-nowrap text-info">{r.issueNumber}</span>
						{:else if col.key === 'title'}
							<span class="block truncate {r.mine ? 'font-medium' : ''}" title={r.title}
								>{r.title}</span
							>
						{:else if col.key === 'priority'}
							<State value={r.priority} tone={priorityTone(r.priority)} />
						{:else if col.key === 'assignee'}
							{#if r.mine}<span class="font-medium">You</span>
							{:else if r.assignee}{r.assignee}
							{:else}<span class="text-muted-foreground">{dash}</span>{/if}
						{:else if r.holding}
							<State value="hold" tone="warn" label="HOLD" />
						{:else}
							<span class="text-muted-foreground">{dash}</span>
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		{#if o.executions.items.length}
			<Section title="Executions" count={shown(o.executions)}>
				{#snippet actions()}
					<a href="/executions" class="font-mono text-xs text-info uppercase hover:underline">All</a
					>
				{/snippet}
				<DataTable
					rows={o.executions.items}
					columns={execCols}
					href={(r) => r.href}
					key={(r) => r.href}
					emptyLabel="ACTIVE EXECUTIONS"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'label'}
							<span class="whitespace-nowrap"
								><span class="font-mono text-info">{r.label}</span>{#if r.mine}<span
										class="ml-1 font-mono text-xs text-muted-foreground">YOU</span
									>{/if}</span
							>
						{:else if col.key === 'procedure'}
							<span class="block truncate" title={r.procedure ?? undefined}
								>{r.procedure ?? dash}</span
							>
						{:else if col.key === 'progress'}
							{r.stepsDone}/{r.stepsTotal}
						{:else if col.key === 'flag'}
							{#if r.blocked}<State value="blocked" tone="error" label="BLOCKED" />
							{:else if r.overdue}<State value="overdue" tone="warn" label="OVERDUE" />
							{:else if r.status === 'cut'}<span
									class="font-mono text-xs whitespace-nowrap text-muted-foreground"
									>NOT STARTED</span
								>
							{:else}<span class="text-muted-foreground">{dash}</span>{/if}
						{:else}
							<Timestamp value={r.targetCompletionAt} dateOnly />
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		{#if o.lowStock.items.length}
			<Section title="Low stock" count={shown(o.lowStock)}>
				{#snippet actions()}
					<a
						href="/inventory?flag=low"
						class="font-mono text-xs text-info uppercase hover:underline">All</a
					>
				{/snippet}
				<DataTable
					rows={o.lowStock.items}
					columns={stockCols}
					href={(r) => r.href}
					key={(r) => r.href}
					emptyLabel="LOW STOCK"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'partNumber'}
							<span class="font-mono whitespace-nowrap text-info">{r.partNumber ?? dash}</span>
						{:else if col.key === 'name'}
							{r.name}
						{:else if col.key === 'onHand'}
							<span class={Number(r.onHand) === 0 ? 'text-error' : 'text-warn'}
								>{qty(r.onHand, r.uom)}</span
							>
						{:else}
							{qty(r.reorderPoint, r.uom)}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		{#if o.purchases.items.length}
			<Section title="Purchases awaiting receipt" count={shown(o.purchases)}>
				{#snippet actions()}
					<a
						href="/purchases?status=awaiting"
						class="font-mono text-xs text-info uppercase hover:underline">All</a
					>
				{/snippet}
				<DataTable
					rows={o.purchases.items}
					columns={poCols}
					href={(r) => r.href}
					key={(r) => r.href}
					emptyLabel="PURCHASES AWAITING RECEIPT"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'reference'}
							<span class="font-mono whitespace-nowrap text-info">{r.reference}</span>
						{:else if col.key === 'supplier'}
							{r.supplier}
						{:else if col.key === 'status'}
							<State value={r.status} tone={r.status === 'partial' ? 'warn' : 'muted'} />
						{:else if col.key === 'targetDate'}
							{#if r.overdue}<span class="text-error"
									><Timestamp value={r.targetDate} dateOnly /></span
								>
							{:else}<Timestamp value={r.targetDate} dateOnly />{/if}
						{:else}
							{r.linesOpen}
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		{#if o.stockAttention.items.length}
			<Section title="Calibration and expiry" count={shown(o.stockAttention)}>
				{#snippet actions()}
					<a
						href="/inventory?flag=attention"
						class="font-mono text-xs text-info uppercase hover:underline">Stock</a
					>
				{/snippet}
				<DataTable
					rows={o.stockAttention.items}
					columns={attentionCols}
					href={(r) => r.href}
					key={(r) => `${r.opalNumber}-${r.kind}`}
					emptyLabel="CALIBRATION AND EXPIRY"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'opalNumber'}
							<span class="font-mono whitespace-nowrap text-info">{r.opalNumber ?? dash}</span>
						{:else if col.key === 'partNumber'}
							<span class="font-mono whitespace-nowrap">{r.partNumber ?? dash}</span>
						{:else if col.key === 'partName'}
							{r.partName}
						{:else if col.key === 'kind'}
							<State value={r.kind} tone={conditionTone[r.kind]} label={conditionLabel[r.kind]} />
						{:else}
							<Timestamp value={r.due} dateOnly />
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}

		{#if o.risks.items.length}
			<Section title="High risks" count={shown(o.risks)}>
				{#snippet actions()}
					<a
						href="/risks?severity=high&active=1"
						class="font-mono text-xs text-info uppercase hover:underline">All</a
					>
				{/snippet}
				<DataTable
					rows={o.risks.items}
					columns={riskCols}
					href={(r) => r.href}
					key={(r) => r.riskNumber}
					emptyLabel="HIGH RISKS"
					dense
				>
					{#snippet cell(r, col)}
						{#if col.key === 'riskNumber'}
							<span class="font-mono whitespace-nowrap text-info">{r.riskNumber}</span>
						{:else if col.key === 'title'}
							{r.title}
						{:else if col.key === 'score'}
							<span class="text-error">{r.score}</span>
						{:else}
							<span class="font-mono text-xs">{stateLabel(r.disposition)}</span>
						{/if}
					{/snippet}
				</DataTable>
			</Section>
		{/if}
	</div>

	{#if o.activity.length}
		<Section title="Recent activity">
			{#snippet actions()}
				<a href="/audit" class="font-mono text-xs text-info uppercase hover:underline">Audit log</a>
			{/snippet}
			<DataTable
				rows={activity}
				columns={activityCols}
				href={(r) => r.href}
				key={(r) => r.id}
				emptyLabel="ACTIVITY"
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'at'}
						<Timestamp value={r.at} />
					{:else if col.key === 'userName'}
						{r.userName ?? dash}
					{:else if col.key === 'action'}
						<span
							class="font-mono text-xs uppercase {r.action === 'delete'
								? 'text-error'
								: 'text-muted-foreground'}">{r.action}</span
						>
					{:else if col.key === 'entityLabel'}
						{r.entityLabel}{#if r.times > 1}<span
								class="ml-1.5 font-mono text-xs text-muted-foreground">×{r.times}</span
							>{/if}
					{:else if col.key === 'recordLabel'}
						{#if r.recordLabel}<span
								class="block truncate {r.href ? 'text-info' : ''}"
								title={r.recordLabel}>{r.recordLabel}</span
							>{:else}<span class="text-muted-foreground">{dash}</span>{/if}
					{:else}
						<span class="font-mono text-xs text-muted-foreground">{r.summary}</span>
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<EmptyLine label="ACTIVITY" />
	{/if}
</div>
