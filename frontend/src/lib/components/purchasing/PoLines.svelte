<script lang="ts">
	// The lines of an order. Placed lines are pen: a corrected value shows the old one struck
	// through beside the new one, and a note under the line says who, when and why. Row controls
	// exist only in edit mode: EDIT and REMOVE on a draft, AMEND and CANCEL LINE on a placed order.
	import { ActionLink, Section, Timestamp } from '#lib/components/opal/index.js';
	import { money, qtyUnit, unitMoney } from '#lib/format.js';
	import {
		changeValue,
		fieldLabel,
		num,
		type Purchase,
		type PurchaseChange,
		type PurchaseLine
	} from './types.js';

	let {
		purchase,
		editing,
		onadd,
		onedit,
		onremove,
		onamend,
		oncancel
	}: {
		purchase: Purchase;
		editing: boolean;
		/** Draft only: the header "+ ADD LINE". Placed orders add from MORE. */
		onadd?: () => void;
		onedit?: (l: PurchaseLine) => void;
		onremove?: (l: PurchaseLine) => void;
		onamend?: (l: PurchaseLine) => void;
		oncancel?: (l: PurchaseLine) => void;
	} = $props();

	const draft = $derived(purchase.status === 'draft');
	const placedOpen = $derived(purchase.status === 'ordered' || purchase.status === 'partial');
	const anyCancelled = $derived(purchase.lines.some((l) => num(l.qtyCancelled) > 0));
	const byLine = $derived(
		Map.groupBy(
			purchase.changes.filter((c) => c.scope === 'line' && c.lineId !== null),
			(c) => c.lineId as number
		)
	);

	/** Values the field held before, oldest first, without repeats. */
	function before(l: PurchaseLine, field: string): PurchaseChange[] {
		return (byLine.get(l.id) ?? []).filter((c) => c.field === field);
	}

	const lineTotal = (l: PurchaseLine) =>
		l.unitCost == null ? null : num(l.unitCost) * (num(l.qtyOrdered) - num(l.qtyCancelled));
	/** Everything on it was struck and nothing arrived. */
	const struck = (l: PurchaseLine) =>
		num(l.qtyCancelled) > 0 && num(l.qtyReceived) === 0 && l.isComplete;
	const showActions = $derived(editing && (draft || placedOpen));
	const cols = $derived(7 + (anyCancelled ? 1 : 0) + (showActions ? 1 : 0));
</script>

{#snippet was(l: PurchaseLine, field: string)}
	{#each before(l, field) as c (c.at + c.field)}
		<s class="mr-1.5 text-muted-foreground">{changeValue(c, c.old)}</s>
	{/each}
{/snippet}

<Section title="LINES" count={purchase.lines.length}>
	{#snippet actions()}
		{#if editing && draft && onadd}<ActionLink onclick={onadd}>+ ADD LINE</ActionLink>{/if}
	{/snippet}
	{#if purchase.lines.length === 0}
		<div class="px-3 py-2 text-sm text-muted-foreground">No lines.</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each [['PN', 'left'], ['Name', 'left'], ['Ordered', 'right'], ['Received', 'right']] as [h, a] (h)}
							<th
								scope="col"
								class="h-8 px-3 font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
								class:text-right={a === 'right'}
								class:text-left={a === 'left'}>{h}</th
							>
						{/each}
						{#if anyCancelled}
							<th
								scope="col"
								class="h-8 px-3 text-right font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase"
								>Cancelled</th
							>
						{/if}
						{#each [['Unit cost', 'right'], ['Total', 'right'], ['Destination', 'left']] as [h, a] (h)}
							<th
								scope="col"
								class="h-8 px-3 font-mono text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
								class:text-right={a === 'right'}
								class:text-left={a === 'left'}>{h}</th
							>
						{/each}
						{#if showActions}<th scope="col" class="h-8 px-3"></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each purchase.lines as l (l.id)}
						{@const notes = byLine.get(l.id) ?? []}
						<tr
							class="align-top {notes.length ? '' : 'border-b border-border'} {struck(l)
								? 'text-muted-foreground line-through'
								: ''}"
						>
							<td class="px-3 py-1.5 font-mono whitespace-nowrap">
								<a href={`/parts/${l.partId}`} class="text-info hover:underline"
									>{l.partInternalPn}</a
								>
							</td>
							<td class="min-w-40 px-3 py-1.5">
								{l.partName}
								{#if l.notes}<div class="text-xs text-muted-foreground">{l.notes}</div>{/if}
							</td>
							<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums">
								{@render was(l, 'qtyOrdered')}{qtyUnit(l.qtyOrdered, l.unitOfMeasure)}
							</td>
							<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums"
								>{qtyUnit(l.qtyReceived, l.unitOfMeasure)}</td
							>
							{#if anyCancelled}
								<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums">
									{#if num(l.qtyCancelled) > 0}{qtyUnit(
											l.qtyCancelled,
											l.unitOfMeasure
										)}{:else}<span class="text-muted-foreground">—</span>{/if}
								</td>
							{/if}
							<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums">
								{@render was(l, 'unitCost')}{unitMoney(l.unitCost)}
							</td>
							<td class="px-3 py-1.5 text-right font-mono whitespace-nowrap tabular-nums"
								>{money(lineTotal(l))}</td
							>
							<td class="px-3 py-1.5">
								{@render was(l, 'destination')}{#if l.destination}{l.destination}{:else}<span
										class="text-muted-foreground">—</span
									>{/if}
							</td>
							{#if showActions}
								<td class="px-3 py-1.5 text-right">
									<span class="inline-flex gap-3 no-underline">
										{#if draft}
											<ActionLink onclick={() => onedit?.(l)}>EDIT</ActionLink>
											<ActionLink onclick={() => onremove?.(l)}>REMOVE</ActionLink>
										{:else}
											<ActionLink onclick={() => onamend?.(l)}>AMEND</ActionLink>
											{#if num(l.qtyOutstanding) > 0}
												<ActionLink onclick={() => oncancel?.(l)}>CANCEL LINE</ActionLink>
											{/if}
										{/if}
									</span>
								</td>
							{/if}
						</tr>
						{#each notes as c, i (c.at + c.field + i)}
							<tr class={i === notes.length - 1 ? 'border-b border-border' : ''}>
								<td></td>
								<td colspan={cols - 1} class="px-3 pb-1 font-mono text-xs text-muted-foreground">
									{fieldLabel(c.field).toUpperCase()}
									{#if c.field !== 'line'}
										<s>{changeValue(c, c.old)}</s> → {changeValue(c, c.new)}
									{:else}
										{changeValue(c, c.new)}
									{/if}
									· {c.userName ?? '—'} · <Timestamp value={c.at} />
									{#if c.reason}· {c.reason}{/if}
								</td>
							</tr>
						{/each}
					{/each}
				</tbody>
				<tfoot>
					<tr class="bg-muted/40">
						<th
							scope="row"
							colspan={5 + (anyCancelled ? 1 : 0)}
							class="px-3 py-1.5 text-right font-mono text-xs font-medium tracking-wider text-muted-foreground uppercase"
							>Total</th
						>
						<td class="px-3 py-1.5 text-right font-mono font-medium tabular-nums"
							>{money(purchase.totalCost)}</td
						>
						<td colspan={1 + (showActions ? 1 : 0)}></td>
					</tr>
				</tfoot>
			</table>
		</div>
	{/if}
</Section>
