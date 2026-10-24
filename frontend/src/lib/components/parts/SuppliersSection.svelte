<script lang="ts">
	// Suppliers (catalog entries: who sells it and under what vendor PN).
	// Expected on buy|both; renders whenever rows exist.
	import {
		DataTable,
		EmptyLine,
		Section,
		confirm,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { opal } from '#lib/api.js';
	import { ActionLink } from '#lib/components/opal/index.js';
	import FormField from './FormField.svelte';
	import { act } from './actions.js';
	import type { PartDetail } from '@opal/shared';
	import type { SupplierPartRow } from '#lib/components/purchasing/types.js';

	let { detail, entries }: { detail: PartDetail; entries: SupplierPartRow[] } = $props();
	const part = $derived(detail.part);

	let adding = $state(false);
	let supplierId = $state('');
	let vendorPn = $state('');
	let preferred = $state(false);
	let notes = $state('');
	let busy = $state(false);
	let options = $state<{ id: number; name: string }[]>([]);

	$effect(() => {
		if (!adding || options.length) return;
		opal.purchasing.suppliers
			.list({ active: true, limit: 500 })
			.then((r) => (options = r.items))
			.catch(() => {});
	});

	// Context pre-fill: the part's own external PN is the usual vendor PN.
	$effect(() => {
		if (adding && vendorPn === '') vendorPn = part.externalPn ?? '';
	});

	const linked = $derived(new Set(entries.map((s) => s.supplierId)));
	const available = $derived(options.filter((o) => !linked.has(o.id)));

	const columns: Column<SupplierPartRow>[] = [
		{ key: 'supplier', label: 'Supplier' },
		{ key: 'vendorPn', label: 'Vendor PN', mono: true, width: '14rem' },
		{ key: 'preferred', label: 'Preferred', width: '6rem' },
		{ key: 'leadTime', label: 'Lead days', width: '6rem', align: 'right', mono: true },
		{ key: 'notes', label: 'Notes', width: '16rem' },
		{ key: 'actions', label: '', width: '8rem', align: 'right' }
	];

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await act(
			() =>
				opal.purchasing.catalog.add({
					id: Number(supplierId),
					partId: part.id,
					vendorPn: vendorPn.trim(),
					isPreferred: preferred,
					notes: notes.trim() || null
				}),
			'Supplier linked'
		);
		busy = false;
		if (ok) {
			supplierId = '';
			preferred = false;
			notes = '';
			adding = false;
		}
	}

	async function prefer(s: SupplierPartRow) {
		await act(
			() => opal.purchasing.catalog.update({ id: s.supplierId, entryId: s.id, isPreferred: true }),
			`${s.supplierName} preferred`
		);
	}

	async function unlink(s: SupplierPartRow) {
		const ok = await confirm({
			title: `Unlink ${s.supplierName}`,
			body: `${s.vendorPn} leaves ${part.internalPn}'s supplier list. The supplier itself is unchanged.`,
			action: 'UNLINK',
			destructive: true
		});
		if (ok)
			await act(() => opal.purchasing.catalog.remove({ id: s.supplierId, entryId: s.id }), 'Supplier unlinked');
	}
</script>

{#snippet addForm()}
	<form
		class="flex flex-wrap items-end gap-2 border-t border-border bg-muted/30 p-2"
		onsubmit={add}
	>
		<FormField label="Supplier" for="sup-supplier" class="w-56">
			<NativeSelect.Root
				id="sup-supplier"
				size="sm"
				class="w-full"
				bind:value={supplierId}
				required
			>
				<NativeSelect.Option value="">Select supplier</NativeSelect.Option>
				{#each available as o (o.id)}<NativeSelect.Option value={String(o.id)}
						>{o.name}</NativeSelect.Option
					>{/each}
			</NativeSelect.Root>
		</FormField>
		<FormField label="Vendor PN" for="sup-pn" class="w-48">
			<Input id="sup-pn" class="font-mono" bind:value={vendorPn} required />
		</FormField>
		<FormField label="Notes" for="sup-notes" class="w-56">
			<Input id="sup-notes" bind:value={notes} />
		</FormField>
		<div class="flex items-center gap-2 pb-2">
			<Checkbox id="sup-preferred" bind:checked={preferred} />
			<Label for="sup-preferred" class="label">Preferred</Label>
		</div>
		<Button type="submit" size="sm" disabled={busy || !supplierId}>LINK</Button>
		<a href="/suppliers" class="pb-2 font-mono text-xs font-medium text-info hover:underline"
			>SUPPLIERS</a
		>
	</form>
{/snippet}

{#if entries.length}
	<Section title="Suppliers" count={entries.length}>
		{#snippet actions()}
			<ActionLink onclick={() => (adding = !adding)}>{adding ? 'CANCEL' : '+ ADD'}</ActionLink>
		{/snippet}
		<DataTable
			rows={entries}
			{columns}
			key={(s) => s.id}
			href={(s) => `/suppliers/${s.supplierId}`}
			emptyLabel="SUPPLIERS"
		>
			{#snippet cell(s, col)}
				{#if col.key === 'supplier'}
					<a href={`/suppliers/${s.supplierId}`} class="text-info hover:underline"
						>{s.supplierName}</a
					>
				{:else if col.key === 'vendorPn'}
					{s.vendorPn}
				{:else if col.key === 'preferred'}
					{#if s.isPreferred}<span class="font-mono text-xs font-medium text-ok">PREFERRED</span
						>{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'leadTime'}
					{#if s.leadTimeDays != null}{s.leadTimeDays}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'notes'}
					{#if s.notes}{s.notes}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<span class="inline-flex gap-3">
						{#if !s.isPreferred}<ActionLink onclick={() => prefer(s)}>PREFER</ActionLink>{/if}
						<ActionLink danger onclick={() => unlink(s)}>UNLINK</ActionLink>
					</span>
				{/if}
			{/snippet}
		</DataTable>
		{#if adding}{@render addForm()}{/if}
	</Section>
{:else if detail.expects.suppliers}
	<div>
		<EmptyLine label="SUPPLIERS" onadd={() => (adding = true)} />
		{#if adding}{@render addForm()}{/if}
	</div>
{/if}
