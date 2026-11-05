<script lang="ts">
	// Amend a line of a placed order: quantity, unit cost or destination, with the reason that
	// goes on the record next to the old value.
	import { ErrorBanner } from '#lib/components/opal/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { num, type PurchaseLine } from './types.js';

	let {
		open = $bindable(false),
		purchaseId,
		line,
		locations = [],
		onsaved
	}: {
		open: boolean;
		purchaseId: number;
		line: PurchaseLine | null;
		locations?: string[];
		onsaved: () => void | Promise<void>;
	} = $props();

	let qty = $state('');
	let cost = $state('');
	let destination = $state('');
	let reason = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		if (!open || !line) return;
		error = null;
		qty = line.qtyOrdered;
		cost = line.unitCost ?? '';
		destination = line.destination ?? '';
		reason = '';
	});

	const floor = $derived(line ? num(line.qtyReceived) + num(line.qtyCancelled) : 0);
	const costLocked = $derived(line ? num(line.qtyReceived) > 0 : false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!line) return;
		error = null;
		const body: Record<string, string | null> = {};
		if (String(qty).trim() !== line.qtyOrdered) body.qtyOrdered = String(qty).trim();
		if (!costLocked && String(cost).trim() !== (line.unitCost ?? '')) {
			body.unitCost = String(cost).trim() === '' ? null : String(cost).trim();
		}
		if (destination.trim() !== (line.destination ?? ''))
			body.destination = destination.trim() || null;
		if (Object.keys(body).length === 0) {
			error = 'Change a value';
			return;
		}
		busy = true;
		try {
			await opal.purchasing.orders.amendLine({
				id: purchaseId,
				lineId: line.id,
				reason: reason.trim(),
				...body
			});
			open = false;
			await onsaved();
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Amend failed';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-baseline gap-2 text-sm font-semibold">
				Amend line
				{#if line}<span class="font-mono text-xs font-normal text-info">{line.partInternalPn}</span
					>{/if}
			</Dialog.Title>
		</Dialog.Header>
		{#if line}
			<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
				<div class="grid grid-cols-2 gap-3">
					<div class="grid grid-cols-1 gap-1.5">
						<Label class="label" for="amend-qty">Quantity ({line.unitOfMeasure})</Label>
						<Input
							id="amend-qty"
							type="number"
							step="any"
							min={floor}
							bind:value={qty}
							required
							class="font-mono"
						/>
					</div>
					<div class="grid grid-cols-1 gap-1.5">
						<Label class="label" for="amend-cost">Unit cost</Label>
						<Input
							id="amend-cost"
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
					<Label class="label" for="amend-dest">Destination</Label>
					<Input id="amend-dest" bind:value={destination} list="amend-locations" />
					<datalist id="amend-locations">
						{#each locations as l (l)}<option value={l}></option>{/each}
					</datalist>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="amend-reason">Reason</Label>
					<Textarea id="amend-reason" bind:value={reason} rows={2} required />
				</div>
				<ErrorBanner message={error} />
				<Dialog.Footer>
					<Button variant="ghost" type="button" onclick={() => (open = false)}>CANCEL</Button>
					<Button type="submit" disabled={busy || !reason.trim()}>AMEND</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
