<script lang="ts">
	// Server-side pagination footer; pages are links so back and share work.
	import { Button } from '#lib/components/ui/button/index.js';

	let {
		total,
		page,
		pageSize,
		href
	}: { total: number; page: number; pageSize: number; href: (page: number) => string } = $props();

	const first = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
	const last = $derived(Math.min(total, page * pageSize));
	const pages = $derived(Math.max(1, Math.ceil(total / pageSize)));
</script>

<div
	class="flex h-9 items-center gap-3 border-t border-border px-3 font-mono text-xs text-muted-foreground"
>
	<span class="tabular-nums">{first}–{last} of {total}</span>
	<div class="ml-auto flex items-center gap-1">
		<Button
			size="xs"
			variant="outline"
			href={page > 1 ? href(page - 1) : undefined}
			disabled={page <= 1}>← PREV</Button
		>
		<span class="px-2 tabular-nums">PAGE {page}/{pages}</span>
		<Button
			size="xs"
			variant="outline"
			href={page < pages ? href(page + 1) : undefined}
			disabled={page >= pages}>NEXT →</Button
		>
	</div>
</div>
