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
	import { api } from '#lib/api.js';
	import { ActionLink } from '#lib/components/opal/index.js';
	import FormField from './FormField.svelte';
	import { act } from './actions.js';
	import type { PartDetail, PartSupplier } from './types.js';

	let { detail }: { detail: PartDetail } = $props();
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
		api
			.get<{ items: { id: number; name: string }[] }>('/suppliers', {
				per_page: 100,
				is_active: true
			})
			.then((r) => (options = r.items))
			.catch(() => {});
	});

	// Context pre-fill: the part's own external PN is the usual vendor PN.
	$effect(() => {
		if (adding && vendorPn === '') vendorPn = part.external_pn ?? '';
	});

	const linked = $derived(new Set(detail.suppliers.map((s) => s.supplier_id)));
	const available = $derived(options.filter((o) => !linked.has(o.id)));

	const columns: Column<PartSupplier>[] = [
		{ key: 'supplier', label: 'Supplier' },
		{ key: 'vendor_pn', label: 'Vendor PN', mono: true, width: '14rem' },
		{ key: 'preferred', label: 'Preferred', width: '6rem' },
		{ key: 'notes', label: 'Notes', width: '16rem' },
		{ key: 'actions', label: '', width: '8rem', align: 'right' }
	];

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await act(
			() =>
				api.post(`/suppliers/${supplierId}/parts`, {
					part_id: part.id,
					vendor_pn: vendorPn.trim(),
					is_preferred: preferred,
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

	async function prefer(s: PartSupplier) {
		await act(
			() => api.put(`/suppliers/${s.supplier_id}/parts/${s.id}`, { is_preferred: true }),
			`${s.supplier_name} preferred`
		);
	}

	async function unlink(s: PartSupplier) {
		const ok = await confirm({
			title: `Unlink ${s.supplier_name}`,
			body: `${s.vendor_pn} leaves ${part.internal_pn}'s supplier list. The supplier itself is unchanged.`,
			action: 'UNLINK',
			destructive: true
		});
		if (ok)
			await act(() => api.del(`/suppliers/${s.supplier_id}/parts/${s.id}`), 'Supplier unlinked');
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

{#if detail.suppliers.length}
	<Section title="Suppliers" count={detail.suppliers.length}>
		{#snippet actions()}
			<ActionLink onclick={() => (adding = !adding)}>{adding ? 'CANCEL' : '+ ADD'}</ActionLink>
		{/snippet}
		<DataTable
			rows={detail.suppliers}
			{columns}
			key={(s) => s.id}
			href={(s) => `/suppliers/${s.supplier_id}`}
			emptyLabel="SUPPLIERS"
		>
			{#snippet cell(s, col)}
				{#if col.key === 'supplier'}
					<a href={`/suppliers/${s.supplier_id}`} class="text-info hover:underline"
						>{s.supplier_name}</a
					>
				{:else if col.key === 'vendor_pn'}
					{s.vendor_pn}
				{:else if col.key === 'preferred'}
					{#if s.is_preferred}<span class="font-mono text-xs font-medium text-ok">PREFERRED</span
						>{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'notes'}
					{#if s.notes}{s.notes}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else}
					<span class="inline-flex gap-3">
						{#if !s.is_preferred}<ActionLink onclick={() => prefer(s)}>PREFER</ActionLink>{/if}
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
