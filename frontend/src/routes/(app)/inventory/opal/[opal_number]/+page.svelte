<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { api } from '#lib/api.js';
	import StockActionDialog, {
		type StockAction
	} from '#lib/components/inventory/StockActionDialog.svelte';
	import TestDialog from '#lib/components/inventory/TestDialog.svelte';
	import {
		LEDGER_KIND,
		sourceLabel,
		type GenealogyRow,
		type LedgerRow,
		type StockTest
	} from '#lib/components/inventory/types.js';
	import {
		ActionLink,
		confirm,
		DataTable,
		DetailRow,
		DetailTable,
		EmptyLine,
		PageHeader,
		Section,
		State,
		Timestamp,
		toast,
		toastError
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { date, qty } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const d = $derived(data.detail);
	const rec = $derived(d?.inventory ?? null);
	const uom = $derived(rec?.part_uom ?? null);

	let actionOpen = $state(false);
	let action = $state<StockAction>('adjust');
	let actionReason = $state<string | undefined>(undefined);
	function openAction(a: StockAction, reason?: string) {
		action = a;
		actionReason = reason;
		actionOpen = true;
	}

	let testOpen = $state(false);
	let editingTest = $state<StockTest | null>(null);
	function openTest(t: StockTest | null) {
		editingTest = t;
		testOpen = true;
	}

	// lot / expiry edit
	let editOpen = $state(false);
	let editLot = $state('');
	let editExp = $state('');
	let editBusy = $state(false);
	let editError = $state<string | null>(null);
	function openEdit() {
		editLot = rec?.lot_number ?? '';
		editExp = rec?.expiration_date ?? '';
		editError = null;
		editOpen = true;
	}
	async function saveEdit(e: SubmitEvent) {
		e.preventDefault();
		if (!rec) return;
		editBusy = true;
		editError = null;
		try {
			await api.patch(`/inventory/${rec.id}`, {
				lot_number: editLot.trim() || null,
				expiration_date: editExp || null
			});
			editOpen = false;
			toast.success('Saved');
			await refreshAll();
		} catch (err) {
			editError = err instanceof Error ? err.message : 'Save failed';
		} finally {
			editBusy = false;
		}
	}

	async function calibrate() {
		if (!rec) return;
		const ok = await confirm({
			title: `Record calibration for ${rec.opal_number}`,
			body: 'Sets last calibrated to now and schedules the next due date from the part interval.',
			action: 'RECORD'
		});
		if (!ok) return;
		try {
			await api.post(`/inventory/${rec.id}/calibrate`);
			toast.success('Calibration recorded');
			await refreshAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function removeTest(t: StockTest) {
		if (!rec) return;
		const ok = await confirm({
			title: `Delete ${t.test_name} result`,
			body: 'The result is removed from this record. The audit log keeps the deletion.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await api.del(`/inventory/${rec.id}/tests/${t.id}`);
			await refreshAll();
		} catch (e) {
			toastError(e);
		}
	}

	const signed = (v: number | string) => {
		const n = Number(v);
		return n > 0 ? `+${qty(n)}` : qty(n);
	};

	// Newest first; the balance column keeps the running total readable top to bottom.
	const ledger = $derived<LedgerRow[]>(d ? [...d.ledger].reverse() : []);

	const requiredTemplates = $derived(d?.test_templates.filter((t) => t.required) ?? []);
	const requiredPassed = $derived(
		requiredTemplates.filter((t) =>
			d?.tests.some((x) => x.template_id === t.id && x.result === 'pass')
		).length
	);

	const empty = $derived(!!rec && Number(rec.quantity) <= 0);
	const hasDeclaredTests = $derived(!!d && (d.test_templates.length > 0 || d.tests.length > 0));
</script>

{#if !d || !rec}
	<PageHeader
		title={data.opal}
		crumbs={[{ label: 'Stock', href: '/inventory' }, { label: data.opal }]}
	/>
	<p
		role="alert"
		class="m-4 max-w-xl border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
	>
		{data.error ?? 'Record not found'}
	</p>
{:else}
	<PageHeader
		identifier={rec.opal_number}
		title={d.part.name}
		crumbs={[{ label: 'Stock', href: '/inventory' }, { label: rec.opal_number ?? '' }]}
	>
		{#snippet state()}
			{#if rec.is_expired}<State value="expired" tone="error" label="EXPIRED" badge />{/if}
			{#if rec.calibration_status === 'overdue'}<State
					value="overdue"
					tone="error"
					label="CAL OVERDUE"
					badge
				/>{/if}
			{#if empty}<State value="depleted" tone="muted" label="DEPLETED" badge />{/if}
		{/snippet}
		{#snippet actions()}
			<Button size="sm" variant="outline" href="/label?inventory={rec.opal_number}">LABEL</Button>
			<Button size="sm" variant="outline" onclick={() => openAction('count')}>COUNT</Button>
			<Button size="sm" variant="outline" onclick={() => openAction('adjust')}>ADJUST</Button>
			<Button size="sm" variant="outline" disabled={empty} onclick={() => openAction('move')}
				>MOVE</Button
			>
			{#if d.part.is_tooling}
				<Button size="sm" variant="outline" onclick={calibrate}>CALIBRATE</Button>
			{/if}
			<Button
				size="sm"
				variant="destructive"
				disabled={empty}
				onclick={() => openAction('adjust', 'scrap')}>SCRAP</Button
			>
		{/snippet}
	</PageHeader>

	<div class="space-y-4 p-4">
		<div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,48rem)_max-content]">
			<Section title="Record">
				{#snippet actions()}
					<ActionLink onclick={openEdit}>EDIT</ActionLink>
				{/snippet}
				<DetailTable>
					<DetailRow label="Part">
						<a href="/parts/{d.part.id}" class="hover:underline">
							<span class="font-mono text-info">{d.part.internal_pn ?? '—'}</span>
							<span class="ml-1.5">{d.part.name}</span>
						</a>
					</DetailRow>
					<DetailRow label="External PN" value={d.part.external_pn} mono />
					<DetailRow label="Tracking">
						<span class="uppercase">{d.part.tracking_type}</span>
					</DetailRow>
					<DetailRow label="Location" value={rec.location} mono />
					<DetailRow label="Quantity">
						<span class="font-mono tabular-nums">{qty(rec.quantity, uom)}</span>
					</DetailRow>
					<DetailRow label={d.part.tracking_type === 'serialized' ? 'Lot / serial' : 'Lot'}>
						<span class="font-mono">{rec.lot_number ?? '—'}</span>
					</DetailRow>
					<DetailRow label="Source">
						{#if d.source.purchase}
							<a
								href="/purchases/{d.source.purchase.id}"
								class="font-mono text-info hover:underline"
								>{d.source.purchase.reference ?? 'PURCHASE'}</a
							>
							{#if d.source.purchase.supplier}<span class="ml-1.5 text-muted-foreground"
									>{d.source.purchase.supplier}</span
								>{/if}
						{:else if d.source.execution}
							<a
								href="/executions/{d.source.execution.id}"
								class="font-mono text-info hover:underline"
								>{d.source.execution.work_order_number ?? 'PRODUCED'}</a
							>
						{:else if d.source.transferred_from_opal}
							<span class="font-mono text-xs text-muted-foreground">MOVED FROM</span>
							<a
								href="/inventory/opal/{d.source.transferred_from_opal}"
								class="ml-1 font-mono text-info hover:underline">{d.source.transferred_from_opal}</a
							>
						{:else}
							<span class="font-mono text-xs">{sourceLabel(d.source.type)}</span>
						{/if}
					</DetailRow>
					{#if d.source.execution?.serial_number}
						<DetailRow label="Build serial" value={d.source.execution.serial_number} mono />
					{/if}
					<DetailRow label="Expires">
						{#if rec.expiration_date}
							<span class="font-mono">{date(rec.expiration_date)}</span>
							{#if rec.is_expired}<State
									value="expired"
									tone="error"
									label="EXPIRED"
									class="ml-2"
								/>
							{:else if rec.days_until_expiration !== null && rec.days_until_expiration <= 30}<State
									value="expiring"
									tone="warn"
									label="{rec.days_until_expiration}D"
									class="ml-2"
								/>{/if}
						{:else}—{/if}
					</DetailRow>
					{#if d.part.is_tooling}
						<DetailRow label="Last calibrated">
							<Timestamp value={rec.last_calibrated_at} />
						</DetailRow>
						<DetailRow label="Calibration due">
							<Timestamp value={rec.calibration_due_at} />
							{#if rec.calibration_status === 'overdue'}<State
									value="overdue"
									tone="error"
									label="OVERDUE"
									class="ml-2"
								/>
							{:else if rec.calibration_status === 'due_soon'}<State
									value="due"
									tone="warn"
									label="DUE"
									class="ml-2"
								/>{/if}
						</DetailRow>
					{/if}
					<DetailRow label="Last counted"><Timestamp value={rec.last_counted_at} /></DetailRow>
					<DetailRow label="Received"><Timestamp value={rec.created_at} /></DetailRow>
				</DetailTable>
			</Section>

			<div class="border border-border bg-card p-3">
				<!-- QR codes are black on transparent; a white ground keeps them scannable in dark mode. -->
				<img
					src="/api/inventory/{rec.id}/qrcode"
					alt="QR code for {rec.opal_number}"
					class="size-32 bg-white p-1"
				/>
				<p class="mt-1.5 text-center font-mono text-xs text-muted-foreground">
					{rec.opal_number}
				</p>
			</div>
		</div>

		<Section title="Ledger" count={ledger.length}>
			<DataTable
				rows={ledger}
				columns={[
					{ key: 'timestamp', label: 'When' },
					{ key: 'kind', label: 'Event' },
					{ key: 'delta', label: 'Change', align: 'right', mono: true },
					{ key: 'balance', label: 'On hand', align: 'right', mono: true },
					{ key: 'context', label: 'Context' },
					{ key: 'user_name', label: 'By' }
				]}
				emptyLabel="Ledger"
				key={(r) => `${r.timestamp}-${r.kind}-${r.balance}`}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'timestamp'}
						<Timestamp value={r.timestamp} />
					{:else if col.key === 'kind'}
						<State
							value={r.kind}
							tone={LEDGER_KIND[r.kind]?.tone ?? 'default'}
							label={LEDGER_KIND[r.kind]?.label ?? r.kind.toUpperCase()}
						/>
					{:else if col.key === 'delta'}
						{#if r.kind === 'moved'}
							<span class="text-muted-foreground">{qty(r.quantity)}</span>
						{:else if Number(r.delta) === 0}
							<span class="text-muted-foreground"
								>{r.kind === 'tooling' || r.kind === 'planned' ? qty(r.quantity) : '0'}</span
							>
						{:else}
							<span class={Number(r.delta) > 0 ? 'text-ok' : 'text-warn'}>{signed(r.delta)}</span>
						{/if}
					{:else if col.key === 'balance'}
						{qty(r.balance, uom)}
					{:else if col.key === 'context'}
						<div class="flex flex-wrap items-baseline gap-x-2">
							{#if r.execution}
								<a href="/executions/{r.execution.id}" class="font-mono text-info hover:underline"
									>{r.execution.work_order_number ?? 'EXECUTION'}</a
								>
							{:else if r.kind === 'received'}
								{#if d.source.purchase}
									<a
										href="/purchases/{d.source.purchase.id}"
										class="font-mono text-info hover:underline"
										>{d.source.purchase.reference ?? 'PURCHASE'}</a
									>
								{:else}
									<span class="font-mono text-xs text-muted-foreground"
										>{sourceLabel(d.source.type)}</span
									>
								{/if}
							{/if}
							{#if r.from_location || r.to_location}
								<span class="font-mono text-xs"
									>{r.from_location || '—'} → {r.to_location || '—'}</span
								>
							{/if}
							{#if r.counterpart_opal}
								<a
									href="/inventory/opal/{r.counterpart_opal}"
									class="font-mono text-info hover:underline">{r.counterpart_opal}</a
								>
							{/if}
							{#if r.reason}
								<span class="font-mono text-xs text-muted-foreground uppercase"
									>{r.reason.replace(/_/g, ' ')}</span
								>
							{/if}
							{#if r.notes}<span class="text-muted-foreground">{r.notes}</span>{/if}
						</div>
					{:else}
						{#if r.user_name}{r.user_name}{:else}<span class="text-muted-foreground">—</span>{/if}
					{/if}
				{/snippet}
			</DataTable>
		</Section>

		{#if d.components.length}
			<Section title="Components" count={d.components.length}>
				{@render genealogy(d.components, false)}
			</Section>
		{:else if d.source.type === 'production'}
			<EmptyLine label="Components" />
		{/if}
		{#if d.assemblies.length}
			<Section title="Used in" count={d.assemblies.length}>
				{@render genealogy(d.assemblies, true)}
			</Section>
		{/if}

		{#if hasDeclaredTests}
			{#if d.tests.length}
				<Section title="Tests" count={d.tests.length}>
					{#snippet actions()}
						{#if requiredTemplates.length}
							<span class="mr-2 font-mono text-xs text-muted-foreground"
								>REQUIRED {requiredPassed}/{requiredTemplates.length}</span
							>
						{/if}
						<ActionLink onclick={() => openTest(null)}>+ RUN</ActionLink>
					{/snippet}
					<DataTable
						rows={d.tests}
						columns={[
							{ key: 'test_name', label: 'Test' },
							{ key: 'result', label: 'Result' },
							{ key: 'value', label: 'Value', mono: true },
							{ key: 'notes', label: 'Notes' },
							{ key: 'tested_by_name', label: 'Tested by' },
							{ key: 'tested_at', label: 'Tested' },
							{ key: 'actions', label: '', align: 'right' }
						]}
						emptyLabel="Tests"
						key={(r) => r.id}
					>
						{#snippet cell(r, col)}
							{#if col.key === 'result'}
								<State
									value={r.result}
									tone={r.result === 'pass' ? 'ok' : r.result === 'fail' ? 'error' : 'warn'}
								/>
							{:else if col.key === 'tested_at'}
								<Timestamp value={r.tested_at} />
							{:else if col.key === 'actions'}
								<span class="inline-flex gap-3">
									<ActionLink onclick={() => openTest(r)}>EDIT</ActionLink>
									<ActionLink danger onclick={() => removeTest(r)}>DELETE</ActionLink>
								</span>
							{:else}
								{@const v = r[col.key as 'test_name' | 'value' | 'notes' | 'tested_by_name']}
								{#if v}{v}{:else}<span class="text-muted-foreground">—</span>{/if}
							{/if}
						{/snippet}
					</DataTable>
				</Section>
			{:else}
				<EmptyLine label="Tests" onadd={() => openTest(null)} addLabel="+ RUN" />
			{/if}
		{/if}
	</div>

	<StockActionDialog
		bind:open={actionOpen}
		{action}
		record={rec}
		locations={data.locations}
		reason={actionReason}
		ondone={() => refreshAll()}
	/>
	<TestDialog
		bind:open={testOpen}
		inventoryId={rec.id}
		templates={d.test_templates}
		test={editingTest}
		ondone={() => refreshAll()}
	/>

	<Dialog.Root bind:open={editOpen}>
		<Dialog.Content class="sm:max-w-sm">
			<Dialog.Header>
				<Dialog.Title class="text-sm font-semibold">Edit record</Dialog.Title>
			</Dialog.Header>
			<form onsubmit={saveEdit} class="grid grid-cols-1 gap-3">
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="e-lot"
						>{d.part.tracking_type === 'serialized' ? 'Lot / serial' : 'Lot'}</Label
					>
					<Input id="e-lot" class="font-mono" bind:value={editLot} autocomplete="off" />
				</div>
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="e-exp">Expires</Label>
					<Input id="e-exp" type="date" class="font-mono" bind:value={editExp} />
				</div>
				{#if editError}
					<p
						role="alert"
						class="border border-error/40 bg-error-muted px-2 py-1.5 text-xs text-error"
					>
						{editError}
					</p>
				{/if}
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (editOpen = false)}>CANCEL</Button>
					<Button type="submit" disabled={editBusy}>SAVE</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}

{#snippet genealogy(rows: GenealogyRow[], withWo: boolean)}
	<DataTable
		{rows}
		columns={[
			{ key: 'opal_number', label: 'OPAL', mono: true },
			{ key: 'part', label: 'Part' },
			...(withWo ? [{ key: 'work_order_number', label: 'Work order', mono: true }] : []),
			{ key: 'quantity_used', label: 'Qty used', align: 'right' as const, mono: true }
		]}
		href={(r) => `/inventory/opal/${r.opal_number}`}
		emptyLabel="Components"
		key={(r) => r.opal_number}
	>
		{#snippet cell(r, col)}
			{#if col.key === 'opal_number'}
				<span class="font-semibold text-info">{r.opal_number}</span>
			{:else if col.key === 'part'}
				{#if r.part_id}
					<a href="/parts/{r.part_id}" class="hover:underline">
						<span class="font-mono text-info">{r.part_number ?? '—'}</span>
						<span class="ml-1.5">{r.part_name}</span>
					</a>
				{:else}<span class="text-muted-foreground">—</span>{/if}
			{:else if col.key === 'work_order_number'}
				{r.work_order_number ?? '—'}
			{:else}
				{qty(r.quantity_used)}
			{/if}
		{/snippet}
	</DataTable>
{/snippet}
