<script lang="ts" generics="T">
	// Headed data table: the app's collection grammar. Rows with an href are
	// clickable as a whole (and stay real links for middle-click/new tab).
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { cn } from '#lib/utils.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import EmptyLine from './EmptyLine.svelte';
	import type { Column } from './types.js';

	let {
		rows,
		columns,
		cell,
		href,
		onrowclick,
		emptyLabel,
		emptyAction,
		loading = false,
		sort = $bindable<{ key: string; dir: 'asc' | 'desc' } | null>(null),
		serverSort = false,
		rowClass,
		key: rowKey,
		class: className,
		dense = false,
		selected = $bindable<(string | number)[] | undefined>(undefined)
	}: {
		rows: T[];
		columns: Column<T>[];
		cell?: Snippet<[T, Column<T>]>;
		href?: (row: T) => string | null | undefined;
		onrowclick?: (row: T) => void;
		emptyLabel: string;
		emptyAction?: Snippet;
		loading?: boolean;
		sort?: { key: string; dir: 'asc' | 'desc' } | null;
		/** When true the parent sorts (e.g. via the API); the table only reports clicks. */
		serverSort?: boolean;
		rowClass?: (row: T) => string | undefined;
		key?: (row: T) => string | number;
		class?: string;
		dense?: boolean;
		/** Row selection by `key`; pass an array (even empty) to show the checkbox column. */
		selected?: (string | number)[];
	} = $props();

	function value(row: T, col: Column<T>) {
		return col.sortValue ? col.sortValue(row) : (row as Record<string, unknown>)[col.key];
	}

	const sorted = $derived.by(() => {
		if (!sort || serverSort) return rows;
		const col = columns.find((c) => c.key === sort!.key);
		if (!col) return rows;
		const dir = sort.dir === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const va = value(a, col) as string | number | null | undefined;
			const vb = value(b, col) as string | number | null | undefined;
			if (va == null && vb == null) return 0;
			if (va == null) return 1;
			if (vb == null) return -1;
			if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
			return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
		});
	});

	function toggleSort(col: Column<T>) {
		if (!col.sortable) return;
		sort =
			sort?.key === col.key
				? sort.dir === 'asc'
					? { key: col.key, dir: 'desc' }
					: null
				: { key: col.key, dir: 'asc' };
	}

	function activate(e: MouseEvent | KeyboardEvent, row: T) {
		const target = e.target as HTMLElement;
		if (target.closest('a, button, input, select, textarea, label, [role="checkbox"]')) return;
		if (onrowclick) return onrowclick(row);
		const h = href?.(row);
		if (!h) return;
		if ((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey) window.open(h, '_blank');
		else goto(h);
	}

	const keys = $derived(rows.map((r, i) => (rowKey ? rowKey(r) : i)));
	const allSelected = $derived(
		!!selected && keys.length > 0 && keys.every((k) => selected!.includes(k))
	);
	function toggleAll(on: boolean) {
		if (!selected) return;
		selected = on
			? [...selected, ...keys.filter((k) => !selected!.includes(k))]
			: selected.filter((k) => !keys.includes(k));
	}
	function toggleRow(k: string | number, on: boolean) {
		if (!selected) return;
		selected = on ? [...selected, k] : selected.filter((x) => x !== k);
	}

	const clickable = $derived(!!href || !!onrowclick);
	const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' };
</script>

{#if !loading && rows.length === 0}
	{#if emptyAction}
		<EmptyLine label={emptyLabel} action={emptyAction} />
	{:else}
		<EmptyLine label={emptyLabel} />
	{/if}
{:else}
	<div class={cn('w-full overflow-x-auto', className)}>
		<table class="w-full border-collapse text-sm">
			<thead>
				<tr class="border-b border-border bg-muted/60">
					{#if selected}
						<th scope="col" class="h-8 w-9 px-3">
							<Checkbox
								checked={allSelected}
								onCheckedChange={(v) => toggleAll(!!v)}
								aria-label="Select all rows"
							/>
						</th>
					{/if}
					{#each columns as col (col.key)}
						<th
							scope="col"
							style:width={col.width}
							aria-sort={sort?.key === col.key
								? sort.dir === 'asc'
									? 'ascending'
									: 'descending'
								: undefined}
							class={cn(
								'h-8 px-3 font-mono text-[11px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase',
								alignClass[col.align ?? 'left']
							)}
						>
							{#if col.sortable}
								<button
									type="button"
									class="inline-flex items-center gap-1 uppercase hover:text-foreground"
									onclick={() => toggleSort(col)}
								>
									{col.label}<span class="w-2 text-[10px]"
										>{sort?.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span
									>
								</button>
							{:else}
								{col.label}
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#if loading && rows.length === 0}
					{#each [0, 1, 2] as i (i)}
						<tr class="border-b border-border">
							<td colspan={columns.length + (selected ? 1 : 0)} class="h-8 px-3"
								><div class="h-3 w-1/3 animate-pulse bg-muted"></div></td
							>
						</tr>
					{/each}
				{/if}
				{#each sorted as row, i (rowKey ? rowKey(row) : i)}
					{@const h = href?.(row)}
					{@const rk = rowKey ? rowKey(row) : i}
					<tr
						class={cn(
							'border-b border-border align-top',
							clickable && 'cursor-pointer hover:bg-accent/60',
							rowClass?.(row)
						)}
						onclick={(e) => clickable && activate(e, row)}
						onkeydown={(e) => e.key === 'Enter' && clickable && activate(e, row)}
						tabindex={clickable ? 0 : undefined}
						data-href={h}
					>
						{#if selected}
							<td class="w-9 px-3 py-1.5 align-middle">
								<Checkbox
									checked={selected.includes(rk)}
									onCheckedChange={(v) => toggleRow(rk, !!v)}
									aria-label="Select row"
								/>
							</td>
						{/if}
						{#each columns as col, ci (col.key)}
							<td
								class={cn(
									dense ? 'px-3 py-1' : 'px-3 py-1.5',
									alignClass[col.align ?? 'left'],
									col.mono && 'font-mono tabular-nums',
									col.class
								)}
							>
								{#if ci === 0 && h}
									<a href={h} class="sr-only">Open</a>
								{/if}
								{#if cell}
									{@render cell(row, col)}
								{:else}
									{@const v = (row as Record<string, unknown>)[col.key]}
									{#if v === null || v === undefined || v === ''}<span class="text-muted-foreground"
											>—</span
										>{:else}{v}{/if}
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
