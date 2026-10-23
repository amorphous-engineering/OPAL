<script lang="ts">
	import { goto } from '$app/navigation';
	import { ActionLink, PageHeader, Section } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { money } from '#lib/format.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PickedPart } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface Row {
		key: number;
		part: PickedPart | null;
		qty: string;
		cost: string;
		destination: string;
	}
	let nextKey = 1;
	const blank = (part: PickedPart | null = null): Row => ({
		key: nextKey++,
		part,
		qty: part ? '1' : '',
		cost: '',
		destination: ''
	});

	// Seeded once from the invoking context (supplier or part link).
	/* svelte-ignore state_referenced_locally */
	let supplierId = $state(
		data.supplierId && data.suppliers.some((s) => String(s.id) === data.supplierId)
			? data.supplierId
			: ''
	);
	let otherName = $state('');
	let reference = $state('');
	let supplierRef = $state('');
	let targetDate = $state('');
	let destination = $state('');
	let notes = $state('');
	/* svelte-ignore state_referenced_locally */
	let rows = $state<Row[]>([blank(data.part)]);
	let busy = $state(false);
	let error = $state<string | null>(null);

	const total = $derived(
		rows.reduce(
			(sum, r) => sum + (r.part && r.qty && r.cost ? Number(r.qty) * Number(r.cost) : 0),
			0
		)
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (!supplierId && !otherName.trim()) {
			error = 'Choose a supplier or enter a supplier name';
			return;
		}
		const lines = rows
			.filter((r) => r.part)
			.map((r) => ({
				part_id: r.part!.id,
				qty_ordered: Number(r.qty),
				unit_cost: r.cost === '' ? null : Number(r.cost),
				destination: r.destination.trim() || null
			}));
		if (rows.some((r) => r.part && !(Number(r.qty) > 0))) {
			error = 'Every line needs a quantity above zero';
			return;
		}
		busy = true;
		try {
			const po = await api.post<{ id: number }>('/purchases', {
				supplier_id: supplierId ? Number(supplierId) : null,
				supplier: supplierId ? null : otherName.trim(),
				supplier_reference: supplierRef.trim() || null,
				reference: reference.trim() || null,
				target_date: targetDate || null,
				destination: destination.trim() || null,
				notes: notes.trim() || null,
				lines
			});
			await goto(`/purchases/${po.id}`);
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Failed to create';
		} finally {
			busy = false;
		}
	}
</script>

<PageHeader
	title="New purchase"
	crumbs={[{ label: 'Purchases', href: '/purchases' }, { label: 'New' }]}
/>

<form class="grid max-w-5xl grid-cols-1 gap-4 p-4" onsubmit={submit}>
	<Section title="ORDER">
		<div class="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="po-supplier">Supplier</Label>
				<NativeSelect id="po-supplier" bind:value={supplierId} class="w-full">
					<option value="">Other (enter name)</option>
					{#each data.suppliers as s (s.id)}
						<option value={String(s.id)}>{s.name}{s.code ? ` (${s.code})` : ''}</option>
					{/each}
				</NativeSelect>
			</div>
			{#if !supplierId}
				<div class="grid grid-cols-1 gap-1.5">
					<Label for="po-supplier-name">Supplier name</Label>
					<Input id="po-supplier-name" bind:value={otherName} maxlength={255} />
				</div>
			{/if}
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="po-ref">Reference</Label>
				<Input
					id="po-ref"
					bind:value={reference}
					maxlength={64}
					placeholder="Assigned on save"
					class="font-mono"
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="po-supplier-ref">Supplier reference</Label>
				<Input id="po-supplier-ref" bind:value={supplierRef} maxlength={100} class="font-mono" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="po-target">Target date</Label>
				<Input id="po-target" type="date" bind:value={targetDate} class="font-mono" />
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="po-dest">Destination</Label>
				<Input id="po-dest" bind:value={destination} list="po-locations" maxlength={255} />
				<datalist id="po-locations">
					{#each data.locations as l (l)}<option value={l}></option>{/each}
				</datalist>
			</div>
			<div class="grid grid-cols-1 gap-1.5 md:col-span-2">
				<Label for="po-notes">Notes</Label>
				<Textarea id="po-notes" bind:value={notes} rows={2} class="text-xs" />
			</div>
		</div>
	</Section>

	<Section title="LINES" count={rows.filter((r) => r.part).length}>
		{#snippet actions()}
			<ActionLink onclick={() => rows.push(blank())}>+ ADD LINE</ActionLink>
		{/snippet}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each ['PART', 'QUANTITY', 'UNIT COST', 'DESTINATION', ''] as h (h)}
							<th
								scope="col"
								class="h-8 px-3 text-left font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
								>{h}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row, i (row.key)}
						<tr class="border-b border-border align-top">
							<td class="w-80 px-3 py-1"
								><PartPicker bind:value={row.part} activeOnly meta="procurement" /></td
							>
							<td class="px-3 py-1"
								><Input
									type="number"
									step="any"
									min="0"
									bind:value={row.qty}
									aria-label={`Quantity, line ${i + 1}`}
									class="w-28 font-mono"
								/></td
							>
							<td class="px-3 py-1"
								><Input
									type="number"
									step="any"
									min="0"
									bind:value={row.cost}
									aria-label={`Unit cost, line ${i + 1}`}
									class="w-28 font-mono"
								/></td
							>
							<td class="px-3 py-1"
								><Input
									bind:value={row.destination}
									list="po-locations"
									placeholder="Order destination"
									aria-label={`Destination, line ${i + 1}`}
									class="w-48"
								/></td
							>
							<td class="px-3 py-1 text-right"
								><ActionLink danger title={`Remove line ${i + 1}`} onclick={() => rows.splice(i, 1)}
									>REMOVE</ActionLink
								></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div
			class="flex items-center justify-end gap-4 border-t border-border bg-muted/40 px-3 py-1.5 font-mono text-xs"
		>
			<span class="tracking-wider text-muted-foreground uppercase">Total</span>
			<span class="font-medium tabular-nums">{total > 0 ? money(total) : '—'}</span>
		</div>
	</Section>

	{#if error}
		<p
			role="alert"
			class="rounded-md border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
		>
			{error}
		</p>
	{/if}
	<div class="flex justify-end gap-2">
		<Button variant="outline" href="/purchases">CANCEL</Button>
		<Button type="submit" disabled={busy}>CREATE PURCHASE</Button>
	</div>
</form>
