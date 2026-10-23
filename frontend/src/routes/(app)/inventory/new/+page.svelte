<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/api.js';
	import {
		DataTable,
		DetailRow,
		DetailTable,
		PageHeader,
		Section,
		toast,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { InventoryItem, PickedPart } from '#lib/components/inventory/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let part = $derived<PickedPart | null>(data.part);
	let quantity = $state('1');
	let location = $state('');
	let lot = $state('');
	let expiration = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let created = $state<InventoryItem[] | null>(null);
	function pick(p: PickedPart) {
		part = p;
		quantity = '1';
		lot = '';
	}

	const serialized = $derived(part?.tracking_type === 'serialized');

	// Tier rules from the project config; legacy level rules when the tier is not configured.
	const rule = $derived.by(() => {
		if (!part) return { requireLot: false, autoSerial: false };
		const t = data.tiers.find((x) => x.level === part!.tier);
		const requireLot = t ? t.require_lot : part.tier === 1 || part.tier === 2;
		const autoSerial = t ? t.auto_serial : part.tier === 1;
		return {
			requireLot: requireLot && !serialized,
			autoSerial: autoSerial && serialized
		};
	});

	const count = $derived(Math.max(0, Math.floor(Number(quantity)) || 0));
	const valid = $derived(
		!!part &&
			Number(quantity) > 0 &&
			(!serialized || Number.isInteger(Number(quantity))) &&
			!!location.trim() &&
			(!rule.requireLot || !!lot.trim())
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!part || !valid) return;
		busy = true;
		error = null;
		try {
			const r = await api.post<{ items: InventoryItem[] }>('/inventory', {
				part_id: part.id,
				quantity: Number(quantity),
				location: location.trim(),
				lot_number: lot.trim() || null,
				expiration_date: expiration || null,
				enforce_tier_rules: true
			});
			if (r.items.length === 1) {
				toast.success(`Received ${r.items[0].opal_number}`);
				await goto(`/inventory/opal/${r.items[0].opal_number}`);
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
					size="xs"
					variant="outline"
					href="/label?inventory={created!.map((i) => i.opal_number).join(',')}"
					>PRINT LABELS</Button
				>
				<Button size="xs" variant="outline" onclick={another}>RECEIVE MORE</Button>
			{/snippet}
			<DataTable
				rows={created}
				columns={[
					{ key: 'opal_number', label: 'OPAL', mono: true },
					{ key: 'lot_number', label: serialized ? 'Lot / serial' : 'Lot', mono: true },
					{ key: 'location', label: 'Location', mono: true }
				]}
				href={(r) => `/inventory/opal/${r.opal_number}`}
				emptyLabel="Records"
				key={(r) => r.id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'opal_number'}
						<span class="font-semibold text-info">{r.opal_number}</span>
					{:else if col.key === 'lot_number'}
						{r.lot_number ?? '—'}
					{:else}
						{r.location}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{:else}
		<form onsubmit={submit} class="rounded-lg border border-border bg-card">
			<DetailTable>
				<DetailRow label="Part *">
					{#if part}
						<div class="flex items-center gap-2">
							<span class="font-mono text-info">{part.internal_pn ?? '—'}</span>
							<span>{part.name}</span>
							<span class="font-mono text-xs text-muted-foreground uppercase"
								>{part.tracking_type}{part.tier_name ? ` · ${part.tier_name}` : ''}</span
							>
							<Button size="xs" variant="ghost" class="ml-auto" onclick={() => (part = null)}
								>CHANGE</Button
							>
						</div>
					{:else}
						<PartPicker
							placeholder="Part number or name"
							activeOnly
							meta="tracking_type"
							onselect={(p: PickedPart | null) => p && pick(p)}
						/>
					{/if}
				</DetailRow>
				<DetailRow label={serialized ? 'Units *' : 'Quantity *'}>
					<div class="flex items-center gap-2">
						<Input
							aria-label={serialized ? 'Units' : 'Quantity'}
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
				</DetailRow>
				<DetailRow label="Location *">
					<Input
						aria-label="Location"
						list="locations"
						class="max-w-xs font-mono"
						bind:value={location}
						required
						autocomplete="off"
					/>
					<datalist id="locations">
						{#each data.locations as l (l)}<option value={l}></option>{/each}
					</datalist>
				</DetailRow>
				<DetailRow label={`${serialized ? 'Lot / serial' : 'Lot'}${rule.requireLot ? ' *' : ''}`}>
					<Input
						aria-label={serialized ? 'Lot / serial' : 'Lot'}
						class="max-w-xs font-mono"
						placeholder={rule.autoSerial ? 'Generated per unit' : ''}
						bind:value={lot}
						required={rule.requireLot}
						autocomplete="off"
					/>
				</DetailRow>
				<DetailRow label="Expires">
					<Input aria-label="Expires" type="date" class="w-44 font-mono" bind:value={expiration} />
				</DetailRow>
			</DetailTable>
			<ErrorBanner message={error} class="mx-3 mb-3" />
			<div class="flex justify-end gap-2 border-t border-border bg-muted/40 px-3 py-2">
				<Button variant="outline" href={part ? `/parts/${part.id}` : '/inventory'}>CANCEL</Button>
				<Button type="submit" disabled={busy || !valid}>RECEIVE</Button>
			</div>
		</form>
	{/if}
</div>
