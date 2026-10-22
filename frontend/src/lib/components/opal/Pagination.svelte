<script lang="ts">
	// List footer: range, and PREV / PAGE n/m / NEXT. The page lives in the URL (`page`).
	import { Button } from '#lib/components/ui/button/index.js';
	import { page as pageState } from '$app/state';
	import { pageNumber, setQuery } from './listquery.js';

	let {
		total,
		pageSize,
		prevLabel = '← PREV',
		nextLabel = 'NEXT →'
	}: { total: number; pageSize: number; prevLabel?: string; nextLabel?: string } = $props();

	const current = $derived.by(() => {
		void pageState.url.search;
		return pageNumber();
	});
	const pageCount = $derived(Math.max(1, Math.ceil(total / pageSize)));
	const from = $derived(total === 0 ? 0 : (current - 1) * pageSize + 1);
	const to = $derived(Math.min(total, current * pageSize));
</script>

{#if total > 0}
	<nav
		aria-label="Pages"
		class="flex items-center gap-3 border-t border-border px-3 py-1.5 font-mono text-xs text-muted-foreground"
	>
		<span class="tabular-nums">{from}–{to} of {total}</span>
		<div class="ml-auto flex items-center gap-2">
			<Button
				variant="outline"
				size="xs"
				disabled={current <= 1}
				onclick={() => setQuery({ page: current - 1 })}>{prevLabel}</Button
			>
			<span class="tabular-nums">PAGE {current}/{pageCount}</span>
			<Button
				variant="outline"
				size="xs"
				disabled={current >= pageCount}
				onclick={() => setQuery({ page: current + 1 })}>{nextLabel}</Button
			>
		</div>
	</nav>
{/if}
