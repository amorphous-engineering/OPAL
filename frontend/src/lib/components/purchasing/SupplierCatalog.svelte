<script lang="ts">
	// Parts this supplier carries: their catalog number, preferred flag, last paid cost.
	import {
		ActionLink,
		Section,
		DataTable,
		EmptyLine,
		State,
		Timestamp,
		confirm,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { money } from '#lib/format.js';
	import PartPicker from './PartPicker.svelte';
	import type { PickedPart, SupplierPart } from './types.js';

	let {
		supplierId,
		entries,
		onchanged
	}: { supplierId: number; entries: SupplierPart[]; onchanged: () => void | Promise<void> } =
		$props();

	let open = $state(false);
	let editing = $state<SupplierPart | null>(null);
	let part = $state<PickedPart | null>(null);
	let vendorPn = $state('');
	let preferred = $state(false);
	let notes = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function openDialog(entry: SupplierPart | null) {
		editing = entry;
		part = null;
		vendorPn = entry?.vendor_pn ?? '';
		preferred = entry?.is_preferred ?? false;
		notes = entry?.notes ?? '';
		error = null;
		open = true;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!editing && !part) {
			error = 'Select a part';
			return;
		}
		busy = true;
		try {
			const body = {
				vendor_pn: vendorPn.trim(),
				is_preferred: preferred,
				notes: notes.trim() || null
			};
			if (editing) await api.put(`/suppliers/${supplierId}/parts/${editing.id}`, body);
			else await api.post(`/suppliers/${supplierId}/parts`, { ...body, part_id: part!.id });
			open = false;
			await onchanged();
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Failed to save';
		} finally {
			busy = false;
		}
	}

	async function remove(entry: SupplierPart) {
		const ok = await confirm({
			title: `Remove ${entry.part_internal_pn ?? entry.part_name}`,
			body: 'The catalog number is deleted. Existing purchase orders are unaffected.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/suppliers/${supplierId}/parts/${entry.id}`);
			await onchanged();
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<SupplierPart>[] = [
		{
			key: 'part_internal_pn',
			label: 'Part',
			mono: true,
			sortable: true,
			class: 'whitespace-nowrap'
		},
		{ key: 'part_name', label: 'Name', sortable: true },
		{ key: 'vendor_pn', label: 'Supplier PN', mono: true, sortable: true },
		{ key: 'is_preferred', label: 'Preferred' },
		{ key: 'last_unit_cost', label: 'Last cost', align: 'right', mono: true },
		{ key: 'last_ordered_at', label: 'Last ordered' },
		{ key: 'notes', label: 'Notes' },
		{ key: 'actions', label: '', align: 'right' }
	];
</script>

{#if entries.length === 0}
	<EmptyLine label="Parts supplied" onadd={() => openDialog(null)} addLabel="+ ADD PART" />
{:else}
	<Section title="PARTS SUPPLIED" count={entries.length}>
		{#snippet actions()}
			<ActionLink onclick={() => openDialog(null)}>+ ADD PART</ActionLink>
		{/snippet}
		<DataTable rows={entries} {columns} emptyLabel="Parts supplied" key={(r) => r.id}>
			{#snippet cell(r, col)}
				{#if col.key === 'part_internal_pn'}
					<a href={`/parts/${r.part_id}`} class="text-info hover:underline"
						>{r.part_internal_pn ?? '—'}</a
					>
				{:else if col.key === 'is_preferred'}
					{#if r.is_preferred}<State value="preferred" tone="ok" />{/if}
				{:else if col.key === 'last_unit_cost'}
					{money(r.last_unit_cost)}
				{:else if col.key === 'last_ordered_at'}
					<Timestamp value={r.last_ordered_at} dateOnly />
				{:else if col.key === 'notes'}
					{#if r.notes}{r.notes}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'actions'}
					<span class="inline-flex gap-3">
						<ActionLink onclick={() => openDialog(r)}>EDIT</ActionLink>
						<ActionLink danger onclick={() => remove(r)}>REMOVE</ActionLink>
					</span>
				{:else}
					{(r as unknown as Record<string, string>)[col.key]}
				{/if}
			{/snippet}
		</DataTable>
	</Section>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header
			><Dialog.Title>{editing ? 'Edit catalog entry' : 'Add part'}</Dialog.Title></Dialog.Header
		>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="cat-part">Part</Label>
				{#if editing}
					<div class="flex h-8 items-center gap-2 border border-border px-2.5 text-xs">
						<span class="font-mono text-info">{editing.part_internal_pn ?? '—'}</span>
						<span class="truncate">{editing.part_name}</span>
					</div>
				{:else}
					<PartPicker id="cat-part" bind:value={part} activeOnly={false} />
				{/if}
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="cat-pn">Supplier part number</Label>
				<Input id="cat-pn" bind:value={vendorPn} required maxlength={255} class="font-mono" />
			</div>
			<div class="flex items-center gap-2">
				<Checkbox id="cat-pref" bind:checked={preferred} />
				<Label for="cat-pref" class="text-xs">Preferred supplier for this part</Label>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="cat-notes">Notes</Label>
				<Input id="cat-notes" bind:value={notes} />
			</div>
			{#if error}
				<p
					role="alert"
					class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
				>
					{error}
				</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>{editing ? 'SAVE' : 'ADD PART'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
