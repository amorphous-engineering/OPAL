<script lang="ts">
	// Add or edit one PO line. Edit keeps the part fixed; remove + re-add to change it.
	import { ErrorBanner } from '#lib/components/opal/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PickedPart } from '#lib/components/parts/types.js';
	import { num, type PurchaseLine } from './types.js';

	let {
		open = $bindable(false),
		purchaseId,
		line = null,
		locations = [],
		onsaved
	}: {
		open: boolean;
		purchaseId: number;
		line?: PurchaseLine | null;
		locations?: string[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let part = $state<PickedPart | null>(null);
	let qty = $state('');
	let cost = $state('');
	let destination = $state('');
	let notes = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (!open) return;
		error = null;
		part = null;
		qty = line ? line.qtyOrdered : '';
		cost = line?.unitCost ?? '';
		destination = line?.destination ?? '';
		notes = line?.notes ?? '';
	});

	const received = $derived(line ? num(line.qtyReceived) : 0);
	const costLocked = $derived(received > 0);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!line && !part) {
			error = 'Select a part';
			return;
		}
		busy = true;
		try {
			const body = {
				qtyOrdered: qty.trim(),
				unitCost: cost.trim() === '' ? null : cost.trim(),
				destination: destination.trim() || null,
				notes: notes.trim() || null
			};
			if (line) {
				const { unitCost, ...rest } = body;
				await opal.purchasing.orders.updateLine({
					id: purchaseId,
					lineId: line.id,
					...(costLocked ? rest : body)
				});
				void unitCost;
			} else {
				await opal.purchasing.orders.addLine({ id: purchaseId, ...body, partId: part!.id });
			}
			open = false;
			await onsaved();
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Failed to save line';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{line ? 'Edit line' : 'Add line'}</Dialog.Title>
		</Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="line-part">Part</Label>
				{#if line}
					<div class="flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs">
						<span class="font-mono text-info">{line.partInternalPn}</span>
						<span class="truncate">{line.partName}</span>
					</div>
				{:else}
					<PartPicker id="line-part" bind:value={part} activeOnly meta="procurement" />
				{/if}
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="line-qty"
						>Quantity{line?.unitOfMeasure && line.unitOfMeasure !== 'ea'
							? ` (${line.unitOfMeasure})`
							: ''}</Label
					>
					<Input
						id="line-qty"
						type="number"
						step="any"
						min={received > 0 ? received : 0}
						bind:value={qty}
						required
						class="font-mono"
					/>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="line-cost">Unit cost</Label>
					<Input
						id="line-cost"
						type="number"
						step="any"
						min="0"
						bind:value={cost}
						disabled={costLocked}
						class="font-mono"
					/>
				</div>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="line-dest">Destination</Label>
				<Input
					id="line-dest"
					bind:value={destination}
					list="po-locations"
					placeholder="Defaults to the order's destination"
				/>
				<datalist id="po-locations">
					{#each locations as l (l)}<option value={l}></option>{/each}
				</datalist>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="line-notes">Notes</Label>
				<Input id="line-notes" bind:value={notes} />
			</div>
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button variant="ghost" type="button" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>{line ? 'SAVE' : 'ADD LINE'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
