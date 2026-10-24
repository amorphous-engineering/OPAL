<script lang="ts">
	// BOM: the design-level children of this assembly, with quantities. The
	// section renders when it has rows or when the procurement declaration
	// expects them (empty-state rule); the structure view appears only when it
	// carries depth the direct lines do not.
	import {
		DataTable,
		EmptyLine,
		Section,
		State,
		confirm,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { opal } from '#lib/api.js';
	import {
		formatQty,
		parseQty,
		QTY_SCALE,
		type BomLine,
		type BomTreeNode,
		type PartDetail
	} from '@opal/shared';
	import { qty } from '#lib/format.js';
	import { ActionLink } from '#lib/components/opal/index.js';
	import FormField from './FormField.svelte';
	import PartPicker from './PartPicker.svelte';
	import { act } from './actions.js';
	import type { PartRef } from './types.js';

	let { detail, view = 'lines' }: { detail: PartDetail; view?: 'lines' | 'tree' } = $props();
	const part = $derived(detail.part);
	const lines = $derived(detail.bom);

	let adding = $state(false);
	let picked = $state<PartRef | null>(null);
	let addQty = $state('1');
	let addRef = $state('');
	let addNotes = $state('');
	let busy = $state(false);

	let editId = $state<number | null>(null);
	let eQty = $state('1');
	let eRef = $state('');
	let eNotes = $state('');

	const columns: Column<BomLine>[] = [
		{ key: 'pn', label: 'PN', width: '9rem', mono: true },
		{ key: 'name', label: 'Name' },
		{ key: 'qty', label: 'Qty', width: '5rem', align: 'right', mono: true },
		{ key: 'ref', label: 'Refdes', width: '8rem', mono: true },
		{ key: 'notes', label: 'Notes', width: '14rem' },
		{ key: 'actions', label: '', width: '7rem', align: 'right' }
	];

	function startEdit(l: BomLine) {
		editId = l.id;
		eQty = l.quantity;
		eRef = l.referenceDesignator ?? '';
		eNotes = l.notes ?? '';
	}

	async function saveEdit(l: BomLine) {
		busy = true;
		const ok = await act(
			() =>
				opal.parts.bom.update({
					lineId: l.id,
					quantity: eQty.trim(),
					referenceDesignator: eRef.trim() || null,
					notes: eNotes.trim() || null
				}),
			'BOM line saved'
		);
		busy = false;
		if (ok) editId = null;
	}

	async function remove(l: BomLine) {
		const ok = await confirm({
			title: `Remove ${l.componentPn} from the BOM`,
			body: `The line leaves the ${part.internalPn} BOM. The part itself is unchanged.`,
			action: 'REMOVE',
			destructive: true
		});
		if (ok) await act(() => opal.parts.bom.remove({ lineId: l.id }), 'Removed from BOM');
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		if (!picked) return;
		busy = true;
		const ok = await act(
			() =>
				opal.parts.bom.add({
					id: part.id,
					componentId: picked!.id,
					quantity: addQty.trim() || '1',
					referenceDesignator: addRef.trim() || null,
					notes: addNotes.trim() || null
				}),
			`${picked.internal_pn} added`
		);
		busy = false;
		if (ok) {
			picked = null;
			addQty = '1';
			addRef = '';
			addNotes = '';
			adding = false;
		}
	}

	// Structure: only when some component has a BOM of its own.
	let tree = $state<BomTreeNode | null>(null);
	$effect(() => {
		const id = part.id;
		void detail.bom;
		if (view !== 'tree' || lines.length === 0) {
			tree = null;
			return;
		}
		opal.parts.bom
			.tree({ id })
			.then((t) => (tree = t))
			.catch(() => (tree = null));
	});

	interface Flat {
		node: BomTreeNode;
		depth: number;
		ext: string;
	}
	const flat = $derived.by(() => {
		const out: Flat[] = [];
		const walk = (n: BomTreeNode, depth: number, mult: number) => {
			for (const c of n.children) {
				const ext = Math.round((mult * parseQty(c.quantity)) / QTY_SCALE);
				out.push({ node: c, depth, ext: formatQty(ext as ReturnType<typeof parseQty>) });
				if (!c.circular) walk(c, depth + 1, ext);
			}
		};
		if (tree) walk(tree, 0, QTY_SCALE);
		return out;
	});
	const hasDepth = $derived(flat.some((f) => f.depth > 0));
</script>

{#snippet addAction()}
	<ActionLink onclick={() => (adding = !adding)}>{adding ? 'CANCEL' : '+ ADD'}</ActionLink>
{/snippet}

{#snippet addForm()}
	<form
		class="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-2"
		onsubmit={add}
	>
		<FormField label="Component" for="bom-component" class="w-80">
			<PartPicker
				id="bom-component"
				bind:value={picked}
				exclude={[part.id, ...lines.map((l) => l.componentId)]}
				placeholder="Search parts"
			/>
		</FormField>
		<FormField label="Qty" for="bom-qty" class="w-20">
			<Input id="bom-qty" class="font-mono" inputmode="decimal" bind:value={addQty} required />
		</FormField>
		<FormField label="Refdes" for="bom-ref" class="w-32">
			<Input id="bom-ref" class="font-mono" bind:value={addRef} />
		</FormField>
		<FormField label="Notes" for="bom-notes" class="w-56">
			<Input id="bom-notes" bind:value={addNotes} />
		</FormField>
		<Button type="submit" size="sm" disabled={busy || !picked}>ADD</Button>
		<a
			href={`/parts/new?assembly=${part.id}`}
			class="pb-2 font-mono text-xs font-medium text-info hover:underline">+ NEW PART</a
		>
	</form>
{/snippet}

{#if view === 'lines'}
	{#if lines.length}
		<Section title="BOM" count={lines.length}>
			{#snippet actions()}{@render addAction()}{/snippet}
			<DataTable
				rows={lines}
				{columns}
				key={(l) => l.id}
				href={(l) => (editId === l.id ? null : `/parts/${l.componentId}`)}
				emptyLabel="BOM"
			>
				{#snippet cell(l, col)}
					{#if col.key === 'pn'}
						<a href={`/parts/${l.componentId}`} class="text-info hover:underline">{l.componentPn}</a
						>
					{:else if col.key === 'name'}
						{l.componentName}
						{#if l.componentState === 'draft'}<State
								value="draft"
								tone="warn"
								badge
								class="ml-2"
							/>{:else if l.componentState === 'obsolete'}<State
								value="obsolete"
								tone="error"
								badge
								class="ml-2"
							/>{/if}
					{:else if editId === l.id}
						{#if col.key === 'qty'}
							<Input
								inputmode="decimal"
								class="h-7 w-20 text-right font-mono"
								aria-label="Quantity"
								bind:value={eQty}
							/>
						{:else if col.key === 'ref'}
							<Input class="h-7 font-mono" aria-label="Reference designator" bind:value={eRef} />
						{:else if col.key === 'notes'}
							<Input class="h-7" aria-label="Notes" bind:value={eNotes} />
						{:else}
							<span class="inline-flex gap-3">
								<ActionLink onclick={() => saveEdit(l)} disabled={busy}>SAVE</ActionLink>
								<ActionLink onclick={() => (editId = null)}>CANCEL</ActionLink>
							</span>
						{/if}
					{:else if col.key === 'qty'}
						{qty(l.quantity)}
					{:else if col.key === 'ref'}
						{#if l.referenceDesignator}{l.referenceDesignator}{:else}<span
								class="text-muted-foreground">—</span
							>{/if}
					{:else if col.key === 'notes'}
						{#if l.notes}{l.notes}{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else}
						<span class="inline-flex gap-3">
							<ActionLink onclick={() => startEdit(l)}>EDIT</ActionLink>
							<ActionLink danger onclick={() => remove(l)}>REMOVE</ActionLink>
						</span>
					{/if}
				{/snippet}
			</DataTable>
			{#if adding}{@render addForm()}{/if}
		</Section>
	{:else if detail.expects.bom}
		<div>
			<EmptyLine label="BOM" onadd={() => (adding = true)} />
			{#if adding}{@render addForm()}{/if}
		</div>
	{/if}
{:else if hasDepth}
	<Section title="Structure" count={flat.length}>
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						<th class="label h-8 px-3 text-left font-medium">PN</th>
						<th class="label h-8 px-3 text-left font-medium">Name</th>
						<th class="label h-8 px-3 text-right font-medium">Qty</th>
						<th
							class="label h-8 px-3 text-right font-medium"
							title="Quantity per one of this assembly">Total</th
						>
					</tr>
				</thead>
				<tbody>
					{#each flat as f, i (i)}
						<tr class="border-b border-border">
							<td
								class="mono px-3 py-1 whitespace-nowrap"
								style:padding-left={`${0.75 + f.depth * 1.25}rem`}
							>
								<span class="text-muted-foreground">{f.depth ? '└ ' : ''}</span><a
									href={`/parts/${f.node.partId}`}
									class="text-info hover:underline">{f.node.internalPn}</a
								>
							</td>
							<td class="px-3 py-1"
								>{f.node.name}{#if f.node.circular}<span class="label ml-2 text-error"
										>Circular</span
									>{/if}</td
							>
							<td class="mono px-3 py-1 text-right">{qty(f.node.quantity)}</td>
							<td class="mono px-3 py-1 text-right">{qty(f.ext)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</Section>
{/if}
