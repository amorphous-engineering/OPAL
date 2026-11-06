<script lang="ts">
	import { cn } from '#lib/utils.js';
	// A purchase order is a form (RECORDS.md). Draft is pencil. Placing is the commit moment, and
	// after it the page opens for reading: the one blank it waits on is the receive rows. EDIT
	// reveals what is still pencil, MORE holds the exceptional acts, and a correction keeps the
	// old value on the page.
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import {
		DetailRow,
		DetailTable,
		EditToggle,
		MoreMenu,
		PageHeader,
		Section,
		State,
		Timestamp,
		askReason,
		confirm,
		isEditing,
		toastError,
		type MoreItem
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { opal } from '#lib/api.js';
	import { qtyUnit } from '#lib/format.js';
	import AmendLineDialog from '#lib/components/purchasing/AmendLineDialog.svelte';
	import AttachmentsSection from '#lib/components/purchasing/AttachmentsSection.svelte';
	import EditableRow from '#lib/components/purchasing/EditableRow.svelte';
	import ExpensesSection from '#lib/components/purchasing/ExpensesSection.svelte';
	import LineDialog from '#lib/components/purchasing/LineDialog.svelte';
	import PoHistory from '#lib/components/purchasing/PoHistory.svelte';
	import PoLines from '#lib/components/purchasing/PoLines.svelte';
	import ReceiveSection from '#lib/components/purchasing/ReceiveSection.svelte';
	import { num, type PurchaseLine } from '#lib/components/purchasing/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const po = $derived(data.purchase);
	const label = $derived(po.reference ?? 'Purchase order');

	const draft = $derived(po.status === 'draft');
	const live = $derived(po.status === 'ordered' || po.status === 'partial');
	const held = $derived(po.status === 'on_hold');
	const closed = $derived(
		po.status === 'received' || po.status === 'cancelled' || po.status === 'closed_short'
	);
	const anyReceived = $derived(po.lines.some((l) => num(l.qtyReceived) > 0));
	/** Something is still pencil: a draft, or the header and lines of an order waiting for goods. */
	const editable = $derived(draft || live);
	const editing = $derived(editable && isEditing(page.url));
	/** Notes are a pen move in every state: a finished order still takes one. */
	const editingNotes = $derived(isEditing(page.url));
	const canReceive = $derived(live);

	/** Who placed it, from the first status change. */
	const placed = $derived(
		po.changes.find((c) => c.scope === 'order' && c.field === 'status' && c.new === 'ordered')
	);
	/** Who closed it and why, for a cancelled or closed short order. */
	const closing = $derived(
		[...po.changes]
			.reverse()
			.find(
				(c) =>
					c.scope === 'order' &&
					c.field === 'status' &&
					(c.new === 'cancelled' || c.new === 'closed_short')
			)
	);

	let lineOpen = $state(false);
	let editLine = $state<PurchaseLine | null>(null);
	let amendOpen = $state(false);
	let amendTarget = $state<PurchaseLine | null>(null);

	const refresh = () => invalidateAll();

	function addLine() {
		editLine = null;
		lineOpen = true;
	}
	function changeLine(l: PurchaseLine) {
		editLine = l;
		lineOpen = true;
	}
	function amend(l: PurchaseLine) {
		amendTarget = l;
		amendOpen = true;
	}

	async function run(fn: () => Promise<unknown>) {
		try {
			await fn();
			await refresh();
		} catch (e) {
			toastError(e);
		}
	}

	const patch = async (body: Omit<Parameters<typeof opal.purchasing.orders.update>[0], 'id'>) => {
		await opal.purchasing.orders.update({ id: po.id, ...body });
		await refresh();
	};

	async function place() {
		const ok = await confirm({
			title: `Place ${label}`,
			body: 'Lines and supplier stop being editable.',
			action: 'PLACE ORDER'
		});
		if (!ok) return;
		await run(() => opal.purchasing.orders.place({ id: po.id }));
		await goto(page.url.pathname, { replaceState: true, invalidateAll: true });
	}

	async function removeLine(l: PurchaseLine) {
		const ok = await confirm({
			title: `Remove ${l.partInternalPn}`,
			body: 'The line is deleted from this draft.',
			action: 'REMOVE',
			destructive: true
		});
		if (ok) await run(() => opal.purchasing.orders.removeLine({ id: po.id, lineId: l.id }));
	}

	async function cancelLine(l: PurchaseLine) {
		const reason = await askReason({
			title: `Cancel ${l.partInternalPn}`,
			body: `${qtyUnit(l.qtyOutstanding, l.unitOfMeasure)} outstanding is struck.${num(l.qtyReceived) > 0 ? ` ${qtyUnit(l.qtyReceived, l.unitOfMeasure)} received stays.` : ''} The line stays on the order.`,
			action: 'CANCEL LINE',
			destructive: true
		});
		if (reason)
			await run(() => opal.purchasing.orders.cancelLine({ id: po.id, lineId: l.id, reason }));
	}

	async function cancelOrder() {
		const reason = await askReason({
			title: `Cancel ${label}`,
			body: 'Every line is struck and the order closes. It can be copied to a new draft.',
			action: 'CANCEL ORDER',
			destructive: true
		});
		if (reason) await run(() => opal.purchasing.orders.cancel({ id: po.id, reason }));
	}

	async function closeShort() {
		const reason = await askReason({
			title: `Close ${label} short`,
			body: 'The outstanding quantity of every line is struck. What arrived stays received.',
			action: 'CLOSE SHORT',
			destructive: true
		});
		if (reason) await run(() => opal.purchasing.orders.closeShort({ id: po.id, reason }));
	}

	async function discard() {
		const ok = await confirm({
			title: `Discard ${label}`,
			body: 'The draft and its lines are deleted.',
			action: 'DISCARD',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.purchasing.orders.discard({ id: po.id });
			await goto('/purchases');
		} catch (e) {
			toastError(e);
		}
	}

	async function copy() {
		try {
			const next = await opal.purchasing.orders.copy({ id: po.id });
			await goto(`/purchases/${next.id}`);
		} catch (e) {
			toastError(e);
		}
	}

	const more = $derived<MoreItem[]>([
		{ label: 'ADD LINE', onselect: addLine, when: live },
		{
			label: 'PUT ON HOLD',
			onselect: () => run(() => opal.purchasing.orders.hold({ id: po.id })),
			when: live
		},
		{
			label: 'CLOSE SHORT',
			onselect: closeShort,
			strike: true,
			when: (live || held) && anyReceived
		},
		{
			label: 'CANCEL ORDER',
			onselect: cancelOrder,
			strike: true,
			when: (live || held) && !anyReceived
		},
		{ label: 'DISCARD', onselect: discard, strike: true, when: draft },
		{ label: 'COPY TO NEW DRAFT', onselect: copy, when: closed }
	]);

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
	{#snippet heading()}
		<h1
			class="text-lg font-semibold tracking-tight {po.status === 'cancelled' ? 'line-through' : ''}"
		>
			{po.supplierName}
		</h1>
	{/snippet}
	{#snippet state()}
		<State
			value={po.status}
			badge={held || po.status === 'cancelled' || po.status === 'closed_short'}
		/>
		{#if po.isOverdue}<State value="overdue" tone="error" badge />{/if}
	{/snippet}
	{#snippet actions()}
		{#if draft}
			<Button
				disabled={po.lines.length === 0}
				title={po.lines.length === 0 ? 'No lines' : undefined}
				onclick={place}>PLACE ORDER</Button
			>
		{:else if held}
			<Button onclick={() => run(() => opal.purchasing.orders.resume({ id: po.id }))}>RESUME</Button
			>
		{/if}
		<EditToggle />
		<MoreMenu items={more} />
	{/snippet}
</PageHeader>

<div
	class={cn(
		'grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]',
		draft && '[&_section]:border-dashed'
	)}
>
	<div class="grid min-w-0 grid-cols-1 content-start gap-4">
		<Section title="ORDER">
			<DetailTable>
				<DetailRow label="Reference" value={po.reference} mono />
				<EditableRow
					label="Supplier"
					type="select"
					value={po.supplierId != null ? String(po.supplierId) : ''}
					options={supplierOptions}
					editable={editing && draft}
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
					editable={editing}
					maxlength={100}
					onsave={(v) => patch({ supplierReference: v })}
				/>
				<EditableRow
					label="Target date"
					type="date"
					mono
					value={po.targetDate}
					editable={editing}
					onsave={(v) => patch({ targetDate: v })}
				>
					{#snippet display()}
						{#if po.targetDate}
							<span class={po.isOverdue ? 'text-error' : ''}>{po.targetDate}</span>
						{:else}
							<span class="text-quiet">—</span>
						{/if}
					{/snippet}
				</EditableRow>
				<EditableRow
					label="Destination"
					value={po.destination}
					editable={editing}
					list="po-destinations"
					maxlength={255}
					onsave={(v) => patch({ destination: v })}
				/>
				<EditableRow
					label="Notes"
					type="textarea"
					value={po.notes}
					editable={editingNotes}
					onsave={(v) => patch({ notes: v })}
				/>
				<DetailRow label="Created">
					<Timestamp value={po.createdAt} />
					{#if po.createdByName}<span class="ml-2 text-muted-foreground">{po.createdByName}</span
						>{/if}
				</DetailRow>
				{#if po.orderedAt}
					<DetailRow label="Placed">
						<Timestamp value={po.orderedAt} />
						{#if placed?.userName}<span class="ml-2 text-muted-foreground">{placed.userName}</span
							>{/if}
					</DetailRow>
				{/if}
				{#if po.receivedAt}
					<DetailRow label="Received">
						<Timestamp value={po.receivedAt} />
						{#if po.receivedByName}<span class="ml-2 text-muted-foreground"
								>{po.receivedByName}</span
							>{/if}
					</DetailRow>
				{/if}
				{#if closing}
					<DetailRow label={po.status === 'cancelled' ? 'Cancelled' : 'Closed short'}>
						<Timestamp value={closing.at} />
						{#if closing.userName}<span class="ml-2 text-muted-foreground">{closing.userName}</span
							>{/if}
						{#if po.closedReason}<div>{po.closedReason}</div>{/if}
					</DetailRow>
				{/if}
			</DetailTable>
			<datalist id="po-destinations">
				{#each data.locations as l (l)}<option value={l}></option>{/each}
			</datalist>
		</Section>

		<AttachmentsSection purchaseId={po.id} attachments={data.attachments} onchanged={refresh} />
	</div>

	<div class="grid min-w-0 grid-cols-1 content-start gap-4">
		<PoLines
			purchase={po}
			{editing}
			onadd={addLine}
			onedit={changeLine}
			onremove={removeLine}
			onamend={amend}
			oncancel={cancelLine}
		/>

		{#if canReceive || data.received.length > 0}
			<ReceiveSection
				purchase={po}
				received={data.received}
				receiving={canReceive}
				locations={data.locations}
				onreceived={refresh}
			/>
		{/if}

		<ExpensesSection
			purchaseId={po.id}
			expenses={data.expenses}
			canAdd={live || po.status === 'received' || (po.status === 'closed_short' && anyReceived)}
			canRemove={editing}
			onchanged={refresh}
		/>

		{#if po.orderedAt}<PoHistory changes={po.changes} />{/if}
	</div>
</div>

<LineDialog
	bind:open={lineOpen}
	purchaseId={po.id}
	line={editLine}
	locations={data.locations}
	onsaved={refresh}
/>
<AmendLineDialog
	bind:open={amendOpen}
	purchaseId={po.id}
	line={amendTarget}
	locations={data.locations}
	onsaved={refresh}
/>
