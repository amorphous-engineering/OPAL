<script lang="ts">
	// Receive against open lines: quantity, location, lot. Blank quantity leaves a line outstanding.
	import { Section, confirm, ErrorBanner } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { qty as fmtQty } from '#lib/format.js';
	import { toast } from '#lib/components/opal/index.js';
	import { num, type Purchase } from './types.js';

	let {
		purchase,
		locations = [],
		onreceived
	}: {
		purchase: Purchase;
		locations?: string[];
		onreceived: () => void | Promise<void>;
	} = $props();

	const open = $derived(purchase.lines.filter((l) => num(l.qtyOutstanding) > 0));

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
						.map((l) => `${l.partName}: ${fmtQty(over(l), l.unitOfMeasure)} over`)
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

<Section title="RECEIVE" count={open.length}>
	<form onsubmit={submit}>
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each [['PART', 'left'], ['NAME', 'left'], ['OUTSTANDING', 'right'], ['RECEIVE QTY', 'left'], ['LOCATION', 'left'], ['LOT / SERIAL', 'left']] as [h, a] (h)}
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
					{#each open as l (l.id)}
						{@const row = drafts[l.id]}
						<tr class="border-b border-border align-top">
							<td class="px-3 py-1.5 font-mono"
								><a href={`/parts/${l.partId}`} class="text-info hover:underline"
									>{l.partInternalPn}</a
								></td
							>
							<td class="px-3 py-1.5">{l.partName}</td>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{fmtQty(l.qtyOutstanding, l.unitOfMeasure)}</td
							>
							<td class="px-3 py-1"
								><Input
									type="number"
									step="any"
									min="0"
									bind:value={row.qty}
									aria-label={`Receive quantity for ${l.partName}`}
									class="h-7 w-28 font-mono text-xs"
								/>{#if over(l) > 0}<span class="mt-0.5 block font-mono text-xs text-warn"
										>+{fmtQty(over(l), l.unitOfMeasure)} OVER</span
									>{/if}</td
							>
							<td class="px-3 py-1"
								><Input
									bind:value={row.location}
									list="receive-locations"
									placeholder={fallback(l) ?? 'Location'}
									aria-label={`Location for ${l.partName}`}
									class="h-7 w-44 text-xs"
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
									class="h-7 w-36 font-mono text-xs"
								/></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<datalist id="receive-locations">
			{#each locations as loc (loc)}<option value={loc}></option>{/each}
		</datalist>
		<ErrorBanner message={error} class="mx-3 mt-3" />
		<div class="flex justify-end gap-2 p-3">
			<Button type="button" variant="outline" onclick={fillAll}>FILL ALL</Button>
			<Button type="submit" disabled={busy}>RECEIVE</Button>
		</div>
	</form>
</Section>
