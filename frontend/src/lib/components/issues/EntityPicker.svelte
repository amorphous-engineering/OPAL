<script lang="ts" module>
	export interface Picked {
		id: number;
		label: string;
		sublabel: string | null;
	}
</script>

<script lang="ts">
	// Search-as-you-type picker for one kind of record, backed by /api/search.
	// Shows names and numbers only (voice rule 7).
	import { api } from '#lib/api.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toastError } from '#lib/components/opal/index.js';

	let {
		kind,
		onpick,
		placeholder = 'Search…',
		id,
		label
	}: {
		kind: 'part' | 'procedure' | 'execution' | 'risk';
		onpick: (r: Picked) => void;
		placeholder?: string;
		id?: string;
		label: string;
	} = $props();

	interface SearchResult {
		entity_type: string;
		id: number;
		label: string;
		sublabel: string | null;
	}

	let q = $state('');
	let results = $state<Picked[]>([]);
	let open = $state(false);
	let active = $state(0);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;

	function input() {
		clearTimeout(timer);
		if (!q.trim()) {
			results = [];
			open = false;
			return;
		}
		timer = setTimeout(run, 180);
	}

	async function run() {
		const mine = ++seq;
		try {
			const all = await api.get<SearchResult[]>('/search', { q: q.trim(), limit: 10 });
			if (mine !== seq) return;
			results = all
				.filter((r) => r.entity_type === kind)
				// Procedures carry a database id as sublabel; never show it.
				.map((r) => ({
					id: r.id,
					label: r.label,
					sublabel: kind === 'procedure' ? null : r.sublabel
				}));
			active = 0;
			open = true;
		} catch (e) {
			toastError(e);
		}
	}

	function pick(r: Picked) {
		onpick(r);
		q = '';
		results = [];
		open = false;
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' && open) {
			e.preventDefault();
			active = Math.min(active + 1, results.length - 1);
		} else if (e.key === 'ArrowUp' && open) {
			e.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (e.key === 'Enter' && open && results[active]) {
			e.preventDefault();
			pick(results[active]);
		} else if (e.key === 'Escape') {
			open = false;
		}
	}
</script>

<div class="relative">
	<Input
		{id}
		bind:value={q}
		{placeholder}
		aria-label={label}
		autocomplete="off"
		oninput={input}
		onkeydown={key}
		onblur={() => setTimeout(() => (open = false), 120)}
		onfocus={() => results.length && (open = true)}
	/>
	{#if open}
		<ul
			role="listbox"
			class="absolute top-full left-0 z-40 mt-px max-h-60 w-full min-w-64 overflow-y-auto rounded-md border border-border bg-popover text-xs shadow-none"
		>
			{#each results as r, i (r.id)}
				<li
					role="option"
					aria-selected={i === active}
					class="flex cursor-pointer items-baseline gap-2 px-2 py-1.5 {i === active
						? 'bg-accent'
						: ''}"
					onmousedown={(e) => {
						e.preventDefault();
						pick(r);
					}}
				>
					{#if r.sublabel}<span class="mono text-info">{r.sublabel}</span>{/if}
					<span class="truncate">{r.label}</span>
				</li>
			{:else}
				<li class="px-2 py-1.5 font-mono text-muted-foreground">NO MATCH</li>
			{/each}
		</ul>
	{/if}
</div>
