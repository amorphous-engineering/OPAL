<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import {
		ActionLink,
		PageHeader,
		Section,
		DataTable,
		DetailTable,
		DetailRow,
		EmptyLine,
		State,
		Timestamp,
		confirm,
		toastError,
		type Column
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { api } from '#lib/api.js';
	import { money, qty as fmtQty } from '#lib/format.js';
	import EditableRow from '#lib/components/purchasing/EditableRow.svelte';
	import LineDialog from '#lib/components/purchasing/LineDialog.svelte';
	import ReceiveSection from '#lib/components/purchasing/ReceiveSection.svelte';
	import ExpensesSection from '#lib/components/purchasing/ExpensesSection.svelte';
	import AttachmentsSection from '#lib/components/purchasing/AttachmentsSection.svelte';
	import { num, type PurchaseLine, type ReceivedRecord } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const po = $derived(data.purchase);
	const label = $derived(po.reference ?? 'Purchase order');

	const OPEN = ['draft', 'ordered', 'partial', 'on_hold'];
	const editable = $derived(OPEN.includes(po.status));
	const canReceive = $derived(po.status === 'ordered' || po.status === 'partial');
	const anyReceived = $derived(po.lines.some((l) => num(l.qty_received) > 0));
	const lineTotal = (l: PurchaseLine) =>
		l.unit_cost == null ? null : num(l.unit_cost) * num(l.qty_ordered);

	let lineOpen = $state(false);
	let editLine = $state<PurchaseLine | null>(null);

	function addLine() {
		editLine = null;
		lineOpen = true;
	}
	function changeLine(l: PurchaseLine) {
		editLine = l;
		lineOpen = true;
	}

	const refresh = () => invalidateAll();

	async function patch(body: Record<string, unknown>) {
		await api.patch(`/purchases/${po.id}`, body);
		await refresh();
	}

	async function setStatus(
		status: string,
		ask?: { title: string; body: string; action: string; destructive?: boolean }
	) {
		if (ask && !(await confirm(ask))) return;
		try {
			await patch({ status });
		} catch (e) {
			toastError(e);
		}
	}

	async function removeLine(l: PurchaseLine) {
		const ok = await confirm({
			title: `Remove ${l.part_internal_pn ?? l.part_name}`,
			body: 'The line is deleted from this order.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/purchases/${po.id}/lines/${l.id}`);
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	const lineColumns: Column<PurchaseLine>[] = [
		{ key: 'part_internal_pn', label: 'Part', mono: true, class: 'whitespace-nowrap' },
		{ key: 'part_name', label: 'Name' },
		{
			key: 'qty_ordered',
			label: 'Ordered',
			align: 'right',
			mono: true,
			class: 'whitespace-nowrap'
		},
		{ key: 'qty_received', label: 'Received', align: 'right', mono: true },
		{ key: 'unit_cost', label: 'Unit cost', align: 'right', mono: true },
		{ key: 'total', label: 'Total', align: 'right', mono: true },
		{ key: 'destination', label: 'Destination' },
		{ key: 'actions', label: '', align: 'right' }
	];

	const receivedColumns: Column<ReceivedRecord>[] = [
		{ key: 'opal_number', label: 'OPAL', mono: true },
		{ key: 'part_name', label: 'Part' },
		{ key: 'quantity', label: 'Qty', align: 'right', mono: true },
		{ key: 'location', label: 'Location' },
		{ key: 'lot_number', label: 'Lot / serial', mono: true },
		{ key: 'created_at', label: 'Received' }
	];

	const supplierOptions = $derived([
		...(po.supplier_id == null ? [{ value: '', label: po.supplier }] : []),
		...data.suppliers.map((s) => ({ value: String(s.id), label: s.name })),
		...(po.supplier_id != null && !data.suppliers.some((s) => s.id === po.supplier_id)
			? [{ value: String(po.supplier_id), label: po.supplier_name ?? po.supplier }]
			: [])
	]);
</script>

<PageHeader
	title={po.supplier_name ?? po.supplier}
	identifier={po.reference}
	crumbs={[{ label: 'Purchases', href: '/purchases' }, { label }]}
>
	{#snippet state()}
		<State value={po.status} badge={po.status !== 'received'} />
		{#if po.is_overdue}<State value="overdue" tone="error" badge />{/if}
	{/snippet}
	{#snippet actions()}
		{#if po.status === 'draft'}
			<Button
				onclick={() =>
					setStatus('ordered', {
						title: `Place ${label}`,
						body: 'The order is marked as placed with the supplier and receiving opens.',
						action: 'PLACE ORDER'
					})}>PLACE ORDER</Button
			>
		{/if}
		{#if po.status === 'on_hold'}
			<Button onclick={() => setStatus('ordered')}>RESUME</Button>
		{/if}
		{#if po.status === 'ordered' || po.status === 'partial'}
			<Button variant="outline" onclick={() => setStatus('on_hold')}>PUT ON HOLD</Button>
		{/if}
		{#if po.status === 'ordered' && !anyReceived}
			<Button
				variant="outline"
				onclick={() =>
					setStatus('draft', {
						title: `Revert ${label} to draft`,
						body: 'The order is no longer marked as placed.',
						action: 'REVERT'
					})}>REVERT TO DRAFT</Button
			>
		{/if}
		{#if editable}
			<Button
				variant="destructive"
				onclick={() =>
					setStatus('cancelled', {
						title: `Cancel ${label}`,
						body: 'The order is closed and cannot be reopened. Stock already received stays in inventory.',
						action: 'CANCEL ORDER',
						destructive: true
					})}>CANCEL ORDER</Button
			>
		{/if}
	{/snippet}
</PageHeader>

<div class="grid gap-4 p-4 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
	<div class="grid content-start gap-4">
		<Section title="ORDER">
			<DetailTable>
				<EditableRow
					label="Reference"
					mono
					value={po.reference}
					{editable}
					maxlength={64}
					required
					onsave={(v) => patch({ reference: v })}
				/>
				<EditableRow
					label="Supplier"
					type="select"
					value={po.supplier_id != null ? String(po.supplier_id) : ''}
					options={supplierOptions}
					{editable}
					onsave={(v) => patch(v ? { supplier_id: Number(v) } : {})}
				>
					{#snippet display()}
						{#if po.supplier_id != null}
							<a href={`/suppliers/${po.supplier_id}`} class="text-info hover:underline"
								>{po.supplier_name ?? po.supplier}</a
							>
						{:else}
							{po.supplier}
						{/if}
					{/snippet}
				</EditableRow>
				<EditableRow
					label="Supplier ref"
					mono
					value={po.supplier_reference}
					{editable}
					maxlength={100}
					onsave={(v) => patch({ supplier_reference: v })}
				/>
				<EditableRow
					label="Target date"
					type="date"
					mono
					value={po.target_date}
					{editable}
					onsave={(v) => patch({ target_date: v })}
				>
					{#snippet display()}
						{#if po.target_date}
							<span class={po.is_overdue ? 'text-error' : ''}>{po.target_date}</span>
						{:else}
							<span class="text-muted-foreground">—</span>
						{/if}
					{/snippet}
				</EditableRow>
				<EditableRow
					label="Destination"
					value={po.destination}
					{editable}
					list="po-destinations"
					maxlength={255}
					onsave={(v) => patch({ destination: v })}
				/>
				<EditableRow
					label="Notes"
					type="textarea"
					value={po.notes}
					onsave={(v) => patch({ notes: v })}
				/>
				<DetailRow label="Created">
					<Timestamp value={po.created_at} />
					{#if po.created_by_name}<span class="ml-2 text-muted-foreground"
							>{po.created_by_name}</span
						>{/if}
				</DetailRow>
				<DetailRow label="Ordered"><Timestamp value={po.ordered_at} /></DetailRow>
				<DetailRow label="Received">
					<Timestamp value={po.received_at} />
					{#if po.received_by_name}<span class="ml-2 text-muted-foreground"
							>{po.received_by_name}</span
						>{/if}
				</DetailRow>
			</DetailTable>
			<datalist id="po-destinations">
				{#each data.locations as l (l)}<option value={l}></option>{/each}
			</datalist>
		</Section>
	</div>

	<div class="grid min-w-0 content-start gap-4">
		{#if po.lines.length === 0}
			<EmptyLine label="Lines">
				{#snippet action()}
					{#if editable}
						<ActionLink onclick={addLine}>+ ADD LINE</ActionLink>
					{/if}
				{/snippet}
			</EmptyLine>
		{:else}
			<Section title="LINES" count={po.lines.length}>
				{#snippet actions()}
					{#if editable}<ActionLink onclick={addLine}>+ ADD LINE</ActionLink>{/if}
				{/snippet}
				<DataTable rows={po.lines} columns={lineColumns} emptyLabel="Lines" key={(l) => l.id}>
					{#snippet cell(l, col)}
						{#if col.key === 'part_internal_pn'}
							<a href={`/parts/${l.part_id}`} class="text-info hover:underline"
								>{l.part_internal_pn ?? '—'}</a
							>
						{:else if col.key === 'part_name'}
							{l.part_name}
							{#if l.notes}<div class="text-xs text-muted-foreground">{l.notes}</div>{/if}
						{:else if col.key === 'qty_ordered'}
							{fmtQty(l.qty_ordered, l.unit_of_measure)}
						{:else if col.key === 'qty_received'}
							<span
								class={l.is_complete
									? 'text-ok'
									: num(l.qty_received) > 0
										? 'text-warn'
										: 'text-muted-foreground'}>{fmtQty(l.qty_received)}</span
							>
						{:else if col.key === 'unit_cost'}
							{money(l.unit_cost)}
						{:else if col.key === 'total'}
							{money(lineTotal(l))}
						{:else if col.key === 'destination'}
							{#if l.destination}{l.destination}{:else}<span class="text-muted-foreground">—</span
								>{/if}
						{:else if col.key === 'actions'}
							{#if editable}
								<span class="inline-flex gap-3">
									<ActionLink onclick={() => changeLine(l)}>EDIT</ActionLink>
									{#if num(l.qty_received) === 0}
										<ActionLink danger onclick={() => removeLine(l)}>REMOVE</ActionLink>
									{/if}
								</span>
							{/if}
						{/if}
					{/snippet}
				</DataTable>
				<div
					class="flex items-center justify-end gap-4 border-t border-border bg-muted/40 px-3 py-1.5 font-mono text-xs"
				>
					<span class="tracking-wider text-muted-foreground uppercase">Total</span>
					<span class="font-medium tabular-nums">{money(po.total_cost)}</span>
				</div>
			</Section>
		{/if}
	</div>
</div>

<div class="grid gap-4 px-4 pb-4">
	{#if canReceive}
		<ReceiveSection purchase={po} locations={data.locations} onreceived={refresh} />
	{/if}

	{#if data.received.length > 0}
		<Section title="RECEIVED STOCK" count={data.received.length}>
			<DataTable
				rows={data.received}
				columns={receivedColumns}
				emptyLabel="Received stock"
				key={(r) => r.inventory_id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'opal_number'}
						{#if r.opal_number}
							<a href={`/inventory/opal/${r.opal_number}`} class="text-info hover:underline"
								>{r.opal_number}</a
							>
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'part_name'}
						<a href={`/parts/${r.part_id}`} class="font-mono text-info hover:underline"
							>{r.part_internal_pn ?? '—'}</a
						>
						<span class="ml-2">{r.part_name}</span>
					{:else if col.key === 'quantity'}
						{fmtQty(r.quantity)}
					{:else if col.key === 'lot_number'}
						{#if r.lot_number}{r.lot_number}{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'created_at'}
						<Timestamp value={r.created_at} />
					{:else}
						{r.location}
					{/if}
				{/snippet}
			</DataTable>
		</Section>
	{/if}

	<ExpensesSection
		purchaseId={po.id}
		expenses={data.expenses}
		canAdd={po.status !== 'cancelled'}
		onchanged={refresh}
	/>

	<AttachmentsSection purchaseId={po.id} attachments={data.attachments} onchanged={refresh} />
</div>

<LineDialog
	bind:open={lineOpen}
	purchaseId={po.id}
	line={editLine}
	locations={data.locations}
	onsaved={refresh}
/>
