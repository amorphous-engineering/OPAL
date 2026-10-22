<script lang="ts">
	// Kit (parts consumed) and outputs (parts produced) are the same grammar:
	// a headed table of part lines with an in-place quantity, add and remove.
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import {
		DataTable,
		EmptyLine,
		Section,
		State,
		confirm,
		toastError
	} from '#lib/components/opal/index.js';
	import type { Column } from '#lib/components/opal/index.js';
	import { qty } from '#lib/format.js';
	import PartQtyDialog from './PartQtyDialog.svelte';
	import QtyCell from './QtyCell.svelte';
	import type { KitLine, OutputLine } from './types.js';

	type Line = (KitLine | OutputLine) & { qty: number };

	let {
		kind,
		procedureId,
		lines,
		onchange
	}: {
		kind: 'kit' | 'outputs';
		procedureId: number;
		lines: (KitLine | OutputLine)[];
		onchange: () => void | Promise<void>;
	} = $props();

	const isKit = $derived(kind === 'kit');
	const title = $derived(isKit ? 'Kit' : 'Outputs');
	const qtyHead = $derived(isKit ? 'Required' : 'Produced');
	let adding = $state(false);

	const rows = $derived<Line[]>(
		lines.map((l) => ({
			...l,
			qty: isKit ? (l as KitLine).quantity_required : (l as OutputLine).quantity_produced
		}))
	);

	const columns = $derived<Column<Line>[]>([
		{ key: 'part_internal_pn', label: 'Part', width: '9rem', mono: true },
		{ key: 'part_name', label: 'Name' },
		{ key: 'part_external_pn', label: 'Ext PN', width: '9rem', mono: true },
		{ key: 'qty', label: qtyHead, align: 'right', width: '8rem' },
		...(isKit
			? [{ key: 'on_hand', label: 'On hand', align: 'right' as const, width: '7rem' }]
			: []),
		{ key: 'actions', label: '', width: '4rem', align: 'right' }
	]);

	// Short = stock below what the kit needs. Consequence renders where it lands.
	const short = $derived(
		isKit ? rows.filter((r) => ((r as KitLine).part_on_hand ?? 0) < r.qty).length : 0
	);

	async function save(row: Line, next: number) {
		try {
			if (isKit)
				await api.patch(`/procedures/${procedureId}/kit/${row.id}`, { quantity_required: next });
			else
				await api.patch(`/procedures/${procedureId}/outputs/${row.part_id}`, {
					quantity_produced: next
				});
			await onchange();
		} catch (e) {
			toastError(e);
		}
	}

	async function add(partId: number, quantity: number) {
		if (isKit)
			await api.post(`/procedures/${procedureId}/kit`, {
				part_id: partId,
				quantity_required: quantity
			});
		else
			await api.post(`/procedures/${procedureId}/outputs`, {
				part_id: partId,
				quantity_produced: quantity
			});
		await onchange();
	}

	async function remove(row: Line) {
		const ok = await confirm({
			title: `Remove ${row.part_internal_pn ?? row.part_name} from ${isKit ? 'kit' : 'outputs'}?`,
			body: 'Published versions keep their own copy.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/procedures/${procedureId}/${isKit ? 'kit' : 'outputs'}/${row.part_id}`);
			await onchange();
		} catch (e) {
			toastError(e);
		}
	}
</script>

{#if rows.length === 0}
	<EmptyLine label={title} onadd={() => (adding = true)} />
{:else}
	<Section {title} count={rows.length}>
		{#snippet actions()}
			<Button variant="ghost" size="xs" onclick={() => (adding = true)}>+ ADD</Button>
		{/snippet}
		<DataTable {rows} {columns} emptyLabel={title} dense key={(r) => r.id}>
			{#snippet cell(row, col)}
				{#if col.key === 'part_internal_pn'}
					<a href={`/parts/${row.part_id}`} class="text-info hover:underline"
						>{row.part_internal_pn ?? '—'}</a
					>
				{:else if col.key === 'part_name'}
					{row.part_name}
					{#if row.part_lifecycle_state === 'draft'}<State value="draft" class="ml-2" />{/if}
				{:else if col.key === 'part_external_pn'}
					{#if row.part_external_pn}{row.part_external_pn}{:else}<span class="text-muted-foreground"
							>—</span
						>{/if}
				{:else if col.key === 'qty'}
					<QtyCell
						value={row.qty}
						label={`${row.part_name} quantity`}
						onsave={(n) => save(row, n)}
					/>
				{:else if col.key === 'on_hand'}
					{@const have = (row as KitLine).part_on_hand ?? 0}
					<span class={have < row.qty ? 'font-mono text-warn' : 'font-mono'}>{qty(have)}</span>
				{:else if col.key === 'actions'}
					<button
						type="button"
						class="font-mono text-[11px] text-muted-foreground hover:text-error"
						aria-label={`Remove ${row.part_name}`}
						onclick={() => remove(row)}>REMOVE</button
					>
				{/if}
			{/snippet}
		</DataTable>
		{#if isKit}
			<div
				class="flex gap-4 border-t border-border bg-muted/40 px-3 py-1 font-mono text-[11px] uppercase"
			>
				<span class="text-muted-foreground"
					>{rows.length} {rows.length === 1 ? 'line' : 'lines'}</span
				>
				{#if short > 0}<span class="text-warn">{short} short on hand</span>{:else}<span
						class="text-muted-foreground">all on hand</span
					>{/if}
			</div>
		{/if}
	</Section>
{/if}

<PartQtyDialog
	bind:open={adding}
	title={isKit ? 'Add part to kit' : 'Add output'}
	qtyLabel={isKit ? 'Quantity required' : 'Quantity produced'}
	exclude={lines.map((l) => l.part_id)}
	onsubmit={add}
/>
