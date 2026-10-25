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
		type Column,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { unitMoney } from '#lib/format.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PickedPart } from '#lib/components/parts/types.js';
	import type { SupplierPartRow } from './types.js';

	let {
		supplierId,
		entries,
		onchanged
	}: { supplierId: number; entries: SupplierPartRow[]; onchanged: () => void | Promise<void> } =
		$props();

	let open = $state(false);
	let editing = $state<SupplierPartRow | null>(null);
	let part = $state<PickedPart | null>(null);
	let vendorPn = $state('');
	let preferred = $state(false);
	let leadTime = $state('');
	let notes = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function openDialog(entry: SupplierPartRow | null) {
		editing = entry;
		part = null;
		vendorPn = entry?.vendorPn ?? '';
		preferred = entry?.isPreferred ?? false;
		leadTime = entry?.leadTimeDays == null ? '' : String(entry.leadTimeDays);
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
				vendorPn: vendorPn.trim(),
				isPreferred: preferred,
				leadTimeDays: String(leadTime).trim() === '' ? null : Number(leadTime),
				notes: notes.trim() || null
			};
			if (editing)
				await opal.purchasing.catalog.update({ id: supplierId, entryId: editing.id, ...body });
			else await opal.purchasing.catalog.add({ id: supplierId, ...body, partId: part!.id });
			open = false;
			await onchanged();
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Failed to save';
		} finally {
			busy = false;
		}
	}

	async function remove(entry: SupplierPartRow) {
		const ok = await confirm({
			title: `Remove ${entry.partInternalPn}`,
			body: 'The catalog number is deleted. Existing purchase orders are unaffected.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.purchasing.catalog.remove({ id: supplierId, entryId: entry.id });
			await onchanged();
		} catch (err) {
			toastError(err);
		}
	}

	const columns: Column<SupplierPartRow>[] = [
		{
			key: 'partInternalPn',
			label: 'PN',
			mono: true,
			sortable: true,
			class: 'whitespace-nowrap'
		},
		{ key: 'partName', label: 'Name', sortable: true },
		{ key: 'vendorPn', label: 'Supplier PN', mono: true, sortable: true },
		{ key: 'isPreferred', label: 'Preferred' },
		{ key: 'leadTimeDays', label: 'Lead days', align: 'right', mono: true },
		{ key: 'lastUnitCost', label: 'Last cost', align: 'right', mono: true },
		{ key: 'lastOrderedAt', label: 'Last ordered' },
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
				{#if col.key === 'partInternalPn'}
					<a href={`/parts/${r.partId}`} class="text-info hover:underline">{r.partInternalPn}</a>
				{:else if col.key === 'isPreferred'}
					{#if r.isPreferred}<State value="preferred" tone="ok" />{/if}
				{:else if col.key === 'leadTimeDays'}
					{#if r.leadTimeDays != null}{r.leadTimeDays}{:else}<span class="text-muted-foreground"
							>—</span
						>{/if}
				{:else if col.key === 'lastUnitCost'}
					{unitMoney(r.lastUnitCost)}
				{:else if col.key === 'lastOrderedAt'}
					<Timestamp value={r.lastOrderedAt} dateOnly />
				{:else if col.key === 'notes'}
					{#if r.notes}{r.notes}{:else}<span class="text-muted-foreground">—</span>{/if}
				{:else if col.key === 'actions'}
					<span class="inline-flex gap-3">
						<ActionLink onclick={() => openDialog(r)}>EDIT</ActionLink>
						<ActionLink danger onclick={() => remove(r)}>REMOVE</ActionLink>
					</span>
				{:else if col.key === 'vendorPn'}
					{r.vendorPn}
				{:else}
					{r.partName}
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
				<Label class="label" for="cat-part">Part</Label>
				{#if editing}
					<div class="flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs">
						<span class="font-mono text-info">{editing.partInternalPn}</span>
						<span class="truncate">{editing.partName}</span>
					</div>
				{:else}
					<PartPicker id="cat-part" bind:value={part} meta="procurement" />
				{/if}
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="cat-pn">Supplier part number</Label>
				<Input id="cat-pn" bind:value={vendorPn} required maxlength={255} class="font-mono" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="cat-lead">Lead time (days)</Label>
				<Input
					id="cat-lead"
					type="number"
					min="0"
					step="1"
					bind:value={leadTime}
					class="font-mono"
				/>
			</div>
			<div class="flex items-center gap-2">
				<Checkbox id="cat-pref" bind:checked={preferred} />
				<Label for="cat-pref" class="text-xs">Preferred supplier for this part</Label>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="cat-notes">Notes</Label>
				<Input id="cat-notes" bind:value={notes} />
			</div>
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>{editing ? 'SAVE' : 'ADD PART'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
