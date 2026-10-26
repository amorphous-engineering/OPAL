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
	import { opal } from '#lib/api.js';
	import { money, qty as fmtQty, unitMoney } from '#lib/format.js';
	import EditableRow from '#lib/components/purchasing/EditableRow.svelte';
	import LineDialog from '#lib/components/purchasing/LineDialog.svelte';
	import ReceiveSection from '#lib/components/purchasing/ReceiveSection.svelte';
	import ExpensesSection from '#lib/components/purchasing/ExpensesSection.svelte';
	import AttachmentsSection from '#lib/components/purchasing/AttachmentsSection.svelte';
	import { num, type PurchaseLine, type PurchaseStatus } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const po = $derived(data.purchase);
	const label = $derived(po.reference ?? 'Purchase order');

	const OPEN = ['draft', 'ordered', 'partial', 'on_hold'];
	const editable = $derived(OPEN.includes(po.status));
	const canReceive = $derived(po.status === 'ordered' || po.status === 'partial');
	const anyReceived = $derived(po.lines.some((l) => num(l.qtyReceived) > 0));
	const lineTotal = (l: PurchaseLine) =>
		l.unitCost == null ? null : num(l.unitCost) * num(l.qtyOrdered);

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

	async function patch(body: Omit<Parameters<typeof opal.purchasing.orders.update>[0], 'id'>) {
		await opal.purchasing.orders.update({ id: po.id, ...body });
		await refresh();
	}

	async function setStatus(
		status: PurchaseStatus,
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
			title: `Remove ${l.partInternalPn ?? l.partName}`,
			body: 'The line is deleted from this order.',
			action: 'REMOVE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.purchasing.orders.removeLine({ id: po.id, lineId: l.id });
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	const lineColumns: Column<PurchaseLine>[] = [
		{ key: 'partInternalPn', label: 'PN', mono: true, class: 'whitespace-nowrap' },
		{ key: 'partName', label: 'Name' },
		{
			key: 'qtyOrdered',
			label: 'Ordered',
			align: 'right',
			mono: true,
			class: 'whitespace-nowrap'
		},
		{ key: 'qtyReceived', label: 'Received', align: 'right', mono: true },
		{ key: 'unitCost', label: 'Unit cost', align: 'right', mono: true },
		{ key: 'total', label: 'Total', align: 'right', mono: true },
		{ key: 'destination', label: 'Destination' },
		{ key: 'actions', label: '', align: 'right' }
	];

	type Received = (typeof data.received)[number];
	const receivedColumns: Column<Received>[] = [
		{ key: 'opalNumber', label: 'OPAL', mono: true },
		{ key: 'partInternalPn', label: 'PN', mono: true, class: 'whitespace-nowrap' },
		{ key: 'partName', label: 'Name' },
		{ key: 'quantity', label: 'Qty', align: 'right', mono: true },
		{ key: 'location', label: 'Location' },
		{ key: 'lotNumber', label: 'Lot / serial', mono: true },
		{ key: 'receivedAt', label: 'Received' }
	];

	const supplierOptions = $derived([
		...(po.supplierId == null ? [{ value: '', label: po.supplierName }] : []),
		...data.suppliers.map((s) => ({ value: String(s.id), label: s.name })),
		...(po.supplierId != null && !data.suppliers.some((s) => s.id === po.supplierId)
			? [{ value: String(po.supplierId), label: po.supplierName }]
			: [])
	]);
</script>

<PageHeader
	title={po.supplierName}
	identifier={po.reference}
	crumbs={[{ label: 'Purchases', href: '/purchases' }, { label }]}
>
	{#snippet state()}
		<State value={po.status} badge={po.status !== 'received'} />
		{#if po.isOverdue}<State value="overdue" tone="error" badge />{/if}
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

<div class="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
	<div class="grid grid-cols-1 content-start gap-4">
		<Section title="ORDER">
			<DetailTable>
				<DetailRow label="Reference" value={po.reference} mono />
				<EditableRow
					label="Supplier"
					type="select"
					value={po.supplierId != null ? String(po.supplierId) : ''}
					options={supplierOptions}
					{editable}
					onsave={(v) => patch(v ? { supplierId: Number(v) } : {})}
				>
					{#snippet display()}
						{#if po.supplierId != null}
							<a href={`/suppliers/${po.supplierId}`} class="text-info hover:underline"
								>{po.supplierName}</a
							>
						{:else}
							{po.supplierName}
						{/if}
					{/snippet}
				</EditableRow>
				<EditableRow
					label="Supplier ref"
					mono
					value={po.supplierReference}
					{editable}
					maxlength={100}
					onsave={(v) => patch({ supplierReference: v })}
				/>
				<EditableRow
					label="Target date"
					type="date"
					mono
					value={po.targetDate}
					{editable}
					onsave={(v) => patch({ targetDate: v })}
				>
					{#snippet display()}
						{#if po.targetDate}
							<span class={po.isOverdue ? 'text-error' : ''}>{po.targetDate}</span>
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
					<Timestamp value={po.createdAt} />
					{#if po.createdByName}<span class="ml-2 text-muted-foreground">{po.createdByName}</span
						>{/if}
				</DetailRow>
				<DetailRow label="Ordered"><Timestamp value={po.orderedAt} /></DetailRow>
				<DetailRow label="Received">
					<Timestamp value={po.receivedAt} />
					{#if po.receivedByName}<span class="ml-2 text-muted-foreground">{po.receivedByName}</span
						>{/if}
				</DetailRow>
			</DetailTable>
			<datalist id="po-destinations">
				{#each data.locations as l (l)}<option value={l}></option>{/each}
			</datalist>
		</Section>
	</div>

	<div class="grid min-w-0 grid-cols-1 content-start gap-4">
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
						{#if col.key === 'partInternalPn'}
							<a href={`/parts/${l.partId}`} class="text-info hover:underline"
								>{l.partInternalPn ?? '—'}</a
							>
						{:else if col.key === 'partName'}
							{l.partName}
							{#if l.notes}<div class="text-xs text-muted-foreground">{l.notes}</div>{/if}
						{:else if col.key === 'qtyOrdered'}
							{fmtQty(l.qtyOrdered, l.unitOfMeasure)}
						{:else if col.key === 'qtyReceived'}
							<span
								class={l.isComplete
									? 'text-ok'
									: num(l.qtyReceived) > 0
										? 'text-warn'
										: 'text-muted-foreground'}>{fmtQty(l.qtyReceived)}</span
							>
						{:else if col.key === 'unitCost'}
							{unitMoney(l.unitCost)}
						{:else if col.key === 'total'}
							{money(lineTotal(l))}
						{:else if col.key === 'destination'}
							{#if l.destination}{l.destination}{:else}<span class="text-muted-foreground">—</span
								>{/if}
						{:else if col.key === 'actions'}
							{#if editable}
								<span class="inline-flex gap-3">
									<ActionLink onclick={() => changeLine(l)}>EDIT</ActionLink>
									{#if num(l.qtyReceived) === 0}
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
					<span class="font-medium tabular-nums">{money(po.totalCost)}</span>
				</div>
			</Section>
		{/if}
	</div>
</div>

<div class="grid grid-cols-1 gap-4 px-4 pb-4">
	{#if canReceive}
		<ReceiveSection purchase={po} locations={data.locations} onreceived={refresh} />
	{/if}

	{#if data.received.length > 0}
		<Section title="RECEIVED STOCK" count={data.received.length}>
			<DataTable
				rows={data.received}
				columns={receivedColumns}
				emptyLabel="Received stock"
				key={(r) => r.stockId}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'opalNumber'}
						{#if r.opalNumber}
							<a href={`/inventory/opal/${r.opalNumber}`} class="text-info hover:underline"
								>{r.opalNumber}</a
							>
						{:else}<span class="text-muted-foreground">—</span>{/if}
					{:else if col.key === 'partInternalPn'}
						<a href={`/parts/${r.partId}`} class="text-info hover:underline">{r.partInternalPn}</a>
					{:else if col.key === 'partName'}
						{r.partName}
					{:else if col.key === 'quantity'}
						{fmtQty(r.quantity)}
					{:else if col.key === 'lotNumber'}
						{#if r.lotNumber || r.serialNumber}{r.serialNumber ?? r.lotNumber}{:else}<span
								class="text-muted-foreground">—</span
							>{/if}
					{:else if col.key === 'receivedAt'}
						<Timestamp value={r.receivedAt} />
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
