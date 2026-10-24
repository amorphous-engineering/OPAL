<script lang="ts" module>
	export type StockAction = 'adjust' | 'count' | 'move';
</script>

<script lang="ts">
	// One dialog for the three ways on-hand changes by hand: adjust (reasoned
	// delta), count (reconcile to a physical number), move (relocate or split).
	// Every one writes a ledger row server-side.
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import { toast, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { qty } from '#lib/format.js';
	import type { AdjustReason, StockRecord } from '@opal/shared';

	let {
		open = $bindable(false),
		action,
		record,
		locations,
		reason: presetReason,
		ondone
	}: {
		open: boolean;
		action: StockAction;
		record: StockRecord;
		locations: string[];
		/** Adjust only: start on this reason (SCRAP opens with `scrap`). */
		reason?: string;
		ondone: () => void | Promise<void>;
	} = $props();

	const current = $derived(Number(record.balance));
	const serialized = $derived(record.partTrackingType === 'serialized');
	const uom = $derived(record.partUom);

	let busy = $state(false);
	let error = $state<string | null>(null);

	// adjust
	let reason = $state('found');
	let direction = $state<'add' | 'remove'>('add');
	let amount = $state('');
	let notes = $state('');
	// count
	let counted = $state('');
	// move
	let moveQty = $state('');
	let toLocation = $state('');
	let toLot = $state('');

	// Re-seed whenever the dialog opens.
	$effect(() => {
		if (!open) return;
		error = null;
		notes = '';
		reason = presetReason ?? 'found';
		direction = 'add';
		amount = presetReason === 'scrap' || presetReason === 'damage' ? String(current) : '';
		counted = String(current);
		moveQty = String(current);
		toLocation = '';
		toLot = '';
	});

	const sign = $derived(
		reason === 'found'
			? 1
			: reason === 'damage' || reason === 'scrap'
				? -1
				: direction === 'add'
					? 1
					: -1
	);
	const delta = $derived(sign * Math.max(0, Number(amount) || 0));
	const newOnHand = $derived(current + delta);
	const countDelta = $derived((Number(counted) || 0) - current);

	const title = $derived(
		action === 'adjust' ? 'Adjust quantity' : action === 'count' ? 'Record count' : 'Move stock'
	);

	const valid = $derived.by(() => {
		if (action === 'adjust')
			return Number(amount) > 0 && newOnHand >= 0 && (!serialized || newOnHand <= 1);
		if (action === 'count')
			return counted !== '' && Number(counted) >= 0 && (!serialized || Number(counted) <= 1);
		return (
			Number(moveQty) > 0 &&
			Number(moveQty) <= current &&
			!!toLocation.trim() &&
			(toLocation.trim() !== record.location ||
				(toLot.trim() !== '' && toLot.trim() !== record.lotNumber))
		);
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!valid) return;
		busy = true;
		error = null;
		try {
			if (action === 'adjust') {
				await opal.inventory.adjust({
					id: record.id,
					adjustment: `${sign < 0 ? '-' : ''}${amount}`,
					reason: reason as AdjustReason,
					notes: notes.trim() || null
				});
				toast.success(`${record.opalNumber} on hand ${qty(newOnHand, uom)}`);
			} else if (action === 'count') {
				await opal.inventory.count({ id: record.id, countedQuantity: counted });
				toast.success(`${record.opalNumber} counted ${qty(counted, uom)}`);
			} else {
				const moved = await opal.inventory.transfer({
					sourceId: record.id,
					targetLocation: toLocation.trim(),
					quantity: moveQty,
					targetLotNumber: toLot.trim() || null,
					notes: notes.trim() || null
				});
				const other = moved.target.opalNumber;
				if (other !== record.opalNumber) {
					toast.success(`${qty(moveQty, uom)} moved to ${toLocation.trim()} as ${other}`, {
						action: { label: 'OPEN', onClick: () => goto(`/inventory/opal/${other}`) }
					});
				} else {
					toast.success(`${record.opalNumber} moved to ${toLocation.trim()}`);
				}
			}
			open = false;
			await ondone();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-baseline gap-2 text-sm font-semibold">
				{title}
				<span class="font-mono text-xs font-normal text-info">{record.opalNumber}</span>
			</Dialog.Title>
			<Dialog.Description class="font-mono text-xs text-muted-foreground">
				On hand {qty(current, uom)} · {record.location || '—'}
			</Dialog.Description>
		</Dialog.Header>

		<form onsubmit={submit} class="grid grid-cols-1 gap-3">
			{#if action === 'adjust'}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="adj-reason">Reason</Label>
					<NativeSelect id="adj-reason" class="w-full" bind:value={reason}>
						<option value="found">Found (add)</option>
						<option value="correction">Correction (add or remove)</option>
						<option value="damage">Damaged (remove)</option>
						<option value="scrap">Scrapped (remove)</option>
					</NativeSelect>
				</div>
				{#if reason === 'correction'}
					<div class="grid grid-cols-1 gap-1.5">
						<Label class="label" for="adj-dir">Direction</Label>
						<NativeSelect id="adj-dir" class="w-full" bind:value={direction}>
							<option value="add">Add</option>
							<option value="remove">Remove</option>
						</NativeSelect>
					</div>
				{/if}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="adj-amount">Quantity</Label>
					<Input
						id="adj-amount"
						type="number"
						min="0"
						step="any"
						class="font-mono"
						bind:value={amount}
						required
					/>
					<p
						class="font-mono text-xs {newOnHand < 0 || (serialized && newOnHand > 1)
							? 'text-error'
							: 'text-muted-foreground'}"
					>
						New on hand {qty(newOnHand, uom)}
					</p>
				</div>
			{:else if action === 'count'}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="count-qty">Counted quantity</Label>
					<Input
						id="count-qty"
						type="number"
						min="0"
						step="any"
						class="font-mono"
						bind:value={counted}
						required
					/>
					<p class="font-mono text-xs text-muted-foreground">
						Difference {countDelta > 0 ? '+' : ''}{qty(countDelta, uom)}
					</p>
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="mv-qty">Quantity</Label>
					<Input
						id="mv-qty"
						type="number"
						min="0"
						max={current}
						step="any"
						class="font-mono"
						bind:value={moveQty}
						disabled={serialized}
						required
					/>
					{#if Number(moveQty) > 0 && Number(moveQty) < current}
						<p class="font-mono text-xs text-muted-foreground">
							Remaining {qty(current - Number(moveQty), uom)}
						</p>
					{/if}
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="mv-loc">To location</Label>
					<Input
						id="mv-loc"
						list="mv-locations"
						class="font-mono"
						autocomplete="off"
						bind:value={toLocation}
						required
					/>
					<datalist id="mv-locations">
						{#each locations as l (l)}<option value={l}></option>{/each}
					</datalist>
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="mv-lot">To lot</Label>
					<Input
						id="mv-lot"
						class="font-mono"
						autocomplete="off"
						placeholder={record.lotNumber ?? ''}
						bind:value={toLot}
					/>
				</div>
			{/if}

			{#if action !== 'count'}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="act-notes">Notes</Label>
					<Textarea id="act-notes" rows={2} bind:value={notes} />
				</div>
			{/if}

			<ErrorBanner message={error} />

			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy || !valid}>
					{action === 'adjust' ? 'APPLY' : action === 'count' ? 'RECORD' : 'MOVE'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
