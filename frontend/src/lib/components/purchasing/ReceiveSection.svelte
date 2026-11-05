<script lang="ts">
	// Receive against open lines: quantity, location, lot. Blank quantity leaves a line outstanding.
	// Stock already received shows as rows above the line's input row, with its OPAL number.
	import { Section, confirm, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { qtyUnit, tip } from '#lib/format.js';
	import { toast } from '#lib/components/opal/index.js';
	import { num, type Purchase, type PurchaseReceivedRecord } from './types.js';

	let {
		purchase,
		received,
		receiving,
		locations = [],
		formId = 'po-receive',
		onreceived
	}: {
		purchase: Purchase;
		received: PurchaseReceivedRecord[];
		/** The order accepts receipts now. */
		receiving: boolean;
		locations?: string[];
		/** The header's RECEIVE button submits this form (`form` attribute). */
		formId?: string;
		onreceived: () => void | Promise<void>;
	} = $props();

	const open = $derived(receiving ? purchase.lines.filter((l) => num(l.qtyOutstanding) > 0) : []);
	const byLine = $derived(Map.groupBy(received, (r) => r.purchaseLineId));
	const shown = $derived(purchase.lines.filter((l) => open.includes(l) || byLine.has(l.id)));

	interface Draft {
		qty: string;
		location: string;
		lot: string;
	}
	let drafts = $state<Record<number, Draft>>({});
	let busy = $state(false);
	let error = $state<string | null>(null);

	function d(id: number): Draft {
		return (drafts[id] ??= { qty: '', location: '', lot: '' });
	}

	// Rows exist before the template reads them (the template must not create state).
	$effect.pre(() => {
		for (const l of open) d(l.id);
	});

	function fillAll() {
		const first = open.map((l) => d(l.id).location.trim()).find(Boolean);
		for (const l of open) {
			const row = d(l.id);
			row.qty = String(num(l.qtyOutstanding));
			if (!row.location.trim() && first) row.location = first;
		}
	}

	/** Where a blank location will land, if anywhere. */
	function fallback(l: Purchase['lines'][number]): string | null {
		return l.destination ?? purchase.destination;
	}

	/** Quantity entered beyond what is outstanding (0 when within). */
	function over(l: Purchase['lines'][number]): number {
		const q = Number(drafts[l.id]?.qty);
		return q > 0 ? Math.max(0, q - num(l.qtyOutstanding)) : 0;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (busy) return;
		const lines = [];
		for (const l of open) {
			const row = d(l.id);
			if (!row.qty || Number(row.qty) <= 0) continue;
			if (!row.location.trim() && !fallback(l)) {
				error = `${l.partName}: a location is required to receive this line`;
				return;
			}
			if (l.lotRequired && !row.lot.trim()) {
				error = `${l.partName}: a lot number is required`;
				return;
			}
			lines.push({
				lineId: l.id,
				quantity: String(row.qty).trim(),
				location: row.location.trim() || null,
				lotNumber: row.lot.trim() || null,
				allowOverReceipt: over(l) > 0
			});
		}
		if (lines.length === 0) {
			error = 'Enter a quantity for at least one line';
			return;
		}
		const overLines = open.filter((l) => over(l) > 0);
		if (overLines.length > 0) {
			const ok = await confirm({
				title: 'Receive more than ordered?',
				body:
					overLines
						.map((l) => `${l.partName}: ${qtyUnit(over(l), l.unitOfMeasure)} over`)
						.join('\n') + '\nThe excess is received into stock and costed on this order.',
				action: 'RECEIVE'
			});
			if (!ok) return;
		}
		busy = true;
		try {
			await opal.purchasing.orders.receive({ id: purchase.id, lines });
			drafts = {};
			toast.success(`Received ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`);
			await onreceived();
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : 'Receive failed';
		} finally {
			busy = false;
		}
	}
</script>

<Section title="RECEIVE" count={received.length + open.length}>
	<form id={formId} onsubmit={submit}>
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each [['PN', 'left'], ['OUTSTANDING', 'right'], ['QTY', 'left'], ['LOCATION', 'left'], ['LOT / SERIAL', 'left'], ['OPAL', 'left']] as [h, a] (h)}
							<th
								scope="col"
								class="h-8 px-3 font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
								class:text-right={a === 'right'}
								class:text-left={a === 'left'}>{h}</th
							>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each shown as l (l.id)}
						{#each byLine.get(l.id) ?? [] as r (r.stockId)}
							<tr class="border-b border-border align-top">
								<td class="px-3 py-1.5 font-mono whitespace-nowrap"
									><a href={`/parts/${l.partId}`} title={l.partName} class="text-info hover:underline"
										>{l.partInternalPn}</a
									></td
								>
								<td></td>
								<td class="px-3 py-1.5 font-mono whitespace-nowrap text-ok tabular-nums"
									>{qtyUnit(r.quantity, l.unitOfMeasure)}</td
								>
								<td class="px-3 py-1.5">{r.location}</td>
								<td class="px-3 py-1.5 font-mono"
									>{#if r.serialNumber || r.lotNumber}{r.serialNumber ?? r.lotNumber}{:else}<span
											class="text-muted-foreground">—</span
										>{/if}</td
								>
								<td class="px-3 py-1.5 font-mono whitespace-nowrap"
									><a
										href={`/inventory/opal/${r.opalNumber}`}
										title={`Received ${tip(r.receivedAt)}`}
										class="text-info hover:underline">{r.opalNumber}</a
									></td
								>
							</tr>
						{/each}
						{@const row = open.includes(l) ? drafts[l.id] : undefined}
						{#if row}
							<tr class="border-b border-border align-top">
								<td class="px-3 py-1.5 font-mono"
									><a href={`/parts/${l.partId}`} title={l.partName} class="text-info hover:underline"
										>{l.partInternalPn}</a
									></td
								>
								<td class="px-3 py-1.5 text-right font-mono tabular-nums"
									>{qtyUnit(l.qtyOutstanding, l.unitOfMeasure)}</td
								>
								<td class="px-3 py-1">
									<div class="flex items-center gap-1.5">
										<Input
											type="number"
											step="any"
											min="0"
											bind:value={row.qty}
											aria-label={`Receive quantity for ${l.partName}`}
											class="h-7 w-24 font-mono text-xs"
										/>
										<span class="font-mono text-xs text-muted-foreground">{l.unitOfMeasure}</span>
									</div>
									{#if over(l) > 0}<span class="mt-0.5 block font-mono text-xs text-warn"
											>+{qtyUnit(over(l), l.unitOfMeasure)} OVER</span
										>{/if}
								</td>
								<td class="px-3 py-1"
									><Input
										bind:value={row.location}
										list="receive-locations"
										placeholder={fallback(l) ?? 'Location'}
										aria-label={`Location for ${l.partName}`}
										class="h-7 w-32 text-xs"
									/></td
								>
								<td class="px-3 py-1"
									><Input
										bind:value={row.lot}
										placeholder={l.lotRequired
											? 'Required'
											: l.trackingType === 'serialized'
												? l.autoSerial
													? 'Auto serial'
													: 'Serial'
												: 'Lot'}
										aria-label={`Lot for ${l.partName}`}
										class="h-7 w-32 font-mono text-xs"
									/></td
								>
								<td></td>
							</tr>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
		<datalist id="receive-locations">
			{#each locations as loc (loc)}<option value={loc}></option>{/each}
		</datalist>
		{#if open.length > 0}
			<ErrorBanner message={error} class="mx-3 mt-3" />
			<div class="flex justify-end gap-2 p-3">
				<Button type="button" variant="outline" onclick={fillAll}>FILL ALL</Button>
			</div>
		{/if}
	</form>
</Section>
