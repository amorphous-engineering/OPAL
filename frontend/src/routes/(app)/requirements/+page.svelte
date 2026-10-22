<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		DataTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { api } from '#lib/api.js';
	import { stateLabel } from '#lib/format.js';
	import LintedText from '#lib/components/requirements/LintedText.svelte';
	import QuickCreate, { type QuickParent } from '#lib/components/requirements/QuickCreate.svelte';
	import StatusPanel from '#lib/components/requirements/StatusPanel.svelte';
	import {
		LEVELS,
		LIFECYCLE_STATES,
		lifecycleTone,
		methodInitial,
		verificationLabel,
		verificationTone
	} from '#lib/components/requirements/lifecycle.js';
	import type { TreeItem } from '#lib/components/requirements/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// ---- filters live in the URL ----
	const params = $derived(page.url.searchParams);
	const q = $derived(params.get('q') ?? '');
	const stFilter = $derived(params.get('state') ?? '');
	const level = $derived(params.get('level') ?? '');
	const verif = $derived(params.get('verif') ?? '');
	const staleOnly = $derived(params.get('stale') === '1');
	const view = $derived(
		params.get('view') === 'list' || stFilter === 'superseded' ? 'list' : 'tree'
	);

	function setParam(key: string, value: string | null) {
		const next = new URL(page.url.href);
		if (value) next.searchParams.set(key, value);
		else next.searchParams.delete(key);
		goto(next, { replace: true, reset: false });
	}

	const filtering = $derived(!!(q || stFilter || level || verif || staleOnly));

	function matches(i: TreeItem): boolean {
		if (stFilter && i.lifecycle_state !== stFilter) return false;
		if (level !== '' && String(i.level) !== level) return false;
		if (verif && i.verification !== verif) return false;
		if (staleOnly && !i.stale) return false;
		if (q) {
			const hay = `${i.req_number} ${i.title} ${i.statement}`.toLowerCase();
			if (!hay.includes(q.toLowerCase().trim())) return false;
		}
		return true;
	}

	// Superseded revisions are not in the tree payload; fetch them on request.
	let superseded = $state<TreeItem[]>([]);
	$effect(() => {
		if (stFilter !== 'superseded') return;
		api
			.get<{ items: Record<string, unknown>[] }>('/requirements', {
				state: 'superseded',
				include_superseded: true,
				page_size: 500
			})
			.then((r) => {
				superseded = r.items.map(
					(x) =>
						({
							...x,
							parent_id: null,
							orphan: false,
							lint: [],
							parts: [],
							verification: 'unallocated'
						}) as unknown as TreeItem
				);
			})
			.catch(() => (superseded = []));
	});

	const items = $derived(stFilter === 'superseded' ? superseded : data.tree.items);

	// ---- tree ----
	const kids = $derived.by(() => {
		const m: Record<string, TreeItem[]> = {};
		for (const i of items) (m[String(i.parent_id)] ??= []).push(i);
		return m;
	});

	let collapsed = $state<number[]>([]);
	let expanded = $state<number[]>([]);
	let focusedId = $state<number | null>(null);

	onMount(() => {
		// Deep link from the command palette: /requirements?new=l0
		if (page.url.searchParams.get('new') === 'l0') {
			setParam('new', null);
			flowDown(null);
		}
		try {
			collapsed = JSON.parse(localStorage.getItem('opal_req_tree_collapsed') ?? '[]');
		} catch {
			/* storage unavailable: start expanded */
		}
	});

	function saveCollapsed() {
		try {
			localStorage.setItem('opal_req_tree_collapsed', JSON.stringify(collapsed));
		} catch {
			/* per-viewer convenience only */
		}
	}

	function toggleFold(id: number, fold?: boolean) {
		const folded = collapsed.includes(id);
		const want = fold ?? !folded;
		if (want === folded) return;
		collapsed = want ? [...collapsed, id] : collapsed.filter((x) => x !== id);
		saveCollapsed();
	}

	interface Row {
		item: TreeItem;
		depth: number;
		dim: boolean;
		hasKids: boolean;
		folded: boolean;
	}

	const rows = $derived.by(() => {
		const hasMatch = (i: TreeItem, seen: number[]): boolean =>
			matches(i) ||
			(kids[String(i.id)] ?? []).some((c) => !seen.includes(c.id) && hasMatch(c, [...seen, c.id]));
		const out: Row[] = [];
		const walk = (i: TreeItem, depth: number, seen: number[]) => {
			const k = kids[String(i.id)] ?? [];
			const self = !filtering || matches(i);
			if (filtering && !self && !hasMatch(i, seen)) return;
			const folded = !filtering && collapsed.includes(i.id);
			out.push({ item: i, depth, dim: filtering && !self, hasKids: k.length > 0, folded });
			if (folded) return;
			for (const c of k) if (!seen.includes(c.id)) walk(c, depth + 1, [...seen, c.id]);
		};
		for (const root of kids['null'] ?? []) walk(root, 0, [root.id]);
		return out;
	});

	const listRows = $derived(items.filter(matches));

	// ---- quick create ----
	let qcOpen = $state(false);
	let qcParent = $state<QuickParent | null>(null);

	function flowDown(i: TreeItem | null) {
		qcParent = i
			? { id: i.id, req_number: i.req_number, level: i.level, category: i.category }
			: null;
		qcOpen = true;
	}

	// ---- keyboard ----
	let searchEl = $state<HTMLInputElement | null>(null);

	function onkeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select, [role="dialog"], [contenteditable]')) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === '/') {
			e.preventDefault();
			searchEl?.focus();
			return;
		}
		if (e.key === 'b' && data.tree.queue_count) {
			e.preventDefault();
			goto('/requirements/queue');
			return;
		}
		if (view !== 'tree') return;
		const idx = rows.findIndex((r) => r.item.id === focusedId);
		const cur = idx >= 0 ? rows[idx] : null;
		const move = (to: number) => {
			const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
			if (!r) return;
			focusedId = r.item.id;
			document.getElementById(`req-row-${r.item.id}`)?.scrollIntoView({ block: 'nearest' });
		};
		switch (e.key) {
			case 'j':
				e.preventDefault();
				move(idx === -1 ? 0 : idx + 1);
				break;
			case 'k':
				e.preventDefault();
				move(idx === -1 ? rows.length - 1 : idx - 1);
				break;
			case 'ArrowLeft':
				if (cur) {
					e.preventDefault();
					if (cur.hasKids && !cur.folded) toggleFold(cur.item.id, true);
					else if (cur.item.parent_id) focusedId = cur.item.parent_id;
				}
				break;
			case 'ArrowRight':
				if (cur?.hasKids) {
					e.preventDefault();
					toggleFold(cur.item.id, false);
				}
				break;
			case 'Enter':
				if (cur) {
					e.preventDefault();
					goto(`/requirements/${cur.item.id}`);
				}
				break;
			case 'c':
				if (cur) {
					e.preventDefault();
					flowDown(cur.item);
				}
				break;
		}
	}

	// ---- list columns ----
	const columns: Column<TreeItem>[] = [
		{ key: 'req_number', label: 'Number', mono: true, sortable: true, width: '7rem' },
		{ key: 'revision', label: 'Rev', mono: true, sortable: true, width: '3.5rem', align: 'right' },
		{ key: 'title', label: 'Title', sortable: true },
		{ key: 'lifecycle_state', label: 'State', sortable: true, width: '7rem' },
		{ key: 'level', label: 'L', mono: true, sortable: true, width: '3rem', align: 'right' },
		{ key: 'category', label: 'Category', sortable: true, width: '8rem' },
		{ key: 'verification', label: 'Verification', sortable: true, width: '10rem' },
		{ key: 'flags', label: 'Flags', width: '8rem' },
		{ key: 'updated_at', label: 'Updated', sortable: true, width: '6rem', align: 'right' }
	];
	let sort = $state<{ key: string; dir: 'asc' | 'desc' } | null>(null);

	const filterCount = $derived([q, stFilter, level, verif, staleOnly].filter(Boolean).length);
</script>

<svelte:window {onkeydown} />

<PageHeader title="Requirements">
	{#snippet actions()}
		<div class="flex">
			<Button
				size="sm"
				variant={view === 'tree' ? 'default' : 'outline'}
				onclick={() => setParam('view', null)}>TREE</Button
			>
			<Button
				size="sm"
				variant={view === 'list' ? 'default' : 'outline'}
				onclick={() => setParam('view', 'list')}>LIST</Button
			>
		</div>
		<Button size="sm" variant="outline" href="/requirements/baselines">BASELINES</Button>
		{#if data.tree.queue_count}
			<Button size="sm" variant="outline" href="/requirements/queue" class="text-ok"
				>BASELINE QUEUE · {data.tree.queue_count}</Button
			>
		{/if}
		<Button size="sm" href="/requirements/new">+ NEW</Button>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<StatusPanel summary={data.summary} />

	<Section
		title="REQUIREMENTS"
		count={filtering ? `${rows.length || listRows.length} of ${data.tree.total}` : data.tree.total}
	>
		<div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
			<Input
				bind:ref={searchEl}
				class="h-7 w-64"
				placeholder="Filter number, title, statement   /"
				value={q}
				oninput={(e) => setParam('q', e.currentTarget.value)}
				aria-label="Filter requirements"
			/>
			<NativeSelect
				size="sm"
				value={stFilter}
				onchange={(e) => setParam('state', e.currentTarget.value)}
				aria-label="State"
			>
				<NativeSelectOption value="">All states</NativeSelectOption>
				{#each LIFECYCLE_STATES as s (s)}
					<NativeSelectOption value={s}>{stateLabel(s)}</NativeSelectOption>
				{/each}
			</NativeSelect>
			<NativeSelect
				size="sm"
				value={level}
				onchange={(e) => setParam('level', e.currentTarget.value)}
				aria-label="Level"
			>
				<NativeSelectOption value="">All levels</NativeSelectOption>
				{#each LEVELS as l (l.value)}
					<NativeSelectOption value={String(l.value)}>{l.label}</NativeSelectOption>
				{/each}
			</NativeSelect>
			<NativeSelect
				size="sm"
				value={verif}
				onchange={(e) => setParam('verif', e.currentTarget.value)}
				aria-label="Verification"
			>
				<NativeSelectOption value="">Any verification</NativeSelectOption>
				{#each ['verified', 'partial', 'open', 'unallocated'] as v (v)}
					<NativeSelectOption value={v}
						>{verificationLabel[v as keyof typeof verificationLabel]}</NativeSelectOption
					>
				{/each}
			</NativeSelect>
			<label class="flex items-center gap-1.5 font-mono text-[11px] tracking-wider uppercase">
				<input
					type="checkbox"
					checked={staleOnly}
					onchange={(e) => setParam('stale', e.currentTarget.checked ? '1' : null)}
				/>
				Stale only
			</label>
			{#if filterCount}
				<Button
					size="xs"
					variant="ghost"
					onclick={() =>
						goto(view === 'list' ? '?view=list' : page.url.pathname, {
							replace: true,
							reset: false
						})}>CLEAR</Button
				>
			{/if}
			{#if view === 'tree'}
				<span class="ml-auto font-mono text-[11px] whitespace-nowrap text-muted-foreground"
					>j/k move · ←/→ fold · enter open · c flow down · / filter · b queue</span
				>
			{/if}
		</div>

		{#if view === 'list'}
			<DataTable
				rows={listRows}
				{columns}
				bind:sort
				href={(r) => `/requirements/${r.id}`}
				key={(r) => r.id}
				emptyLabel={filtering ? 'Matching requirements' : 'Requirements'}
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'req_number'}
						<span class="text-info">{r.req_number}</span>
					{:else if col.key === 'lifecycle_state'}
						<State value={r.lifecycle_state} tone={lifecycleTone(r.lifecycle_state)} />
					{:else if col.key === 'verification'}
						<span class="font-mono text-xs"
							>{methodInitial(r.verification_method)}
							{#if r.lifecycle_state !== 'superseded' && r.lifecycle_state !== 'cancelled'}
								<State
									value={r.verification}
									label={verificationLabel[r.verification]}
									tone={verificationTone(r.verification)}
								/>{/if}</span
						>
					{:else if col.key === 'flags'}
						<span class="flex gap-2 font-mono text-[11px] font-medium">
							{#if r.tbd}<span class="text-error">TBD</span>{/if}
							{#if r.tbr}<span class="text-warn">TBR</span>{/if}
							{#if r.stale}<span
									class="text-warn"
									title="Parent was revised after this row last got a fresh look">STALE</span
								>{/if}
						</span>
					{:else if col.key === 'updated_at'}
						<Timestamp value={r.updated_at} relative />
					{:else if col.key === 'category'}
						{r.category ?? '—'}
					{:else}
						{(r as unknown as Record<string, unknown>)[col.key] ?? '—'}
					{/if}
				{/snippet}
			</DataTable>
		{:else if rows.length === 0}
			{#if filtering}
				<EmptyLine label="Matching requirements" />
			{:else}
				<EmptyLine label="Requirements" onadd={() => flowDown(null)} />
			{/if}
		{:else}
			<div class="w-full overflow-x-auto">
				<table class="w-full border-collapse text-sm">
					<thead>
						<tr class="border-b border-border bg-muted/60">
							{#each [['Number', 'w-44'], ['Title', 'w-64'], ['Statement', ''], ['State', 'w-28'], ['L', 'w-10'], ['Verification', 'w-44'], ['Parts', 'w-44'], ['Flags', 'w-24'], ['Age', 'w-14']] as [label, w] (label)}
								<th
									scope="col"
									class="h-8 px-3 text-left font-mono text-[11px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase {w}"
									>{label}</th
								>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each rows as { item: r, depth, dim, hasKids, folded } (r.id)}
							{@const open = expanded.includes(r.id)}
							<tr
								id={`req-row-${r.id}`}
								class="border-b border-border align-top hover:bg-accent/60 {dim
									? 'opacity-50'
									: ''} {focusedId === r.id
									? 'bg-accent outline outline-1 -outline-offset-1 outline-ring'
									: ''}"
								onclick={() => (focusedId = r.id)}
								ondblclick={() => goto(`/requirements/${r.id}`)}
							>
								<td class="px-3 py-1 whitespace-nowrap" style:padding-left={`${12 + depth * 16}px`}>
									{#if hasKids}
										<button
											type="button"
											class="mr-1 inline-block w-3 font-mono text-muted-foreground hover:text-foreground"
											aria-label={folded ? 'Expand' : 'Collapse'}
											aria-expanded={!folded}
											onclick={(e) => {
												e.stopPropagation();
												toggleFold(r.id);
											}}>{folded ? '▸' : '▾'}</button
										>
									{:else}<span class="mr-1 inline-block w-3"></span>{/if}
									<a href={`/requirements/${r.id}`} class="mono text-info hover:underline"
										>{r.req_number}</a
									>
									{#if r.revision > 1}<span class="mono text-[11px] text-muted-foreground"
											>r{r.revision}</span
										>{/if}
								</td>
								<td class="px-3 py-1"
									><span class="line-clamp-1" title={r.title}>{r.title}</span></td
								>
								<td class="px-3 py-1">
									<button
										type="button"
										class="block w-full text-left font-mono text-xs"
										aria-expanded={open}
										onclick={(e) => {
											e.stopPropagation();
											expanded = open ? expanded.filter((x) => x !== r.id) : [...expanded, r.id];
										}}
									>
										<span class={open ? '' : 'line-clamp-2'}
											><LintedText text={r.statement} findings={r.lint} /></span
										>
									</button>
									{#if open}
										<div class="mt-1 text-xs text-muted-foreground">
											Rationale: {r.rationale ?? '—'}
										</div>
									{/if}
								</td>
								<td class="px-3 py-1"
									><State value={r.lifecycle_state} tone={lifecycleTone(r.lifecycle_state)} /></td
								>
								<td class="mono px-3 py-1 text-xs">{r.level}</td>
								<td class="px-3 py-1 font-mono text-xs whitespace-nowrap">
									<span title={`Verification method: ${r.verification_method ?? 'not set'}`}
										>{methodInitial(r.verification_method)}</span
									>
									{#if r.lifecycle_state !== 'cancelled'}
										<State
											value={r.verification}
											label={verificationLabel[r.verification]}
											tone={verificationTone(r.verification)}
										/>
									{/if}
								</td>
								<td class="px-3 py-1 font-mono text-xs">
									{#if r.parts.length}
										<span
											class="line-clamp-1"
											title={r.parts.map((p) => `${p.name} (${p.status})`).join(', ')}
											>{r.parts[0].name}{r.parts.length > 1 ? ` +${r.parts.length - 1}` : ''}</span
										>
									{:else}<span class="text-muted-foreground">—</span>{/if}
								</td>
								<td class="px-3 py-1">
									<span class="flex gap-2 font-mono text-[11px] font-medium">
										{#if r.tbd}<span class="text-error">TBD</span>{/if}
										{#if r.tbr}<span class="text-warn">TBR</span>{/if}
										{#if r.stale}<span
												class="text-warn"
												title="Parent was revised after this row last got a fresh look">STALE</span
											>{/if}
										{#if r.orphan}<span class="text-warn" title="Parent is no longer current"
												>ORPHAN</span
											>{/if}
									</span>
								</td>
								<td class="px-3 py-1 text-right"><Timestamp value={r.updated_at} relative /></td>
							</tr>
						{/each}
						{#if !filtering}
							<tr>
								<td colspan="9" class="px-3 py-1.5 font-mono text-xs">
									<button
										type="button"
										class="text-info hover:underline"
										onclick={() => flowDown(null)}>+ NEW LEVEL-0 REQUIREMENT</button
									>
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			</div>
		{/if}
	</Section>
</div>

<QuickCreate bind:open={qcOpen} parent={qcParent} oncreated={() => invalidateAll()} />
