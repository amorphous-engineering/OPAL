<script lang="ts">
	// Expense ledger: immutable receive records plus charges (shipping, tax, duty, fee). A draft's
	// charge can be removed. A placed order's charge is struck, stays listed and leaves the total.
	import {
		ActionLink,
		Section,
		EmptyLine,
		Timestamp,
		askReason,
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
	import { money, qtyUnit, unitMoney } from '#lib/format.js';
	import { PURCHASE_CHARGE_KINDS, num, type PurchaseExpense } from './types.js';

	let {
		purchaseId,
		expenses,
		canAdd,
		canRemove = false,
		canStrike = false,
		onchanged
	}: {
		purchaseId: number;
		expenses: PurchaseExpense[];
		canAdd: boolean;
		/** A draft in edit mode: its charges are still pencil. */
		canRemove?: boolean;
		/** A placed order: a charge is struck with a reason. */
		canStrike?: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const KINDS = PURCHASE_CHARGE_KINDS;
	const counted = $derived(expenses.filter((e) => !e.struck));
	const total = $derived(counted.reduce((sum, e) => sum + num(e.totalCost), 0));
	const hasCost = $derived(counted.some((e) => e.totalCost != null));

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
				amount: String(amount).trim(),
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

	async function strike(e: PurchaseExpense) {
		const reason = await askReason({
			title: `Strike ${e.kind} charge`,
			body: `The ${money(e.totalCost)} charge stays listed, struck, and leaves the total.`,
			action: 'STRIKE',
			destructive: true
		});
		if (reason === null) return;
		try {
			await opal.purchasing.orders.strikeCharge({ id: purchaseId, expenseId: e.id, reason });
			await onchanged();
		} catch (err) {
			toastError(err);
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
				<ActionLink onclick={openDialog}>+ ADD CHARGE</ActionLink>
			{:else}
				<span class="text-quiet">—</span>
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
						{#each [['ITEM', 'left'], ['DESCRIPTION', 'left'], ['QTY', 'right'], ['UNIT COST', 'right'], ['TOTAL', 'right'], ['RECORDED', 'left'], ['', 'left']] as [h, a] (h)}
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
						<tr class={['border-b border-border align-top', e.struck && 'text-muted-foreground']}>
							<!-- A part receipt: PN and name. A charge: its kind and notes. -->
							<td class="px-3 py-1.5 whitespace-nowrap">
								{#if e.kind !== 'receipt'}
									<span
										class={[
											'font-mono text-xs tracking-wide uppercase',
											e.struck && 'line-through'
										]}>{e.kind}</span
									>
								{:else}
									<a href={`/parts/${e.partId}`} class="font-mono text-info hover:underline"
										>{e.partInternalPn}</a
									>
								{/if}
							</td>
							<td class="px-3 py-1.5">
								{#if e.kind !== 'receipt'}
									<span class="text-muted-foreground">{e.notes ?? ''}</span>
								{:else}
									{e.partName ?? ''}
								{/if}
							</td>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{e.kind !== 'receipt' ? '' : qtyUnit(e.quantity, e.unitOfMeasure)}</td
							>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{e.kind !== 'receipt' ? '' : unitMoney(e.unitCost)}</td
							>
							<td
								class={[
									'px-3 py-1.5 text-right font-mono tabular-nums',
									e.struck && 'line-through'
								]}>{money(e.totalCost)}</td
							>
							<td class="px-3 py-1.5"><Timestamp value={e.at} /></td>
							<td class="px-3 py-1.5 text-right">
								{#if e.struck}
									<span class="font-mono text-xs"
										>STRUCK {e.struck.byName ?? '—'} · <Timestamp value={e.struck.at} /> · {e.struck
											.reason}</span
									>
								{:else if e.kind !== 'receipt' && canStrike}
									<ActionLink onclick={() => strike(e)}>STRIKE</ActionLink>
								{:else if e.kind !== 'receipt' && canRemove}
									<ActionLink onclick={() => remove(e)}>REMOVE</ActionLink>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr class="bg-muted/40">
						<th
							scope="row"
							colspan="4"
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
				<Label class="label" for="charge-kind">Kind</Label>
				<NativeSelect id="charge-kind" bind:value={kind} class="w-full">
					{#each KINDS as k (k)}<option value={k}>{k.toUpperCase()}</option>{/each}
				</NativeSelect>
			</div>
			<div class="grid grid-cols-1 gap-1.5">
				<Label class="label" for="charge-amount">Amount</Label>
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
				<Label class="label" for="charge-note">Note</Label>
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
