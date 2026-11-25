<script lang="ts">
	// The part tag and every fact about the part, always rendered; absence is a muted dash.
	// Under EDIT this is the part's one form: each field the state still leaves in pencil turns into
	// its control where it is read (the name on the tag), the rest stay facts, and SAVE in the box
	// sends what changed. Edits are held as changes over the part, so a refresh from another section
	// (a BOM line added) keeps them, and DONE drops them.
	import { invalidateAll } from '$app/navigation';
	import {
		DetailRow,
		DetailTable,
		FormKeys,
		Section,
		Timestamp,
		confirm,
		needs,
		toast
	} from '#lib/components/opal/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { markdown } from '#lib/markdown.js';
	import { qty, stateLabel } from '#lib/format.js';
	import { opal, ApiError } from '#lib/api.js';
	import type { LotRule, PartDetail, PartSchema, Procurement, TrackingType } from '@opal/shared';
	import CustomFieldInput from './CustomFieldInput.svelte';
	import PartTag from './PartTag.svelte';
	import TierPicker from './TierPicker.svelte';
	import { editableFields, type PartField } from './editable.js';
	import { buildMetadata, metaValues, type MetaValues } from './metadata.js';

	let {
		detail,
		schema,
		qr,
		editing
	}: { detail: PartDetail; schema: PartSchema; qr: string | null; editing: boolean } = $props();
	const part = $derived(detail.part);
	const fields = $derived(schema.customFields);

	const meta = $derived(part.metadata ?? {});
	const known = $derived(new Set(fields.map((f) => f.key)));
	const extra = $derived(Object.entries(meta).filter(([k]) => !known.has(k)));

	function show(v: unknown): string | null {
		if (v === null || v === undefined || v === '' || v === false) return null;
		if (v === true) return 'YES';
		return typeof v === 'object' ? JSON.stringify(v) : String(v);
	}

	// ---------------------------------------------------------------- edit

	const can = $derived(editableFields(detail));
	/** This field is a control right now. */
	const on = (f: PartField) => editing && can.has(f);

	/** Each field as its control holds it. Text fields hold '' for null. */
	type Values = {
		name: string;
		tier: number;
		unitOfMeasure: string;
		trackingType: TrackingType;
		lotRule: LotRule;
		procurement: Procurement;
		externalPn: string;
		category: string;
		description: string;
		reorderPoint: string;
		isTooling: boolean;
		calibrationIntervalDays: string;
	};
	type Key = keyof Values;
	const base = $derived<Values>({
		name: part.name,
		tier: part.tier,
		unitOfMeasure: part.unitOfMeasure,
		trackingType: part.trackingType,
		lotRule: part.lotRule,
		procurement: part.procurement,
		externalPn: part.externalPn ?? '',
		category: part.category ?? '',
		description: part.description ?? '',
		reorderPoint: part.reorderPoint ?? '',
		isTooling: part.isTooling,
		calibrationIntervalDays: part.calibrationIntervalDays?.toString() ?? ''
	});
	let changes = $state<Partial<Values>>({});
	const val = <K extends Key>(k: K): Values[K] => (k in changes ? changes[k]! : base[k]);
	function set<K extends Key>(k: K, v: Values[K]) {
		if (v === base[k]) delete changes[k];
		else changes[k] = v;
	}

	const metaBase = $derived(metaValues(fields, part.metadata));
	let metaChanges = $state<MetaValues | null>(null);
	const metaNow = $derived(metaChanges ?? metaBase);
	const metaDirty = $derived(
		metaChanges !== null && JSON.stringify(metaChanges) !== JSON.stringify(metaBase)
	);
	function setMeta(fn: (m: MetaValues) => void) {
		const next = $state.snapshot(metaNow) as MetaValues;
		fn(next);
		metaChanges = next;
	}

	const dirty = $derived(Object.keys(changes).length > 0 || metaDirty);
	let busy = $state(false);
	let error = $state<string | null>(null);

	// DONE drops unsaved changes.
	$effect(() => {
		if (!editing) {
			changes = {};
			metaChanges = null;
			error = null;
		}
	});

	// A new tier takes a fresh number; the tag shows the one it would get.
	const tierChanged = $derived('tier' in changes);
	let preview = $state<string | null>(null);
	let seq = 0;
	$effect(() => {
		if (!tierChanged) return;
		const t = val('tier');
		const mine = ++seq;
		preview = null;
		opal.parts
			.nextPn({ tier: t })
			.then((r) => mine === seq && (preview = r.partNumber))
			.catch(() => mine === seq && (preview = null));
	});
	const tierInfo = $derived(schema.tiers.find((t) => t.level === val('tier')));

	const missing = $derived(needs({ name: val('name').trim(), unit: val('unitOfMeasure').trim() }));

	const text = (v: string) => v.trim() || null;

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!dirty || missing.length) return;
		error = null;
		const body: Parameters<typeof opal.parts.update>[0] = { id: part.id };
		const c = changes;
		if (c.name !== undefined) body.name = c.name.trim();
		if (c.tier !== undefined) body.tier = c.tier;
		if (c.unitOfMeasure !== undefined) body.unitOfMeasure = c.unitOfMeasure.trim();
		if (c.trackingType !== undefined) body.trackingType = c.trackingType;
		if (c.lotRule !== undefined) body.lotRule = c.lotRule;
		if (c.procurement !== undefined) body.procurement = c.procurement;
		if (c.externalPn !== undefined) body.externalPn = text(c.externalPn);
		if (c.category !== undefined) body.category = text(c.category);
		if (c.description !== undefined) body.description = text(c.description);
		if (c.reorderPoint !== undefined) body.reorderPoint = text(c.reorderPoint);
		if (c.isTooling !== undefined) body.isTooling = c.isTooling;
		if (c.calibrationIntervalDays !== undefined)
			body.calibrationIntervalDays = c.calibrationIntervalDays.trim()
				? Number(c.calibrationIntervalDays)
				: null;
		// Tooling off clears the interval it carried.
		if (c.isTooling === false && part.calibrationIntervalDays !== null)
			body.calibrationIntervalDays = null;
		try {
			// Metadata is checked whole, so it goes only when one of its fields changed.
			if (metaDirty && metaChanges) body.metadata = buildMetadata(fields, metaChanges);
		} catch (err) {
			error = (err as Error).message;
			return;
		}
		if (c.tier !== undefined) {
			const ok = await confirm({
				title: `Change tier to T${c.tier}`,
				body: `${part.internalPn} is abandoned permanently and never reissued. New number: ${preview ?? 'the next number'}.`,
				action: 'CHANGE TIER',
				destructive: true
			});
			if (!ok) return;
		}
		busy = true;
		try {
			await opal.parts.update(body);
			await invalidateAll();
			changes = {};
			metaChanges = null;
			toast.success('Saved');
		} catch (err) {
			error =
				err instanceof ApiError || err instanceof Error ? err.message : 'Could not save the part';
		} finally {
			busy = false;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
			(e.currentTarget as HTMLFormElement).requestSubmit();
	}

	const lotText = (r: LotRule) => (r === 'tier' ? 'AS TIER' : r.toUpperCase());
</script>

{#snippet nameField()}
	<Input
		class="h-7 font-sans text-sm"
		aria-label="Name"
		autocomplete="off"
		bind:value={() => val('name'), (v) => set('name', v)}
	/>
{/snippet}

<svelte:element
	this={editing ? 'form' : 'div'}
	class="contents"
	onsubmit={editing ? save : undefined}
	onkeydown={editing ? onkeydown : undefined}
	novalidate={editing || undefined}
>
	<PartTag
		pn={tierChanged ? preview : part.internalPn}
		name={val('name')}
		tierLevel={val('tier')}
		tierName={tierChanged ? (tierInfo?.name ?? null) : part.tierName}
		tierCode={tierChanged ? (tierInfo?.code ?? null) : detail.tierCode}
		uom={val('unitOfMeasure') || part.unitOfMeasure}
		tracking={val('trackingType')}
		state={part.state}
		{qr}
		nameField={on('name') ? nameField : undefined}
	/>

	<!-- Not clipped while editing, so SAVE can stay on screen below a box taller than the screen. -->
	<Section title="Part" class={editing ? 'overflow-visible' : undefined}>
		<DetailTable>
			<!-- The tag reads tier, unit and tracking in one line; a field among them that is still
				pencil gets its own row under EDIT, and a locked one stays on the tag alone. -->
			{#if on('tier')}
				<DetailRow label="Tier">
					<TierPicker
						tiers={schema.tiers}
						value={val('tier')}
						onchange={(t) => t !== null && set('tier', t)}
					/>
				</DetailRow>
			{/if}
			{#if on('unitOfMeasure')}
				<DetailRow label="Unit">
					<Input
						class="h-7 w-32 font-mono"
						aria-label="Unit of measure"
						bind:value={() => val('unitOfMeasure'), (v) => set('unitOfMeasure', v)}
					/>
				</DetailRow>
			{/if}
			{#if on('trackingType')}
				<DetailRow label="Tracking">
					<NativeSelect.Root
						class="h-7 w-40"
						aria-label="Tracking"
						bind:value={() => val('trackingType'), (v) => set('trackingType', v as TrackingType)}
					>
						<NativeSelect.Option value="bulk">BULK</NativeSelect.Option>
						<NativeSelect.Option value="serialized">SERIALIZED</NativeSelect.Option>
					</NativeSelect.Root>
				</DetailRow>
			{/if}
			<DetailRow label="Category">
				{#if on('category')}
					<Input
						class="h-7"
						aria-label="Category"
						list="part-categories"
						autocomplete="off"
						bind:value={() => val('category'), (v) => set('category', v)}
					/>
					<datalist id="part-categories">
						{#each schema.categories as cat (cat)}<option value={cat}></option>{/each}
					</datalist>
				{:else if part.category}{part.category}{:else}<span class="text-quiet">—</span>{/if}
			</DetailRow>
			<DetailRow label="Procurement">
				{#if on('procurement')}
					<NativeSelect.Root
						class="h-7 w-40"
						aria-label="Procurement"
						bind:value={() => val('procurement'), (v) => set('procurement', v as Procurement)}
					>
						<NativeSelect.Option value="make">MAKE</NativeSelect.Option>
						<NativeSelect.Option value="buy">BUY</NativeSelect.Option>
						<NativeSelect.Option value="both">BOTH</NativeSelect.Option>
					</NativeSelect.Root>
				{:else}{stateLabel(part.procurement)}{/if}
			</DetailRow>
			<DetailRow label="Reorder point" mono>
				{#if on('reorderPoint')}
					<Input
						class="h-7 w-32 font-mono"
						aria-label="Reorder point"
						inputmode="decimal"
						bind:value={() => val('reorderPoint'), (v) => set('reorderPoint', v)}
					/>
				{:else if part.reorderPoint !== null}{qty(part.reorderPoint)}{:else}<span class="text-quiet"
						>—</span
					>{/if}
			</DetailRow>
			{#if val('trackingType') === 'bulk'}
				<DetailRow label="Supplier lot">
					{#if on('lotRule')}
						<NativeSelect.Root
							class="h-7 w-48"
							aria-label="Supplier lot"
							bind:value={() => val('lotRule'), (v) => set('lotRule', v as LotRule)}
						>
							<NativeSelect.Option value="tier"
								>AS TIER{tierInfo
									? tierInfo.requireLot
										? ' (REQUIRED)'
										: ' (NONE)'
									: ''}</NativeSelect.Option
							>
							<NativeSelect.Option value="required">REQUIRED</NativeSelect.Option>
							<NativeSelect.Option value="none">NONE</NativeSelect.Option>
						</NativeSelect.Root>
					{:else}{lotText(part.lotRule)}{/if}
				</DetailRow>
			{/if}
			<DetailRow label="Tooling">
				{#if on('isTooling')}
					<Checkbox
						aria-label="Tooling"
						bind:checked={() => val('isTooling'), (v) => set('isTooling', v)}
					/>
				{:else if part.isTooling}YES{:else}<span class="text-quiet">—</span>{/if}
			</DetailRow>
			{#if on('calibrationIntervalDays') && val('isTooling')}
				<DetailRow label="Calibration">
					<span class="inline-flex items-center gap-2">
						<Input
							class="h-7 w-24 font-mono"
							aria-label="Calibration interval (days)"
							type="number"
							min="1"
							step="1"
							bind:value={
								() => val('calibrationIntervalDays'),
								(v) => set('calibrationIntervalDays', v == null ? '' : String(v))
							}
						/>
						<span class="text-xs text-muted-foreground">days</span>
					</span>
				</DetailRow>
			{:else}
				<DetailRow
					label="Calibration"
					mono
					value={part.calibrationIntervalDays ? `${part.calibrationIntervalDays} days` : null}
				/>
			{/if}
			<DetailRow label="External PN" mono>
				{#if on('externalPn')}
					<Input
						class="h-7 font-mono"
						aria-label="External PN"
						autocomplete="off"
						bind:value={() => val('externalPn'), (v) => set('externalPn', v)}
					/>
				{:else if part.externalPn}{part.externalPn}{:else}<span class="text-quiet">—</span>{/if}
			</DetailRow>
			<DetailRow label="Description">
				{#if on('description')}
					<MarkdownField
						ariaLabel="Description"
						minRows={4}
						bind:value={() => val('description'), (v) => set('description', v)}
					/>
				{:else if part.description}
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					<div class="prose-opal">{@html markdown(part.description)}</div>
				{:else}<span class="text-quiet">—</span>{/if}
			</DetailRow>
			{#each fields as f (f.key)}
				<DetailRow label={f.label}>
					{#if on('metadata')}
						<CustomFieldInput
							field={f}
							id={`cf-${f.key}`}
							class="h-7"
							bind:text={
								() => metaNow.text[f.key] ?? '', (v) => setMeta((m) => (m.text[f.key] = v ?? ''))
							}
							bind:checked={
								() => metaNow.bool[f.key] ?? false, (v) => setMeta((m) => (m.bool[f.key] = v))
							}
						/>
					{:else if show(meta[f.key])}{show(meta[f.key])}{:else}<span class="text-quiet">—</span
						>{/if}
				</DetailRow>
			{/each}
			{#if on('metadata')}
				<DetailRow label="Other metadata">
					<Textarea
						class="font-mono"
						aria-label="Other metadata (JSON)"
						rows={2}
						spellcheck={false}
						bind:value={() => metaNow.extra, (v) => setMeta((m) => (m.extra = v))}
					/>
				</DetailRow>
			{:else}
				{#each extra as [k, v] (k)}
					<DetailRow label={k.replace(/_/g, ' ')} value={show(v)} />
				{/each}
			{/if}
			<DetailRow label="Created"><Timestamp value={part.createdAt} /></DetailRow>
			<DetailRow label="Updated"><Timestamp value={part.updatedAt} /></DetailRow>
			<DetailRow label="Activated">
				{#if part.activatedAt}
					<Timestamp value={part.activatedAt} />
					{#if detail.activatedBy}<span class="ml-2">{detail.activatedBy}</span>{/if}
					{#if part.activationCause}<div class="text-xs text-muted-foreground">
							{part.activationCause}
						</div>{/if}
				{:else}<span class="text-quiet">—</span>{/if}
			</DetailRow>
			<DetailRow label="Obsoleted">
				{#if part.obsoletedAt}
					<Timestamp value={part.obsoletedAt} />
					{#if part.obsoleteCause}<div class="text-xs text-muted-foreground">
							{part.obsoleteCause}
						</div>{/if}
				{:else}<span class="text-quiet">—</span>{/if}
			</DetailRow>
		</DetailTable>
		{#if editing && (dirty || error)}
			<FormKeys
				sticky
				class="mx-0 bg-card px-3 py-3"
				submit={busy ? 'SAVING' : 'SAVE'}
				{missing}
				{busy}
				{error}
			/>
		{/if}
	</Section>
</svelte:element>
