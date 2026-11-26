<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		BankKey,
		Field,
		FormKeys,
		NextNumber,
		KeyBank,
		needs,
		PageHeader,
		Section
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { money } from '#lib/format.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import type { PickedPart } from '#lib/components/parts/types.js';
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

	// Seeded once from the invoking context (supplier or part link). Blank until chosen; OTHER
	// takes a typed name for a supplier not in the directory.
	/* svelte-ignore state_referenced_locally */
	let supplierId = $state(
		data.supplierId && data.suppliers.some((s) => String(s.id) === data.supplierId)
			? data.supplierId
			: ''
	);
	let otherName = $state('');
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

	const other = $derived(supplierId === 'other');
	const missing = $derived(needs({ supplier: other ? otherName.trim() : supplierId }));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		const lines = rows
			.filter((r) => r.part)
			.map((r) => ({
				partId: r.part!.id,
				qtyOrdered: String(r.qty).trim(),
				unitCost: String(r.cost).trim() === '' ? null : String(r.cost).trim(),
				destination: r.destination.trim() || null
			}));
		if (rows.some((r) => r.part && !(Number(r.qty) > 0))) {
			error = 'Every line needs a quantity above zero';
			return;
		}
		busy = true;
		try {
			const po = await opal.purchasing.orders.create({
				supplierId: other ? null : Number(supplierId),
				supplierName: other ? otherName.trim() : null,
				supplierReference: supplierRef.trim() || null,
				targetDate: targetDate || null,
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

<form class="grid grid-cols-1 gap-3 p-4" onsubmit={submit}>
	<div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
		<Section title="Order">
			<div class="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-1">
				<NextNumber kind="purchase" />
				<Field label="Supplier" for="po-supplier" required>
					<NativeSelect id="po-supplier" bind:value={supplierId} class="w-full">
						<option value="">—</option>
						{#each data.suppliers as s (s.id)}
							<option value={String(s.id)}>{s.name}{s.code ? ` (${s.code})` : ''}</option>
						{/each}
						<option value="other">Other</option>
					</NativeSelect>
				</Field>
				{#if other}
					<Field label="Supplier name" for="po-supplier-name" required>
						<Input id="po-supplier-name" bind:value={otherName} maxlength={255} />
					</Field>
				{/if}
				<Field label="Supplier reference" for="po-supplier-ref">
					<Input id="po-supplier-ref" bind:value={supplierRef} maxlength={100} class="font-mono" />
				</Field>
				<Field label="Target date" for="po-target">
					<Input id="po-target" type="date" bind:value={targetDate} class="font-mono" />
				</Field>
				<Field label="Destination" for="po-dest">
					<Input id="po-dest" bind:value={destination} list="po-locations" maxlength={255} />
					<datalist id="po-locations">
						{#each data.locations as l (l)}<option value={l}></option>{/each}
					</datalist>
				</Field>
				<Field label="Notes" for="po-notes" class="md:col-span-2 xl:col-span-1">
					<Textarea id="po-notes" bind:value={notes} rows={2} />
				</Field>
			</div>
		</Section>

		<Section title="Lines" class="self-start">
			{#snippet actions()}
				<Button size="sm" variant="outline" onclick={() => rows.push(blank())}>+ LINE</Button>
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
							<tr class="group/row border-b border-border align-top">
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
									><!-- Blank takes the order's destination, so that is what it shows. --><Input
										bind:value={row.destination}
										list="po-locations"
										placeholder={destination}
										aria-label={`Destination, line ${i + 1}`}
										class="w-48"
									/></td
								>
								<td class="px-3 py-1 text-right">
									<KeyBank quiet label={`Line ${i + 1}`}>
										<BankKey onclick={() => rows.splice(i, 1)}>REMOVE</BankKey>
									</KeyBank>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if total > 0}
				<div
					class="flex items-center justify-end gap-4 border-t border-border bg-muted/40 px-3 py-1.5 font-mono text-xs"
				>
					<span class="tracking-wider text-muted-foreground uppercase">Total</span>
					<span class="font-medium tabular-nums">{money(total)}</span>
				</div>
			{/if}
		</Section>
	</div>

	<FormKeys submit="CREATE" cancel="/purchases" {missing} {busy} {error} />
</form>
