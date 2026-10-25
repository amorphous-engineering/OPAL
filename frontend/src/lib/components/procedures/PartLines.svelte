<script lang="ts">
	// Kit (parts consumed) and outputs (parts produced) are the same grammar:
	// a headed table of part lines with an in-place quantity, add and remove.
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
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

	type Line = (KitLine | OutputLine) & { onHand?: string };

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

	const rows = $derived<Line[]>(lines);

	const columns = $derived<Column<Line>[]>([
		{ key: 'partNumber', label: 'PN', width: '9rem', mono: true },
		{ key: 'partName', label: 'Name' },
		{ key: 'partExternalPn', label: 'Ext PN', width: '9rem', mono: true },
		{ key: 'quantity', label: qtyHead, align: 'right', width: '8rem' },
		...(isKit ? [{ key: 'onHand', label: 'On hand', align: 'right' as const, width: '7rem' }] : []),
		{ key: 'actions', label: '', width: '4rem', align: 'right' }
	]);

	// Short = stock below what the kit needs. Consequence renders where it lands.
	const short = $derived(
		isKit ? rows.filter((r) => Number((r as KitLine).onHand ?? 0) < Number(r.quantity)).length : 0
	);

	async function save(row: Line, next: string) {
		try {
			if (isKit)
				await opal.procedures.kit.update({ id: procedureId, kitId: row.id, quantity: next });
			else
				await opal.procedures.outputs.update({ id: procedureId, outputId: row.id, quantity: next });
			await onchange();
		} catch (e) {
			toastError(e);
		}
	}

	async function add(partId: number, quantity: string) {
		if (isKit)
			await opal.procedures.kit.add({ id: procedureId, partId, quantity, usage: 'consume' });
		else await opal.procedures.outputs.add({ id: procedureId, partId, quantity });
		await onchange();
	}

	async function remove(row: Line) {
		const ok = await confirm({
			title: `Remove ${row.partNumber} from ${isKit ? 'kit' : 'outputs'}?`,
			body: 'Published versions keep their own copy.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			if (isKit) await opal.procedures.kit.remove({ id: procedureId, kitId: row.id });
			else await opal.procedures.outputs.remove({ id: procedureId, outputId: row.id });
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
			<Button
				variant="link"
				class="h-auto border-0 p-0 font-mono text-xs tracking-wider text-info uppercase"
				onclick={() => (adding = true)}>+ ADD</Button
			>
		{/snippet}
		<DataTable {rows} {columns} emptyLabel={title} dense key={(r) => r.id}>
			{#snippet cell(row, col)}
				{#if col.key === 'partNumber'}
					<a href={`/parts/${row.partId}`} class="text-info hover:underline">{row.partNumber}</a>
				{:else if col.key === 'partName'}
					{row.partName}
					{#if row.partState === 'draft'}<State value="draft" class="ml-2" />{/if}
				{:else if col.key === 'partExternalPn'}
					{#if row.partExternalPn}{row.partExternalPn}{:else}<span class="text-muted-foreground"
							>—</span
						>{/if}
				{:else if col.key === 'quantity'}
					<QtyCell
						value={row.quantity}
						label={`${row.partName} quantity`}
						onsave={(n) => save(row, n)}
					/>
				{:else if col.key === 'onHand'}
					{@const have = (row as KitLine).onHand ?? '0'}
					<span class={Number(have) < Number(row.quantity) ? 'font-mono text-warn' : 'font-mono'}
						>{qty(have)}</span
					>
				{:else if col.key === 'actions'}
					<button
						type="button"
						class="font-mono text-xs text-muted-foreground hover:text-error"
						aria-label={`Remove ${row.partName}`}
						onclick={() => remove(row)}>REMOVE</button
					>
				{/if}
			{/snippet}
		</DataTable>
		{#if isKit}
			<div
				class="flex gap-4 border-t border-border bg-muted/40 px-3 py-1 font-mono text-xs uppercase"
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
	exclude={lines.map((l) => l.partId)}
	onsubmit={add}
/>
