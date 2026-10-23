<script lang="ts">
	import { page } from '$app/state';
	import {
		EmptyLine,
		FilterBar,
		FilterDate,
		FilterSelect,
		ListFrame,
		PageHeader,
		Pagination,
		State,
		Timestamp,
		hasParams,
		setQuery
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		AUDIT_PAGE_SIZE,
		actionTone,
		changeSummary,
		fieldName,
		formatValue,
		type AuditEntry
	} from '#lib/components/audit/audit.js';
	import ChangesTable from '#lib/components/audit/ChangesTable.svelte';
	import { undoLast } from '#lib/components/shell/undo.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(page.url.searchParams);
	const entity = $derived(q.get('entity') ?? '');
	const from = $derived(q.get('from') ?? '');
	const to = $derived(q.get('to') ?? '');
	const record = $derived(q.get('record') ?? '');
	const FILTERS = ['entity', 'action', 'user', 'from', 'to', 'record'];
	const filtered = $derived.by(() => {
		void page.url.search;
		return hasParams(FILTERS);
	});

	let open = $state<Record<number, boolean>>({});
	let allOpen = $state(false);
	const isOpen = (e: AuditEntry) => open[e.id] ?? allOpen;

	function toggle(e: AuditEntry) {
		open[e.id] = !isOpen(e);
	}

	function toggleAll() {
		allOpen = !allOpen;
		open = {};
	}

	/** First change of an update, inline, so the row is legible without opening it. */
	function inline(e: AuditEntry): string | null {
		if (e.action !== 'update' || e.changes.length === 0) return null;
		const c = e.changes[0];
		const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
		return `${fieldName(c.field)}: ${clip(formatValue(c.old, c.old_label))} → ${clip(formatValue(c.new, c.new_label))}`;
	}

	const recordEntry = $derived(record ? data.items[0] : null);
</script>

<PageHeader title="Audit log">
	{#snippet meta()}
		<span class="mono">{data.total.toLocaleString()} {data.total === 1 ? 'entry' : 'entries'}</span>
	{/snippet}
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={undoLast}>UNDO LAST CHANGE</Button>
	{/snippet}
</PageHeader>

<ListFrame>
	<FilterBar clear={FILTERS} label="Audit filters">
		<FilterSelect
			param="entity"
			label="Entity"
			allLabel="All entities"
			alsoClear={['record']}
			options={data.facets.entity_types}
		/>
		<FilterSelect
			param="action"
			label="Action"
			allLabel="All actions"
			options={[
				{ value: 'create', label: 'Create' },
				{ value: 'update', label: 'Update' },
				{ value: 'delete', label: 'Delete' }
			]}
		/>
		<FilterSelect
			param="user"
			label="User"
			allLabel="All users"
			options={data.facets.users.map((u) => ({ value: String(u.id), label: u.name }))}
		/>
		<FilterDate param="from" label="From" max={to || undefined} />
		<FilterDate param="to" label="To" min={from || undefined} />
		{#if record && entity}
			<div class="flex h-7 items-center gap-2 border border-border px-2 font-mono text-xs">
				<span class="text-muted-foreground uppercase">Record</span>
				<span>{recordEntry?.record_label ?? recordEntry?.entity_label ?? entity}</span>
				<button
					type="button"
					class="text-info hover:underline"
					onclick={() => setQuery({ record: null })}>ALL</button
				>
			</div>
		{/if}
		{#snippet end()}
			<button type="button" class="font-mono text-xs text-info hover:underline" onclick={toggleAll}
				>{allOpen ? 'COLLAPSE ALL' : 'EXPAND ALL'}</button
			>
		{/snippet}
	</FilterBar>

	{#if data.items.length === 0}
		<EmptyLine label="AUDIT ENTRIES">
			{#snippet action()}
				{#if filtered}
					<a href={page.url.pathname} class="font-medium text-info hover:underline">CLEAR FILTERS</a
					>
				{/if}
			{/snippet}
		</EmptyLine>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each ['When', 'User', 'Action', 'Entity', 'Record', 'Change'] as h (h)}
							<th
								scope="col"
								class="h-8 px-3 text-left font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
								>{h}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each data.items as e (e.id)}
						{@const expanded = isOpen(e)}
						<tr
							class="cursor-pointer border-b border-border align-top hover:bg-accent/60 {expanded
								? 'bg-accent/40'
								: ''}"
							onclick={(ev) => {
								if (!(ev.target as HTMLElement).closest('a, button')) toggle(e);
							}}
						>
							<td class="px-3 py-1.5 whitespace-nowrap">
								<button
									type="button"
									class="text-left"
									aria-expanded={expanded}
									aria-label="Toggle field changes"
									onclick={() => toggle(e)}
								>
									<Timestamp value={e.timestamp} />
								</button>
							</td>
							<td class="px-3 py-1.5 whitespace-nowrap">
								{#if e.user_name}
									<a href="/users/{e.user_id}" class="hover:underline">{e.user_name}</a>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-3 py-1.5">
								<State
									value={e.action}
									tone={actionTone[e.action as keyof typeof actionTone] ?? 'default'}
								/>
							</td>
							<td class="px-3 py-1.5 whitespace-nowrap">
								<a
									href="?{new URLSearchParams({ entity: e.entity_type })}"
									class="hover:underline"
									onclick={(ev) => {
										ev.preventDefault();
										setQuery({ entity: e.entity_type, record: null });
									}}>{e.entity_label}</a
								>
							</td>
							<td class="px-3 py-1.5 whitespace-nowrap">
								{#if e.href && e.record_label}
									<a href={e.href} class="font-mono text-info hover:underline">{e.record_label}</a>
								{:else if e.record_label}
									<span class="font-mono">{e.record_label}</span>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</td>
							<td class="px-3 py-1.5">
								<span class="font-mono text-xs">{changeSummary(e)}</span>
								{#if inline(e) && !expanded}
									<div class="font-mono text-xs break-words text-muted-foreground">
										{inline(e)}
									</div>
								{/if}
							</td>
						</tr>
						{#if expanded}
							<tr class="border-b border-border bg-muted/30">
								<td colspan="6" class="p-0">
									<div class="py-1 pl-6">
										<ChangesTable entry={e} />
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>

		<Pagination total={data.total} pageSize={AUDIT_PAGE_SIZE} />
	{/if}
</ListFrame>
