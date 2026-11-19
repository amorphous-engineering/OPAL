<script lang="ts">
	// The units a work order acts on, named on the OP that declares them, and components taken out
	// of them at any step. While the OP is workable a unit can be named or taken back; once it
	// completes the names are on record and read only.
	import type { DocUnitSlot, ExecUnit, InstalledComponent } from '@opal/shared';
	import { ActionLink, Timestamp } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect } from '#lib/components/ui/native-select/index.js';
	import PartPicker from '#lib/components/parts/PartPicker.svelte';
	import { qtyUnit } from '#lib/format.js';
	import {
		useDoc,
		type PartHit,
		type StockRecordLite
	} from '#lib/components/procedure-doc/controller.js';
	import type { DocOp, DocStep } from '#lib/components/procedure-doc/types.js';

	let { step, op }: { step: DocStep; op: DocOp } = $props();
	const ctl = useDoc();
	const act = $derived(ctl.actions.units);

	const rec = $derived(step.unit_record);
	const isOp = $derived(op.step === step);
	const workable = $derived(
		ctl.mode === 'execute' &&
			ctl.active &&
			!!act &&
			(step.status === 'pending' || step.status === 'in_progress')
	);
	const naming = $derived(workable && isOp);
	// Removal goes where parts come off: a step that installs into a unit (the old part comes out
	// where the new one goes in), and an OP that names units and has work under it. An OP that only
	// names them, such as a test record, takes nothing out.
	const named = $derived(
		step.step_kit.some((k) => k.into) || (isOp && !!rec?.slots.length && op.steps.length > 0)
			? (act?.named() ?? []).filter((u) => u.stockId !== null)
			: []
	);

	// ---- naming a unit: a record of the slot's part, or borrowed gear (text)
	const BORROWED = 'borrowed';
	let candidates = $state<Record<number, StockRecordLite[]>>({});
	let choice = $state<Record<string, string>>({});
	let lent = $state<Record<string, { name: string; serial: string; lentBy: string }>>({});
	let extraPart = $state<PartHit | null>(null);
	let busy = $state(false);

	async function load(partId: number) {
		if (!act || candidates[partId]) return;
		candidates[partId] = await act.candidates(partId);
	}
	$effect(() => {
		if (!naming || !rec) return;
		for (const s of rec.slots) if (!s.unit) load(s.partId);
	});

	async function name(key: string, slot: string | null, partName: string) {
		if (!act) return;
		const pick = choice[key] ?? '';
		busy = true;
		try {
			if (pick === BORROWED) {
				const b = lent[key] ?? { name: '', serial: '', lentBy: '' };
				await act.bind(step, {
					slot,
					borrowed: {
						name: b.name.trim() || partName,
						serial: b.serial.trim() || null,
						lentBy: b.lentBy.trim() || null
					}
				});
			} else if (pick) {
				await act.bind(step, { slot, stockId: Number(pick) });
			}
			choice[key] = '';
			if (slot === null) extraPart = null;
		} finally {
			busy = false;
		}
	}

	const label = (r: StockRecordLite) =>
		`${r.opal_number}${r.serial_number ? ` SN ${r.serial_number}` : ''}${Number(r.balance) > 0 ? ` · ${r.location || '—'}` : ' · installed'}`;

	// ---- removal: a component out of a named unit
	let removing = $state(false);
	let fromUnit = $state('');
	let parts = $state<InstalledComponent[]>([]);
	let comp = $state('');
	let qty = $state('1');
	let location = $state('');
	let why = $state('');
	const chosen = $derived(parts.find((p) => String(p.stockId) === comp));

	async function pickUnit(id: string) {
		fromUnit = id;
		comp = '';
		parts = id && act ? await act.installed(Number(id)) : [];
	}

	async function record() {
		if (!act || !chosen) return;
		busy = true;
		try {
			const done = await act.remove(step, {
				unitId: Number(fromUnit),
				stockId: chosen.stockId,
				quantity: chosen.serialized ? '1' : qty,
				location: chosen.serialized && location.trim() ? location.trim() : null,
				notes: why.trim() || null
			});
			if (done) {
				removing = false;
				fromUnit = comp = location = why = '';
				qty = '1';
			}
		} finally {
			busy = false;
		}
	}
</script>

{#snippet unitCell(u: ExecUnit)}
	{#if u.borrowed}
		<span class="font-mono">BORROWED</span>
		{u.borrowed.name}{#if u.borrowed.serial}<span class="ml-1 font-mono">
				SN {u.borrowed.serial}</span
			>{/if}{#if u.borrowed.lentBy}<span class="ml-1 text-muted-foreground">
				from {u.borrowed.lentBy}</span
			>{/if}
	{:else}
		<a class="font-mono text-info hover:underline" href={`/inventory/opal/${u.opalNumber}`}
			>{u.opalNumber}</a
		>{#if u.serialNumber}<span class="ml-1 font-mono">SN {u.serialNumber}</span>{/if}
		{#if u.partNumber && u.slot === null}<span class="text-muted-foreground">
				{u.partNumber} {u.partName}</span
			>{/if}
	{/if}
{/snippet}

{#snippet stamp(u: ExecUnit)}
	<span class="font-mono text-xs text-muted-foreground"
		>{u.recordedBy ?? '—'} · <Timestamp value={u.recordedAt} /></span
	>
	{#if naming && u.pencil && act}
		<ActionLink class="ml-2" onclick={() => act.unbind(u.id)}>TAKE BACK</ActionLink>
	{/if}
{/snippet}

{#snippet picker(key: string, slot: string | null, partId: number, partName: string)}
	<span class="inline-flex flex-wrap items-center gap-2">
		<NativeSelect
			aria-label={`Unit for ${partName}`}
			value={choice[key] ?? ''}
			onchange={(e) => {
				choice[key] = e.currentTarget.value;
				if (choice[key] === BORROWED && !lent[key])
					lent[key] = { name: partName, serial: '', lentBy: '' };
			}}
		>
			<option value="">—</option>
			{#each candidates[partId] ?? [] as r (r.id)}<option value={String(r.id)}>{label(r)}</option
				>{/each}
			<option value={BORROWED}>BORROWED…</option>
		</NativeSelect>
		{#if choice[key] === BORROWED && lent[key]}
			<Input class="h-7 w-40" aria-label="What" placeholder="What" bind:value={lent[key].name} />
			<Input
				class="h-7 w-28 font-mono"
				aria-label="Serial"
				placeholder="Serial"
				bind:value={lent[key].serial}
			/>
			<Input
				class="h-7 w-32"
				aria-label="Lent by"
				placeholder="Lent by"
				bind:value={lent[key].lentBy}
			/>
		{/if}
		<Button
			size="sm"
			variant="outline"
			disabled={busy || !choice[key]}
			onclick={() => name(key, slot, partName)}>NAME</Button
		>
	</span>
{/snippet}

{#if (rec && (rec.slots.length || rec.extras.length)) || (naming && rec)}
	<div class="grid grid-cols-1 gap-1.5" data-step-units={step.order}>
		<span class="label">Units</span>
		<table class="w-full border-collapse text-xs">
			<thead>
				<tr class="border-b border-border bg-muted/60 text-left">
					{#each ['SLOT', 'PART', 'UNIT', 'NAMED'] as h (h)}
						<th class="h-7 px-2 font-mono text-xs font-medium tracking-wider text-muted-foreground"
							>{h}</th
						>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rec?.slots ?? [] as s (s.key)}
					{@render slotRow(s)}
				{/each}
				{#each rec?.extras ?? [] as u (u.id)}
					<tr class="border-b border-border">
						<td class="px-2 py-1 text-muted-foreground">—</td>
						<td class="px-2 py-1 font-mono">{u.partNumber ?? ''}</td>
						<td class="px-2 py-1">{@render unitCell(u)}</td>
						<td class="px-2 py-1">{@render stamp(u)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if naming}
			<div class="flex flex-wrap items-center gap-2">
				{#if extraPart}
					<span class="font-mono text-xs">{extraPart.internal_pn ?? ''}</span>
					<span class="text-xs">{extraPart.name}</span>
					{@render picker('extra', null, extraPart.id, extraPart.name)}
				{:else}
					<PartPicker
						meta="tracking_type"
						onselect={(p: PartHit | null) => {
							if (!p) return;
							extraPart = p;
							load(p.id);
						}}
					>
						{#snippet trigger({ props })}
							<ActionLink {...props}>+ OTHER HARDWARE</ActionLink>
						{/snippet}
					</PartPicker>
				{/if}
			</div>
		{/if}
	</div>
{/if}

{#snippet slotRow(s: DocUnitSlot)}
	<tr class="border-b border-border">
		<td class="px-2 py-1"
			>{s.label}{#if s.required && !s.unit}<span class="ml-1 font-mono text-warn">REQUIRED</span
				>{/if}</td
		>
		<td class="px-2 py-1"><span class="font-mono">{s.partNumber}</span> {s.partName}</td>
		<td class="px-2 py-1">
			{#if s.unit}
				{@render unitCell(s.unit)}
			{:else if naming}
				{@render picker(s.key, s.key, s.partId, s.partName)}
			{:else}
				<span class="text-quiet">—</span>
			{/if}
		</td>
		<td class="px-2 py-1"
			>{#if s.unit}{@render stamp(s.unit)}{/if}</td
		>
	</tr>
{/snippet}

{#if rec?.removals.length || (workable && named.length)}
	<div class="grid grid-cols-1 gap-1">
		{#each rec?.removals ?? [] as r (r.id)}
			<div class="font-mono text-xs text-muted-foreground">
				<span class="text-foreground">REMOVED</span>
				{r.partNumber}
				{r.partName}
				<a class="text-info" href={`/inventory/opal/${r.opalNumber}`}>{r.opalNumber}</a>
				× {qtyUnit(r.quantity, r.uom)} from
				<a class="text-info" href={`/inventory/opal/${r.assemblyOpal}`}>{r.assemblyOpal}</a>
				→ {r.disposition === 'stock' ? `stock at ${r.location}` : 'scrap'}
				{#if r.notes}<span> · {r.notes}</span>{/if}
				· {r.removedBy ?? '—'} · <Timestamp value={r.at} />
			</div>
		{/each}
		{#if workable && named.length}
			{#if removing}
				<div class="flex flex-wrap items-center gap-2 border border-border bg-muted/30 p-2 text-xs">
					<NativeSelect
						aria-label="Unit"
						value={fromUnit}
						onchange={(e) => pickUnit(e.currentTarget.value)}
					>
						<option value="">Out of…</option>
						{#each named as u (u.id)}<option value={String(u.id)}
								>{u.slotLabel ?? u.partName} {u.opalNumber}</option
							>{/each}
					</NativeSelect>
					{#if fromUnit}
						<NativeSelect aria-label="Component" bind:value={comp}>
							<option value="">Component…</option>
							{#each parts as p (p.stockId)}<option value={String(p.stockId)}
									>{p.partNumber} {p.partName} {p.opalNumber} · {qtyUnit(p.quantity, p.uom)}</option
								>{/each}
						</NativeSelect>
					{/if}
					{#if chosen && !chosen.serialized}
						<Input
							type="number"
							min="0"
							step="any"
							class="h-7 w-20 font-mono"
							aria-label="Quantity"
							bind:value={qty}
						/>
						<span class="font-mono text-muted-foreground">{chosen.uom} · SCRAP</span>
					{:else if chosen}
						<Input
							class="h-7 w-36"
							aria-label="Back to stock at"
							placeholder="Back to stock at (blank: scrap)"
							bind:value={location}
						/>
					{/if}
					<Input class="h-7 w-48" aria-label="Why" placeholder="Why" bind:value={why} />
					<Button size="sm" disabled={busy || !chosen} onclick={record}>RECORD</Button>
					<Button size="sm" variant="outline" onclick={() => (removing = false)}>CANCEL</Button>
				</div>
			{:else}
				<div><ActionLink onclick={() => (removing = true)}>+ REMOVAL</ActionLink></div>
			{/if}
		{/if}
	</div>
{/if}
