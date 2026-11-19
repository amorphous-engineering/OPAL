<script lang="ts">
	import { goto } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import {
		DataTable,
		Field,
		FormKeys,
		needs,
		PageHeader,
		Section,
		toast
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PickedPart } from '#lib/components/parts/types.js';
	import type { StockRecord } from '@opal/shared';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let part = $derived<PickedPart | null>(data.part);
	let rules = $derived(data.rules);
	let quantity = $state('1');
	let location = $state('');
	let lot = $state('');
	let serial = $state('');
	let expiration = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let created = $state<StockRecord[] | null>(null);
	async function pick(p: PickedPart) {
		part = p;
		quantity = '1';
		lot = '';
		serial = '';
		rules = null;
		try {
			rules = await opal.inventory.receivingRules({ partId: p.id });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not load receiving rules';
		}
	}

	const serialized = $derived(part?.tracking_type === 'serialized');

	// What the part's tier asks of a receipt: a lot for bulk stock, generated serials for units.
	const rule = $derived({
		requireLot: rules?.requireLot ?? false,
		autoSerial: rules?.autoSerial ?? false
	});

	const count = $derived(Math.max(0, Math.floor(Number(quantity)) || 0));
	const missing = $derived([
		...needs({
			part,
			quantity: Number(quantity) > 0,
			location: location.trim(),
			lot: !rule.requireLot || lot.trim()
		}),
		...(serialized && Number(quantity) > 0 && !Number.isInteger(Number(quantity))
			? ['whole units']
			: [])
	]);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!part || missing.length) return;
		busy = true;
		error = null;
		try {
			const r = await opal.inventory.create({
				partId: part.id,
				quantity: String(quantity).trim(),
				location: location.trim(),
				lotNumber: lot.trim() || null,
				// One serial names one unit; a batch takes generated serials.
				serialNumber: count > 1 ? null : serial.trim() || null,
				expirationDate: expiration || null,
				enforceTierRules: true
			});
			if (r.items.length === 1) {
				toast.success(`Received ${r.items[0].opalNumber}`);
				await goto(`/inventory/opal/${r.items[0].opalNumber}`);
			} else {
				created = r.items;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Receive failed';
		} finally {
			busy = false;
		}
	}

	function another() {
		created = null;
		quantity = '1';
		lot = '';
	}
</script>

<PageHeader
	title="Receive stock"
	crumbs={[{ label: 'Stock', href: '/inventory' }, { label: 'Receive' }]}
/>

<div class="max-w-3xl space-y-4 p-4">
	{#if created && part}
		<Section title="Received" count={created.length}>
			{#snippet actions()}
				<Button
					size="sm"
					variant="outline"
					href="/label?inventory={created!.map((i) => i.opalNumber).join(',')}">PRINT LABELS</Button
				>
				<Button size="sm" variant="outline" onclick={another}>RECEIVE MORE</Button>
			{/snippet}
			<DataTable
				rows={created}
				columns={[
					{ key: 'opal_number', label: 'OPAL', mono: true },
					{ key: 'serial', label: serialized ? 'Lot / serial' : 'Lot', mono: true },
					{ key: 'location', label: 'Location', mono: true }
				]}
				href={(r) => `/inventory/opal/${r.opalNumber}`}
				emptyLabel="Records"
				key={(r) => r.id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'opal_number'}
						<span class="font-semibold text-info">{r.opalNumber}</span>
					{:else if col.key === 'serial'}
						{r.serialNumber ?? r.lotNumber ?? '—'}
					{:else}
						{r.location}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<form class="grid grid-cols-1 gap-3" onsubmit={submit}>
			<Section title="Receipt">
				<div class="grid grid-cols-1 gap-3 p-3">
					<Field label="Part" for="rx-part" required>
						{#if part}
							<div class="flex flex-wrap items-center gap-2 text-sm">
								<span class="font-mono text-info">{part.internal_pn ?? '—'}</span>
								<span>{part.name}</span>
								<span class="font-mono text-xs text-muted-foreground uppercase"
									>{part.tracking_type}{rules?.tierName ? ` · ${rules?.tierName}` : ''}</span
								>
								<Button size="sm" variant="outline" onclick={() => (part = null)}>CHANGE</Button>
							</div>
						{:else}
							<PartPicker
								id="rx-part"
								placeholder="Part number or name"
								activeOnly
								meta="tracking_type"
								onselect={(p: PickedPart | null) => p && pick(p)}
							/>
						{/if}
					</Field>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Field label={serialized ? 'Units' : 'Quantity'} for="rx-qty" required>
							<div class="flex items-center gap-2">
								<Input
									id="rx-qty"
									type="number"
									min="0"
									step={serialized ? '1' : 'any'}
									class="w-32 font-mono"
									bind:value={quantity}
									required
								/>
								{#if part && part.unit_of_measure !== 'ea'}
									<span class="font-mono text-xs text-muted-foreground uppercase"
										>{part.unit_of_measure}</span
									>
								{/if}
								{#if serialized && count > 1}
									<span class="font-mono text-xs text-muted-foreground">{count} records</span>
								{/if}
							</div>
						</Field>
						<Field label="Location" for="rx-location" required>
							<Input
								id="rx-location"
								list="locations"
								class="font-mono"
								bind:value={location}
								required
								autocomplete="off"
							/>
							<datalist id="locations">
								{#each data.locations as l (l)}<option value={l}></option>{/each}
							</datalist>
						</Field>
						<Field label="Lot" for="rx-lot" required={rule.requireLot}>
							<Input
								id="rx-lot"
								class="font-mono"
								bind:value={lot}
								required={rule.requireLot}
								autocomplete="off"
							/>
						</Field>
						{#if serialized}
							<Field label="Serial" for="rx-serial">
								<Input
									id="rx-serial"
									class="font-mono"
									placeholder={rule.autoSerial ? 'Generated per unit' : ''}
									bind:value={serial}
									disabled={count > 1}
									autocomplete="off"
								/>
							</Field>
						{/if}
						<Field label="Expires" for="rx-expires">
							<Input id="rx-expires" type="date" class="w-44 font-mono" bind:value={expiration} />
						</Field>
					</div>
				</div>
			</Section>
			<FormKeys
				submit="RECEIVE"
				cancel={part ? `/parts/${part.id}` : '/inventory'}
				{missing}
				{busy}
				{error}
			/>
		</form>
	{/if}
</div>
