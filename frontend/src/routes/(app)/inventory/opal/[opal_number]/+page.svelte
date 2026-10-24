<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { opal } from '#lib/api.js';
	import StockActionDialog, {
		type StockAction
	} from '#lib/components/inventory/StockActionDialog.svelte';
	import TestDialog from '#lib/components/inventory/TestDialog.svelte';
	import { ledgerKind, moveLinks, sourceLabel } from '#lib/components/inventory/types.js';
	import type { StockGenealogyRow, StockLedgerRow, StockTestResult } from '@opal/shared';
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
		toastError,
		ErrorBanner
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { date, qty } from '#lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const d = $derived(data.detail);
	const rec = $derived(d?.record ?? null);
	const uom = $derived(rec?.partUom ?? null);

	let actionOpen = $state(false);
	let action = $state<StockAction>('adjust');
	let actionReason = $state<string | undefined>(undefined);
	function openAction(a: StockAction, reason?: string) {
		action = a;
		actionReason = reason;
		actionOpen = true;
	}

	let testOpen = $state(false);
	let editingTest = $state<StockTestResult | null>(null);
	function openTest(t: StockTestResult | null) {
		editingTest = t;
		testOpen = true;
	}

	// lot / expiry edit
	let editOpen = $state(false);
	let editLot = $state('');
	let editSerial = $state('');
	let editExp = $state('');
	let editBusy = $state(false);
	let editError = $state<string | null>(null);
	function openEdit() {
		editLot = rec?.lotNumber ?? '';
		editSerial = rec?.serialNumber ?? '';
		editExp = rec?.expirationDate ?? '';
		editError = null;
		editOpen = true;
	}
	async function saveEdit(e: SubmitEvent) {
		e.preventDefault();
		if (!rec) return;
		editBusy = true;
		editError = null;
		try {
			await opal.inventory.update({
				id: rec.id,
				lotNumber: editLot.trim() || null,
				...(d?.part.trackingType === 'serialized'
					? { serialNumber: editSerial.trim() || null }
					: {}),
				expirationDate: editExp || null
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
			title: `Record calibration for ${rec.opalNumber}`,
			body: 'Sets last calibrated to now and schedules the next due date from the part interval.',
			action: 'RECORD'
		});
		if (!ok) return;
		try {
			await opal.inventory.calibrate({ id: rec.id });
			toast.success('Calibration recorded');
			await refreshAll();
		} catch (e) {
			toastError(e);
		}
	}

	async function removeTest(t: StockTestResult) {
		if (!rec) return;
		const ok = await confirm({
			title: `Delete ${t.testName} result`,
			body: 'The result is removed from this record. The audit log keeps the deletion.',
			action: 'DELETE',
			destructive: true
		});
		if (!ok) return;
		try {
			await opal.inventory.tests.delete({ id: rec.id, testId: t.id });
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
	const ledger = $derived<StockLedgerRow[]>(d ? [...d.ledger].reverse() : []);

	const requiredTemplates = $derived(d?.testTemplates.filter((t) => t.required) ?? []);
	const requiredPassed = $derived(
		requiredTemplates.filter((t) =>
			d?.tests.some((x) => x.templateId === t.id && x.result === 'pass')
		).length
	);

	const empty = $derived(!!rec && Number(rec.balance) <= 0);
	const hasDeclaredTests = $derived(!!d && (d.testTemplates.length > 0 || d.tests.length > 0));
</script>

{#if !d || !rec}
	<PageHeader
		title={data.opal}
		crumbs={[{ label: 'Stock', href: '/inventory' }, { label: data.opal }]}
	/>
	<ErrorBanner message={data.error ?? 'Record not found'} class="m-4 max-w-xl" />
{:else}
	<PageHeader
		identifier={rec.opalNumber}
		title={d.part.name}
		crumbs={[{ label: 'Stock', href: '/inventory' }, { label: rec.opalNumber }]}
	>
		{#snippet state()}
			{#if rec.isExpired}<State value="expired" tone="error" label="EXPIRED" badge />{/if}
			{#if rec.calibrationStatus === 'overdue'}<State
					value="overdue"
					tone="error"
					label="CAL OVERDUE"
					badge
				/>{/if}
			{#if empty}<State value="depleted" tone="muted" label="DEPLETED" badge />{/if}
		{/snippet}
		{#snippet actions()}
			<Button size="sm" variant="outline" href="/label?inventory={rec.opalNumber}">LABEL</Button>
			<Button size="sm" variant="outline" onclick={() => openAction('count')}>COUNT</Button>
			<Button size="sm" variant="outline" onclick={() => openAction('adjust')}>ADJUST</Button>
			<Button size="sm" variant="outline" disabled={empty} onclick={() => openAction('move')}
				>MOVE</Button
			>
			{#if d.part.isTooling}
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
							<span class="font-mono text-info">{d.part.internalPn}</span>
							<span class="ml-1.5">{d.part.name}</span>
						</a>
					</DetailRow>
					<DetailRow label="External PN" value={d.part.externalPn} mono />
					<DetailRow label="Tracking">
						<span class="uppercase">{d.part.trackingType}</span>
					</DetailRow>
					<DetailRow label="Location" value={rec.location} mono />
					<DetailRow label="Quantity">
						<span class="font-mono tabular-nums">{qty(rec.balance, uom)}</span>
					</DetailRow>
					<DetailRow label="Lot">
						<span class="font-mono">{rec.lotNumber ?? '—'}</span>
					</DetailRow>
					{#if d.part.trackingType === 'serialized'}
						<DetailRow label="Serial">
							<span class="font-mono">{rec.serialNumber ?? '—'}</span>
						</DetailRow>
					{/if}
					<DetailRow label="Source">
						{@const links = moveLinks(d.source.links)}
						{#if d.source.transferredFromOpal}
							<span class="font-mono text-xs text-muted-foreground">MOVED FROM</span>
							<a
								href="/inventory/opal/{d.source.transferredFromOpal}"
								class="ml-1 font-mono text-info hover:underline">{d.source.transferredFromOpal}</a
							>
						{:else}
							<span class="font-mono text-xs">{sourceLabel(d.source.type)}</span>
							{#each links as l (l.label)}
								{#if l.href}
									<a href={l.href} class="ml-2 font-mono text-info hover:underline">{l.label}</a>
								{:else}
									<span class="ml-2 font-mono text-xs text-muted-foreground">{l.label}</span>
								{/if}
							{/each}
						{/if}
					</DetailRow>
					<DetailRow label="Expires">
						{#if rec.expirationDate}
							<span class="font-mono">{date(rec.expirationDate)}</span>
							{#if rec.isExpired}<State value="expired" tone="error" label="EXPIRED" class="ml-2" />
							{:else if rec.daysUntilExpiration !== null && rec.daysUntilExpiration <= 30}<State
									value="expiring"
									tone="warn"
									label="{rec.daysUntilExpiration}D"
									class="ml-2"
								/>{/if}
						{:else}—{/if}
					</DetailRow>
					{#if d.part.isTooling}
						<DetailRow label="Last calibrated">
							<Timestamp value={rec.lastCalibratedAt} />
						</DetailRow>
						<DetailRow label="Calibration due">
							<Timestamp value={rec.calibrationDueAt} />
							{#if rec.calibrationStatus === 'overdue'}<State
									value="overdue"
									tone="error"
									label="OVERDUE"
									class="ml-2"
								/>
							{:else if rec.calibrationStatus === 'due_soon'}<State
									value="due"
									tone="warn"
									label="DUE"
									class="ml-2"
								/>{/if}
						</DetailRow>
					{/if}
					<DetailRow label="Last counted"><Timestamp value={rec.lastCountedAt} /></DetailRow>
					<DetailRow label="Received"><Timestamp value={rec.createdAt} /></DetailRow>
				</DetailTable>
			</Section>

			{#if data.qrSvg}
				<div class="rounded-lg border border-border bg-card p-3">
					<!-- QR codes are black on transparent; a white ground keeps them scannable in dark mode. -->
					<img
						src="data:image/svg+xml;utf8,{encodeURIComponent(data.qrSvg)}"
						alt="QR code for {rec.opalNumber}"
						class="size-32 bg-white p-1"
					/>
					<p class="mt-1.5 text-center font-mono text-xs text-muted-foreground">
						{rec.opalNumber}
					</p>
				</div>
			{/if}
		</div>

		<Section title="Ledger" count={ledger.length}>
			<DataTable
				rows={ledger}
				columns={[
					{ key: 'at', label: 'When' },
					{ key: 'kind', label: 'Event' },
					{ key: 'qty', label: 'Change', align: 'right', mono: true },
					{ key: 'balance', label: 'On hand', align: 'right', mono: true },
					{ key: 'context', label: 'Context' },
					{ key: 'actorName', label: 'By' }
				]}
				emptyLabel="Ledger"
				key={(r) => r.id}
			>
				{#snippet cell(r, col)}
					{#if col.key === 'at'}
						<Timestamp value={r.at} />
					{:else if col.key === 'kind'}
						{@const k = ledgerKind(r)}
						<State value={r.kind} tone={k.tone} label={k.label} />
					{:else if col.key === 'qty'}
						{#if Number(r.qty) === 0}
							<span class="text-muted-foreground">0</span>
						{:else}
							<span class={Number(r.qty) > 0 ? 'text-ok' : 'text-warn'}>{signed(r.qty)}</span>
						{/if}
					{:else if col.key === 'balance'}
						{qty(r.balance, uom)}
					{:else if col.key === 'context'}
						<div class="flex flex-wrap items-baseline gap-x-2">
							{#each moveLinks(r.links) as l (l.label)}
								{#if l.href}
									<a href={l.href} class="font-mono text-info hover:underline">{l.label}</a>
								{:else}
									<span class="font-mono text-xs text-muted-foreground">{l.label}</span>
								{/if}
							{/each}
							{#if r.fromLocation || r.toLocation}
								<span class="font-mono text-xs"
									>{r.fromLocation || '—'} → {r.toLocation || '—'}</span
								>
							{/if}
							{#if r.counterpartOpal}
								<a
									href="/inventory/opal/{r.counterpartOpal}"
									class="font-mono text-info hover:underline">{r.counterpartOpal}</a
								>
							{/if}
							{#if r.reason && r.reason !== 'tooling'}
								<span class="font-mono text-xs text-muted-foreground uppercase"
									>{r.reason.replace(/_/g, ' ')}</span
								>
							{/if}
							{#if r.notes}<span class="text-muted-foreground">{r.notes}</span>{/if}
						</div>
					{:else if r.actorName}
						{r.actorName}
					{:else}
						<span class="text-muted-foreground">—</span>
					{/if}
				{/snippet}
			</DataTable>
		</Section>

		{#if d.components.length}
			<Section title="Components" count={d.components.length}>
				{@render genealogy(d.components)}
			</Section>
		{:else if d.source.type === 'production'}
			<EmptyLine label="Components" />
		{/if}
		{#if d.usedIn.length}
			<Section title="Used in" count={d.usedIn.length}>
				{@render genealogy(d.usedIn)}
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
							{ key: 'testName', label: 'Test' },
							{ key: 'result', label: 'Result' },
							{ key: 'value', label: 'Value', mono: true },
							{ key: 'notes', label: 'Notes' },
							{ key: 'testedByName', label: 'Tested by' },
							{ key: 'testedAt', label: 'Tested' },
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
							{:else if col.key === 'testedAt'}
								<Timestamp value={r.testedAt} />
							{:else if col.key === 'actions'}
								<span class="inline-flex gap-3">
									<ActionLink onclick={() => openTest(r)}>EDIT</ActionLink>
									<ActionLink danger onclick={() => removeTest(r)}>DELETE</ActionLink>
								</span>
							{:else}
								{@const v = r[col.key as 'testName' | 'value' | 'notes' | 'testedByName']}
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
		stockId={rec.id}
		templates={d.testTemplates}
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
					<Label class="label" for="e-lot">Lot</Label>
					<Input id="e-lot" class="font-mono" bind:value={editLot} autocomplete="off" />
				</div>
				{#if d.part.trackingType === 'serialized'}
					<div class="grid grid-cols-1 gap-1.5">
						<Label class="label" for="e-serial">Serial</Label>
						<Input id="e-serial" class="font-mono" bind:value={editSerial} autocomplete="off" />
					</div>
				{/if}
				<div class="grid grid-cols-1 gap-1.5">
					<Label class="label" for="e-exp">Expires</Label>
					<Input id="e-exp" type="date" class="font-mono" bind:value={editExp} />
				</div>
				<ErrorBanner message={editError} />
				<Dialog.Footer>
					<Button type="button" variant="outline" onclick={() => (editOpen = false)}>CANCEL</Button>
					<Button type="submit" disabled={editBusy}>SAVE</Button>
				</Dialog.Footer>
			</form>
		</Dialog.Content>
	</Dialog.Root>
{/if}

{#snippet genealogy(rows: StockGenealogyRow[])}
	<DataTable
		{rows}
		columns={[
			{ key: 'opalNumber', label: 'OPAL', mono: true },
			{ key: 'part', label: 'Part' },
			{ key: 'qtyUsed', label: 'Qty used', align: 'right' as const, mono: true }
		]}
		href={(r) => `/inventory/opal/${r.opalNumber}`}
		emptyLabel="Components"
		key={(r) => `${r.viaOpal}-${r.opalNumber}`}
	>
		{#snippet cell(r, col)}
			{#if col.key === 'opalNumber'}
				<span class="font-semibold text-info">{r.opalNumber}</span>
			{:else if col.key === 'part'}
				<a href="/parts/{r.partId}" class="hover:underline">
					<span class="font-mono text-info">{r.partInternalPn}</span>
					<span class="ml-1.5">{r.partName}</span>
				</a>
			{:else}
				{qty(r.qtyUsed)}
			{/if}
		{/snippet}
	</DataTable>
{/snippet}
