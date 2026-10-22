<script lang="ts">
	// ⌘K / Ctrl+K: jump to any record (/api/search covers every entity type), any page,
	// or a "new" form. Arrow keys move, Enter opens, Escape closes. Empty query shows
	// the last records opened from here.
	import * as Command from '#lib/components/ui/command/index.js';
	import { goto } from '$app/navigation';
	import { api } from '#lib/api.js';
	import { NAV } from '#lib/nav.js';

	interface SearchResult {
		entity_type: string;
		id: number;
		label: string;
		sublabel: string | null;
		url: string;
		status: string | null;
	}

	/** Result groups, in display order. Keys are the API's entity_type values. */
	const TYPES: Record<string, string> = {
		part: 'PARTS',
		purchase: 'PURCHASES',
		supplier: 'SUPPLIERS',
		procedure: 'TEMPLATES',
		execution: 'EXECUTIONS',
		workcenter: 'WORKCENTERS',
		issue: 'ISSUES',
		risk: 'RISKS',
		requirement: 'REQUIREMENTS',
		dataset: 'DATASETS'
	};

	const CREATE = [
		{ href: '/parts/new', label: 'New part' },
		{ href: '/inventory/new', label: 'Receive stock' },
		{ href: '/purchases/new', label: 'New purchase' },
		{ href: '/suppliers/new', label: 'New supplier' },
		{ href: '/procedures/new', label: 'New template' },
		{ href: '/executions/new', label: 'Cut work order' },
		{ href: '/workcenters/new', label: 'New workcenter' },
		{ href: '/issues/new', label: 'New issue' },
		{ href: '/risks/new', label: 'New risk' },
		{ href: '/requirements/new', label: 'New requirement' },
		{ href: '/datasets/new', label: 'New dataset' }
	];

	const RECENT_KEY = 'opal_palette_recent';
	const RECENT_MAX = 6;

	let { open = $bindable(false) }: { open?: boolean } = $props();
	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let searching = $state(false);
	let recent = $state<SearchResult[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const pages = [
		{ href: '/', label: 'Overview' },
		...NAV.flatMap((g) => g.items),
		{ href: '/notifications', label: 'Notifications' }
	];

	function loadRecent() {
		try {
			recent = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		} catch {
			recent = [];
		}
	}

	function remember(r: SearchResult) {
		recent = [r, ...recent.filter((x) => x.url !== r.url)].slice(0, RECENT_MAX);
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
		} catch {
			/* per-viewer convenience only */
		}
	}

	$effect(() => {
		if (open) loadRecent();
	});

	$effect(() => {
		const q = query.trim();
		clearTimeout(timer);
		if (q.length < 2) {
			results = [];
			searching = false;
			return;
		}
		const mine = ++seq;
		searching = true;
		timer = setTimeout(async () => {
			try {
				const r = await api.get<SearchResult[]>('/search', { q });
				if (mine === seq) results = r;
			} catch {
				if (mine === seq) results = [];
			} finally {
				if (mine === seq) searching = false;
			}
		}, 150);
	});

	function go(href: string, hit?: SearchResult) {
		if (hit) remember(hit);
		open = false;
		query = '';
		goto(href);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			open = !open;
		}
	}

	const needle = $derived(query.trim().toLowerCase());
	const grouped = $derived(
		Object.entries(TYPES)
			.map(([type, heading]) => ({
				type,
				heading,
				rows: results.filter((r) => r.entity_type === type)
			}))
			.filter((g) => g.rows.length)
	);
	const pageMatches = $derived(
		pages.filter((p) => !needle || p.label.toLowerCase().includes(needle))
	);
	// "New …" commands only appear once the user types something that names them.
	const createMatches = $derived(
		needle ? CREATE.filter((c) => c.label.toLowerCase().includes(needle)) : []
	);
	const nothing = $derived(
		!!needle && !searching && grouped.length === 0 && !pageMatches.length && !createMatches.length
	);
	const label = (t: string) => (TYPES[t] ?? t.toUpperCase()).replace(/S$/, '').toLowerCase();
</script>

<svelte:window {onkeydown} />

<Command.Dialog
	bind:open
	shouldFilter={false}
	title="Search"
	description="Search records and pages"
>
	<Command.Input placeholder="Search parts, issues, work orders, pages…" bind:value={query} />
	<Command.List>
		{#if nothing}<Command.Empty>No match</Command.Empty>{/if}
		{#if searching && grouped.length === 0}
			<div class="px-3 py-2 font-mono text-xs text-muted-foreground" role="status">SEARCHING</div>
		{/if}
		{#each grouped as g (g.type)}
			<Command.Group heading={g.heading}>
				{#each g.rows as r (r.entity_type + r.id)}
					<Command.Item value={`${r.entity_type}-${r.id}`} onSelect={() => go(r.url, r)}>
						<span class="truncate">{r.label}</span>
						{#if r.sublabel}<span class="ml-2 truncate font-mono text-xs text-muted-foreground"
								>{r.sublabel}</span
							>{/if}
						{#if r.status}<span
								class="ml-auto font-mono text-[11px] text-muted-foreground uppercase"
								>{r.status.replace(/_/g, ' ')}</span
							>{/if}
					</Command.Item>
				{/each}
			</Command.Group>
		{/each}
		{#if !needle && recent.length}
			<Command.Group heading="RECENT">
				{#each recent as r (r.url)}
					<Command.Item value={`recent-${r.url}`} onSelect={() => go(r.url, r)}>
						<span class="truncate">{r.label}</span>
						{#if r.sublabel}<span class="ml-2 truncate font-mono text-xs text-muted-foreground"
								>{r.sublabel}</span
							>{/if}
						<span class="ml-auto font-mono text-[11px] text-muted-foreground uppercase"
							>{label(r.entity_type)}</span
						>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
		{#if createMatches.length}
			<Command.Group heading="CREATE">
				{#each createMatches as c (c.href)}
					<Command.Item value={`create-${c.href}`} onSelect={() => go(c.href)}
						>{c.label}</Command.Item
					>
				{/each}
			</Command.Group>
		{/if}
		{#if pageMatches.length}
			<Command.Group heading="PAGES">
				{#each pageMatches as p (p.href)}
					<Command.Item value={`page-${p.href}`} onSelect={() => go(p.href)}>{p.label}</Command.Item
					>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
