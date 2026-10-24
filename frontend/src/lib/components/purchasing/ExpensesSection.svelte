<script lang="ts">
	// Expense ledger: immutable receive records plus charges (shipping, tax, duty, fee).
	import {
		ActionLink,
		Section,
		EmptyLine,
		Timestamp,
		confirm,
		toastError,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { ApiError, opal } from '#lib/api.js';
	import { money, qty as fmtQty } from '#lib/format.js';
	import { PURCHASE_CHARGE_KINDS, num, type PurchaseExpense } from './types.js';

	let {
		purchaseId,
		expenses,
		canAdd,
		onchanged
	}: {
		purchaseId: number;
		expenses: PurchaseExpense[];
		canAdd: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const KINDS = PURCHASE_CHARGE_KINDS;
	const total = $derived(expenses.reduce((sum, e) => sum + num(e.totalCost), 0));
	const hasCost = $derived(expenses.some((e) => e.totalCost != null));

	let open = $state(false);
	let kind = $state<(typeof PURCHASE_CHARGE_KINDS)[number]>('shipping');
	let amount = $state('');
	let note = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	function openDialog() {
		kind = 'shipping';
		amount = '';
		note = '';
		error = null;
		open = true;
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await opal.purchasing.orders.addCharge({
				id: purchaseId,
				kind,
				amount: amount.trim(),
				note: note.trim() || null
			});
			open = false;
			await onchanged();
		} catch (err) {
			error =
				err instanceof ApiError || err instanceof Error ? err.message : 'Failed to add charge';
		} finally {
			busy = false;
		}
	}

	async function remove(e: PurchaseExpense) {
		const ok = await confirm({
			title: `Remove ${e.kind} charge`,
			body: `The ${money(e.totalCost)} charge is deleted from this order's expenses.`,
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.purchasing.orders.removeCharge({ id: purchaseId, expenseId: e.id });
			await onchanged();
		} catch (err) {
			toastError(err);
		}
	}
</script>

{#if expenses.length === 0}
	<EmptyLine label="Expenses">
		{#snippet action()}
			{#if canAdd}
				<button type="button" class="font-medium text-info hover:underline" onclick={openDialog}
					>+ ADD CHARGE</button
				>
			{:else}
				<span class="text-muted-foreground">—</span>
			{/if}
		{/snippet}
	</EmptyLine>
{:else}
	<Section title="EXPENSES" count={expenses.length}>
		{#snippet actions()}
			{#if canAdd}<ActionLink onclick={openDialog}>+ ADD CHARGE</ActionLink>{/if}
		{/snippet}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each [['ITEM', 'left'], ['QTY', 'right'], ['UNIT COST', 'right'], ['TOTAL', 'right'], ['RECORDED', 'left'], ['', 'left']] as [h, a] (h)}
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
					{#each expenses as e (e.id)}
						<tr class="border-b border-border align-top">
							<td class="px-3 py-1.5">
								{#if e.kind !== 'receipt'}
									<span class="font-mono text-xs tracking-wide uppercase">{e.kind}</span>
									{#if e.notes}<span class="ml-2 text-muted-foreground">{e.notes}</span>{/if}
								{:else}
									<a href={`/parts/${e.partId}`} class="font-mono text-info hover:underline"
										>{e.partInternalPn}</a
									>
									<span class="ml-2">{e.partName ?? ''}</span>
								{/if}
							</td>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{e.kind !== 'receipt' ? '' : fmtQty(e.quantity)}</td
							>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{e.kind !== 'receipt' ? '' : money(e.unitCost)}</td
							>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums">{money(e.totalCost)}</td>
							<td class="px-3 py-1.5"><Timestamp value={e.at} /></td>
							<td class="px-3 py-1.5 text-right">
								{#if e.kind !== 'receipt'}
									<ActionLink danger onclick={() => remove(e)}>REMOVE</ActionLink>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr class="bg-muted/40">
						<th
							scope="row"
							colspan="3"
							class="px-3 py-1.5 text-left font-mono text-xs tracking-wider text-muted-foreground uppercase"
							>TOTAL</th
						>
						<td class="px-3 py-1.5 text-right font-mono font-medium tabular-nums"
							>{hasCost ? money(total) : '—'}</td
						>
						<td colspan="2"></td>
					</tr>
				</tfoot>
			</table>
		</div>
	</Section>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header><Dialog.Title>Add charge</Dialog.Title></Dialog.Header>
		<form class="grid grid-cols-1 gap-3" onsubmit={add}>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="charge-kind">Kind</Label>
				<NativeSelect id="charge-kind" bind:value={kind} class="w-full">
					{#each KINDS as k (k)}<option value={k}>{k.toUpperCase()}</option>{/each}
				</NativeSelect>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="charge-amount">Amount</Label>
				<Input
					id="charge-amount"
					type="number"
					step="0.01"
					min="0"
					bind:value={amount}
					required
					class="font-mono"
				/>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label for="charge-note">Note</Label>
				<Input id="charge-note" bind:value={note} maxlength={500} />
			</div>
			<ErrorBanner message={error} />
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>ADD CHARGE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
