<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { PageHeader, State, Timestamp, EmptyLine } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
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
	const action = $derived(q.get('action') ?? '');
	const user = $derived(q.get('user') ?? '');
	const from = $derived(q.get('from') ?? '');
	const to = $derived(q.get('to') ?? '');
	const record = $derived(q.get('record') ?? '');
	const filtered = $derived(!!(entity || action || user || from || to || record));
	const pages = $derived(Math.max(1, Math.ceil(data.total / AUDIT_PAGE_SIZE)));
	const first = $derived(data.total === 0 ? 0 : (data.page - 1) * AUDIT_PAGE_SIZE + 1);
	const last = $derived(Math.min(data.total, data.page * AUDIT_PAGE_SIZE));

	let open = $state<Record<number, boolean>>({});
	let allOpen = $state(false);
	const isOpen = (e: AuditEntry) => open[e.id] ?? allOpen;

	function setParams(changes: Record<string, string | null>) {
		const next = new SvelteURLSearchParams(page.url.search);
		for (const [k, v] of Object.entries(changes)) {
			if (v) next.set(k, v);
			else next.delete(k);
		}
		if (!('page' in changes)) next.delete('page');
		const qs = next.toString();
		goto(qs ? `?${qs}` : page.url.pathname, { reset: false });
	}

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
	{#snippet actions()}
		<Button variant="outline" size="sm" onclick={undoLast}>UNDO LAST CHANGE</Button>
	{/snippet}
</PageHeader>

<div class="space-y-3 p-4">
	<form
		class="flex flex-wrap items-end gap-x-3 gap-y-2"
		onsubmit={(e) => e.preventDefault()}
		aria-label="Audit filters"
	>
		<label class="grid gap-1">
			<span class="label">Entity</span>
			<NativeSelect
				size="sm"
				value={entity}
				onchange={(e) => setParams({ entity: e.currentTarget.value, record: null })}
			>
				<NativeSelectOption value="">All</NativeSelectOption>
				{#each data.facets.entity_types as t (t.value)}
					<NativeSelectOption value={t.value}>{t.label}</NativeSelectOption>
				{/each}
			</NativeSelect>
		</label>
		<label class="grid gap-1">
			<span class="label">Action</span>
			<NativeSelect
				size="sm"
				value={action}
				onchange={(e) => setParams({ action: e.currentTarget.value })}
			>
				<NativeSelectOption value="">All</NativeSelectOption>
				<NativeSelectOption value="create">Create</NativeSelectOption>
				<NativeSelectOption value="update">Update</NativeSelectOption>
				<NativeSelectOption value="delete">Delete</NativeSelectOption>
			</NativeSelect>
		</label>
		<label class="grid gap-1">
			<span class="label">User</span>
			<NativeSelect
				size="sm"
				value={user}
				onchange={(e) => setParams({ user: e.currentTarget.value })}
			>
				<NativeSelectOption value="">All</NativeSelectOption>
				{#each data.facets.users as u (u.id)}
					<NativeSelectOption value={String(u.id)}>{u.name}</NativeSelectOption>
				{/each}
			</NativeSelect>
		</label>
		<label class="grid gap-1">
			<span class="label">From</span>
			<Input
				type="date"
				class="h-7 w-36"
				value={from}
				max={to || undefined}
				onchange={(e) => setParams({ from: e.currentTarget.value })}
			/>
		</label>
		<label class="grid gap-1">
			<span class="label">To</span>
			<Input
				type="date"
				class="h-7 w-36"
				value={to}
				min={from || undefined}
				onchange={(e) => setParams({ to: e.currentTarget.value })}
			/>
		</label>
		{#if record && entity}
			<div class="flex h-7 items-center gap-2 border border-border px-2 font-mono text-xs">
				<span class="text-muted-foreground uppercase">Record</span>
				<span>{recordEntry?.record_label ?? recordEntry?.entity_label ?? entity}</span>
				<button
					type="button"
					class="text-info hover:underline"
					onclick={() => setParams({ record: null })}>ALL</button
				>
			</div>
		{/if}
		{#if filtered}
			<Button variant="ghost" size="sm" href={page.url.pathname}>CLEAR FILTERS</Button>
		{/if}
		<div class="ml-auto flex items-center gap-3 font-mono text-xs text-muted-foreground">
			<span>{first}–{last} of {data.total.toLocaleString()}</span>
			<button type="button" class="text-info hover:underline" onclick={toggleAll}
				>{allOpen ? 'COLLAPSE ALL' : 'EXPAND ALL'}</button
			>
		</div>
	</form>

	{#if data.items.length === 0}
		<div class="border border-border bg-card">
			<EmptyLine label={filtered ? 'AUDIT ENTRIES MATCHING' : 'AUDIT ENTRIES'} />
		</div>
	{:else}
		<div class="overflow-x-auto border border-border bg-card">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each ['When', 'User', 'Action', 'Entity', 'Record', 'Change'] as h (h)}
							<th
								scope="col"
								class="h-8 px-3 text-left font-mono text-[11px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
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
										setParams({ entity: e.entity_type, record: null });
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

		{#if pages > 1}
			<nav class="flex items-center gap-2 font-mono text-xs" aria-label="Pages">
				<Button
					variant="outline"
					size="xs"
					disabled={data.page <= 1}
					onclick={() => setParams({ page: data.page > 2 ? String(data.page - 1) : null })}
					>← NEWER</Button
				>
				<span class="text-muted-foreground">PAGE {data.page} / {pages}</span>
				<Button
					variant="outline"
					size="xs"
					disabled={data.page >= pages}
					onclick={() => setParams({ page: String(data.page + 1) })}>OLDER →</Button
				>
			</nav>
		{/if}
	{/if}
</div>
