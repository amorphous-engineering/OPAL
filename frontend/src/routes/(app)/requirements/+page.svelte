<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import {
		DataTable,
		EmptyLine,
		FilterBar,
		FilterSelect,
		FilterToggle,
		PageHeader,
		SearchInput,
		urlSort,
		Section,
		State,
		Timestamp,
		type Column
	} from '#lib/components/opal/index.js';
	import { opal } from '#lib/api.js';
	import { session } from '#lib/session.svelte.js';
	import { stateLabel } from '#lib/format.js';
	import LintedText from '#lib/components/requirements/LintedText.svelte';
	import QuickCreate, { type QuickParent } from '#lib/components/requirements/QuickCreate.svelte';
	import ImportCatalogDialog from '#lib/components/requirements/ImportCatalogDialog.svelte'; // added by projects
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

	const filtering = $derived(!!(q || stFilter || level || verif || staleOnly || data.projectId));

	function matches(i: TreeItem): boolean {
		if (stFilter && i.lifecycleState !== stFilter) return false;
		if (level !== '' && String(i.level) !== level) return false;
		if (verif && i.verification !== verif) return false;
		if (staleOnly && !i.stale) return false;
		if (q) {
			const hay = `${i.reqNumber} ${i.title} ${i.statement}`.toLowerCase();
			if (!hay.includes(q.toLowerCase().trim())) return false;
		}
		return true;
	}

	// Superseded revisions are not in the tree payload; fetch them on request.
	let superseded = $state<TreeItem[]>([]);
	$effect(() => {
		if (stFilter !== 'superseded') return;
		opal.requirements
			.list({ state: 'superseded', includeSuperseded: 'true', limit: 500, projectId: data.projectId }) // added by projects
			.then((r) => {
				superseded = r.items.map(
					(x) => ({ ...x, parentId: null, orphan: false, lint: [], parts: [], verification: 'unallocated' }) satisfies TreeItem
				);
			})
			.catch(() => (superseded = []));
	});

	const items = $derived(stFilter === 'superseded' ? superseded : data.tree.items);

	// ---- catalog import (admin) ----
	const unimported = $derived(data.catalog);
	let importOpen = $state(false); // added by projects

	// ---- tree ----
	const kids = $derived.by(() => {
		const m: Record<string, TreeItem[]> = {};
		for (const i of items) (m[String(i.parentId)] ??= []).push(i);
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
			? { id: i.id, reqNumber: i.reqNumber, level: i.level, category: i.category, projectId: i.projectId } // added by projects
			: null;
		qcOpen = true;
	}

	// ---- keyboard ----
	function onkeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select, [role="dialog"], [contenteditable]')) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (e.key === 'b' && data.tree.queueCount) {
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
					else if (cur.item.parentId) focusedId = cur.item.parentId;
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
		{ key: 'reqNumber', label: 'Number', mono: true, sortable: true, width: '7rem' },
		{ key: 'projectCode', label: 'Project', mono: true, sortable: true, width: '7rem' }, // added by projects
		{ key: 'revision', label: 'Rev', mono: true, sortable: true, width: '3.5rem', align: 'right' },
		{ key: 'title', label: 'Title', sortable: true },
		{ key: 'lifecycleState', label: 'State', sortable: true, width: '7rem' },
		{ key: 'level', label: 'L', mono: true, sortable: true, width: '3rem', align: 'right' },
		{ key: 'category', label: 'Category', sortable: true, width: '8rem' },
		{ key: 'verification', label: 'Verification', sortable: true, width: '10rem' },
		{ key: 'flags', label: 'Flags', width: '8rem' },
		{ key: 'updatedAt', label: 'Updated', sortable: true, width: '6rem', align: 'right' }
	];
	const sort = urlSort(null);
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
		<Button
			size="sm"
			variant="outline"
			href={data.projectId ? `/requirements/baselines?project=${data.projectId}` : '/requirements/baselines'}
			>BASELINES</Button
		>
		{#if data.tree.queueCount}
			<Button
				size="sm"
				variant="outline"
				href={data.projectId ? `/requirements/queue?project=${data.projectId}` : '/requirements/queue'}
				class="text-ok"
				>BASELINE QUEUE · {data.tree.queueCount}</Button
			>
		{/if}
		{#if session.user?.is_admin && unimported.length}
			<Button size="sm" variant="outline" onclick={() => (importOpen = true)}
				>IMPORT CATALOG · {unimported.length}</Button
			>
		{/if}
		<Button
			size="sm"
			href={data.projectId ? `/requirements/new?projectId=${data.projectId}` : '/requirements/new'}
			>+ NEW</Button
		>
	{/snippet}
</PageHeader>

<div class="grid grid-cols-[minmax(0,1fr)] gap-4 p-4">
	<StatusPanel summary={data.summary} />

	<Section
		title="REQUIREMENTS"
		count={filtering ? `${rows.length || listRows.length} of ${data.tree.total}` : data.tree.total}
	>
		<FilterBar clear={['q', 'project', 'state', 'level', 'verif', 'stale']}>
			<SearchInput label="Filter requirements" placeholder="Filter number, title, statement" />
			<!-- added by projects -->
			<FilterSelect
				param="project"
				label="Project"
				allLabel="All projects"
				options={data.projects.map((p) => ({ value: String(p.id), label: p.code }))}
			/>
			<FilterSelect
				param="state"
				label="State"
				allLabel="All states"
				options={LIFECYCLE_STATES.map((s) => ({ value: s, label: stateLabel(s) }))}
			/>
			<FilterSelect
				param="level"
				label="Level"
				allLabel="All levels"
				options={LEVELS.map((l) => ({ value: String(l.value), label: l.label }))}
			/>
			<FilterSelect
				param="verif"
				label="Verification"
				allLabel="Any verification"
				options={(['verified', 'partial', 'open', 'unallocated'] as const).map((v) => ({
					value: v,
					label: verificationLabel[v]
				}))}
			/>
			<FilterToggle param="stale" label="Stale only" />
			{#snippet end()}
				{#if view === 'tree'}
					<span class="hidden font-mono text-xs whitespace-nowrap text-muted-foreground md:inline"
						>j/k move · ←/→ fold · enter open · c flow down · / filter · b queue</span
					>
				{/if}
			{/snippet}
		</FilterBar>

		{#if view === 'list'}
			<DataTable
				rows={listRows}
				{columns}
				bind:sort={() => sort.value, sort.set}
				href={(r) => `/requirements/${r.id}`}
				key={(r) => r.id}
				emptyLabel={filtering ? 'Matching requirements' : 'Requirements'}
				dense
			>
				{#snippet cell(r, col)}
					{#if col.key === 'reqNumber'}
						<span class="text-info">{r.reqNumber}</span>
					{:else if col.key === 'lifecycleState'}
						<State value={r.lifecycleState} tone={lifecycleTone(r.lifecycleState)} />
					{:else if col.key === 'verification'}
						<span class="font-mono text-xs"
							>{methodInitial(r.verificationMethod)}
							{#if r.lifecycleState !== 'superseded' && r.lifecycleState !== 'cancelled'}
								<State
									value={r.verification}
									label={verificationLabel[r.verification]}
									tone={verificationTone(r.verification)}
								/>{/if}</span
						>
					{:else if col.key === 'flags'}
						<span class="flex gap-2 font-mono text-xs font-medium">
							{#if r.tbd}<span class="text-error">TBD</span>{/if}
							{#if r.tbr}<span class="text-warn">TBR</span>{/if}
							{#if r.stale}<span
									class="text-warn"
									title="Parent was revised after this row last got a fresh look">STALE</span
								>{/if}
						</span>
					{:else if col.key === 'updatedAt'}
						<Timestamp value={r.updatedAt} relative />
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
							{#each [['Number', 'w-44'], ['Project', 'w-20'], ['Title', 'w-64'], ['Statement', ''], ['State', 'w-28'], ['L', 'w-10'], ['Verification', 'w-44'], ['Parts', 'w-44'], ['Flags', 'w-24'], ['Age', 'w-14']] as [label, w] (label)}
								<th
									scope="col"
									class="h-8 px-3 text-left font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase {w}"
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
										>{r.reqNumber}</a
									>
									{#if r.revision > 1}<span class="mono text-xs text-muted-foreground"
											>r{r.revision}</span
										>{/if}
								</td>
								<td class="px-3 py-1 font-mono text-xs">{r.projectCode}</td> <!-- added by projects -->
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
									><State value={r.lifecycleState} tone={lifecycleTone(r.lifecycleState)} /></td
								>
								<td class="mono px-3 py-1 text-xs">{r.level}</td>
								<td class="px-3 py-1 font-mono text-xs whitespace-nowrap">
									<span title={`Verification method: ${r.verificationMethod ?? 'not set'}`}
										>{methodInitial(r.verificationMethod)}</span
									>
									{#if r.lifecycleState !== 'cancelled'}
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
									<span class="flex gap-2 font-mono text-xs font-medium">
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
								<td class="px-3 py-1 text-right"><Timestamp value={r.updatedAt} relative /></td>
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

<QuickCreate
	bind:open={qcOpen}
	parent={qcParent}
	projectId={data.projectId ?? 0}
	oncreated={() => invalidateAll()}
/>
<ImportCatalogDialog bind:open={importOpen} projectId={data.projectId ?? 0} count={unimported.length} />
