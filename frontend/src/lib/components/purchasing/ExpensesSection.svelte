<script lang="ts">
	// Expense ledger: immutable receive records plus charges (shipping, tax, duty, fee).
	import {
		Section,
		EmptyLine,
		Timestamp,
		confirm,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { money, qty as fmtQty } from '#lib/format.js';
	import { num, type Expense } from './types.js';

	let {
		purchaseId,
		expenses,
		canAdd,
		onchanged
	}: {
		purchaseId: number;
		expenses: Expense[];
		canAdd: boolean;
		onchanged: () => void | Promise<void>;
	} = $props();

	const KINDS = ['shipping', 'tax', 'duty', 'fee', 'other'];
	const total = $derived(expenses.reduce((sum, e) => sum + num(e.total_cost), 0));
	const hasCost = $derived(expenses.some((e) => e.total_cost != null));

	let open = $state(false);
	let kind = $state('shipping');
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

	function chargeNote(e: Expense): string {
		const i = (e.notes ?? '').indexOf(':');
		return i >= 0 ? (e.notes ?? '').slice(i + 1).trim() : '';
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await api.post(`/purchases/${purchaseId}/expenses`, {
				kind,
				amount: Number(amount),
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

	async function remove(e: Expense) {
		const ok = await confirm({
			title: `Remove ${e.charge_kind} charge`,
			body: `The ${money(e.total_cost)} charge is deleted from this order's expenses.`,
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/purchases/${purchaseId}/expenses/${e.id}`);
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
			{#if canAdd}<Button size="xs" variant="ghost" onclick={openDialog}>+ ADD CHARGE</Button>{/if}
		{/snippet}
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-border bg-muted/60">
						{#each [['ITEM', 'left'], ['QTY', 'right'], ['UNIT COST', 'right'], ['TOTAL', 'right'], ['TIER', 'left'], ['RECORDED', 'left'], ['', 'left']] as [h, a] (h)}
							<th
								scope="col"
								class="h-8 px-3 font-mono text-[11px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase"
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
								{#if e.charge_kind}
									<span class="font-mono text-xs tracking-wide uppercase">{e.charge_kind}</span>
									{#if chargeNote(e)}<span class="ml-2 text-muted-foreground">{chargeNote(e)}</span
										>{/if}
								{:else}
									<a href={`/parts/${e.part_id}`} class="font-mono text-info hover:underline"
										>{e.part_internal_pn ?? '—'}</a
									>
									<span class="ml-2">{e.part_name ?? ''}</span>
								{/if}
							</td>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{e.charge_kind ? '' : fmtQty(e.quantity)}</td
							>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums"
								>{e.charge_kind ? '' : money(e.unit_cost)}</td
							>
							<td class="px-3 py-1.5 text-right font-mono tabular-nums">{money(e.total_cost)}</td>
							<td class="px-3 py-1.5 font-mono"
								>{#if e.tier != null}T{e.tier}{:else}<span class="text-muted-foreground">—</span
									>{/if}</td
							>
							<td class="px-3 py-1.5"><Timestamp value={e.received_at} /></td>
							<td class="px-3 py-1.5 text-right">
								{#if e.charge_kind}
									<button
										type="button"
										class="font-mono text-[11px] tracking-wider text-muted-foreground uppercase hover:text-error"
										onclick={() => remove(e)}>Remove</button
									>
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
							class="px-3 py-1.5 text-left font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
							>TOTAL</th
						>
						<td class="px-3 py-1.5 text-right font-mono font-medium tabular-nums"
							>{hasCost ? money(total) : '—'}</td
						>
						<td colspan="3"></td>
					</tr>
				</tfoot>
			</table>
		</div>
	</Section>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header><Dialog.Title>Add charge</Dialog.Title></Dialog.Header>
		<form class="grid gap-3" onsubmit={add}>
			<div class="grid gap-1.5">
				<Label for="charge-kind">Kind</Label>
				<NativeSelect id="charge-kind" bind:value={kind} class="w-full">
					{#each KINDS as k (k)}<option value={k}>{k.toUpperCase()}</option>{/each}
				</NativeSelect>
			</div>
			<div class="grid gap-1.5">
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
			<div class="grid gap-1.5">
				<Label for="charge-note">Note</Label>
				<Input id="charge-note" bind:value={note} maxlength={500} />
			</div>
			{#if error}
				<p
					role="alert"
					class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
				>
					{error}
				</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>CANCEL</Button>
				<Button type="submit" disabled={busy}>ADD CHARGE</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
