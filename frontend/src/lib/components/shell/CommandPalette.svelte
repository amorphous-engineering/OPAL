<script lang="ts">
	// ⌘K / Ctrl+K: jump to any page or entity (static commands + /api/search).
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

	let { open = $bindable(false) }: { open?: boolean } = $props();
	let query = $state('');
	let results = $state<SearchResult[]>([]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	const pages = [{ href: '/', label: 'Overview' }, ...NAV.flatMap((g) => g.items)];

	$effect(() => {
		const q = query.trim();
		clearTimeout(timer);
		if (q.length < 2) {
			results = [];
			return;
		}
		const mine = ++seq;
		timer = setTimeout(async () => {
			try {
				const r = await api.get<SearchResult[]>('/search', { q });
				if (mine === seq) results = r;
			} catch {
				if (mine === seq) results = [];
			}
		}, 150);
	});

	function go(href: string) {
		open = false;
		query = '';
		goto(href);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			open = !open;
		}
	}

	const grouped = $derived(
		Object.entries(
			results.reduce<Record<string, SearchResult[]>>((acc, r) => {
				(acc[r.entity_type] ??= []).push(r);
				return acc;
			}, {})
		)
	);
</script>

<svelte:window {onkeydown} />

<Command.Dialog bind:open shouldFilter={false} title="Go to" description="Search pages and records">
	<Command.Input placeholder="Search parts, issues, executions…" bind:value={query} />
	<Command.List>
		<Command.Empty>No match</Command.Empty>
		{#each grouped as [type, rows] (type)}
			<Command.Group heading={type.replace(/_/g, ' ').toUpperCase()}>
				{#each rows as r (r.entity_type + r.id)}
					<Command.Item value={`${r.entity_type}-${r.id}`} onSelect={() => go(r.url)}>
						<span class="truncate">{r.label}</span>
						{#if r.sublabel}<span class="ml-2 truncate text-muted-foreground">{r.sublabel}</span
							>{/if}
						{#if r.status}<span
								class="ml-auto font-mono text-[11px] text-muted-foreground uppercase"
								>{r.status.replace(/_/g, ' ')}</span
							>{/if}
					</Command.Item>
				{/each}
			</Command.Group>
		{/each}
		<Command.Group heading="PAGES">
			{#each pages.filter((p) => !query || p.label
						.toLowerCase()
						.includes(query.toLowerCase())) as p (p.href)}
				<Command.Item value={`page-${p.href}`} onSelect={() => go(p.href)}>{p.label}</Command.Item>
			{/each}
		</Command.Group>
	</Command.List>
</Command.Dialog>
