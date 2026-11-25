<script lang="ts">
	// The form for a part that does not exist yet: create and variant share it. An existing part
	// is edited in place on its own page (IdentitySection). A variant keeps the source's tier and
	// takes the family's next number, so both render as facts.
	import { goto } from '$app/navigation';
	import {
		Section,
		DetailRow,
		DetailTable,
		toast,
		FormKeys,
		needs
	} from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { MarkdownField } from '#lib/components/markdown/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { opal, ApiError } from '#lib/api.js';
	import type {
		Part,
		PartCreate,
		PartSchema,
		Procurement,
		SchemaTier,
		TrackingType,
		LotRule,
		VariantBom
	} from '@opal/shared';
	import { Field as FormField } from '#lib/components/opal/index.js';
	import CustomFieldInput from './CustomFieldInput.svelte';
	import PartPicker from './PartPicker.svelte';
	import PartTag from './PartTag.svelte';
	import TierPicker from './TierPicker.svelte';
	import { buildMetadata, metaValues } from './metadata.js';
	import { partQr } from './qr.js';
	import { untrack } from 'svelte';
	import type { PartRef } from './types.js';

	let {
		schema,
		assembly: initialAssembly = null,
		tier: initialTier = null,
		variantOf = null,
		nextNumber = null
	}: {
		schema: PartSchema;
		assembly?: PartRef | null;
		tier?: number | null;
		/** Variant mode: the new part copies this one. */
		variantOf?: Part | null;
		/** The number the variant takes, from the server. */
		nextNumber?: string | null;
	} = $props();
	// The form is mounted once per page (keyed by part), so props seed local state on purpose.
	const src = untrack(() => variantOf);
	const variantPn = untrack(() => nextNumber);
	const variantMode = src !== null;
	// A variant's fields start from its source.
	const s0: Part | null = src;
	const schema0 = untrack(() => schema);
	const iAssembly = untrack(() => initialAssembly);
	const iTier = untrack(() => initialTier);

	let tier = $state<number | null>(s0?.tier ?? iTier);
	let name = $state(s0?.name ?? '');
	let externalPn = $state(s0?.externalPn ?? '');
	let procurement = $state<Procurement>(s0?.procurement ?? 'make');
	let procurementTouched = $state(variantMode);
	let tracking = $state<TrackingType>(s0?.trackingType ?? 'bulk');
	let lotRule = $state<LotRule>(s0?.lotRule ?? 'tier');
	let trackingTouched = $state(variantMode);
	let category = $state(s0?.category ?? '');
	let uom = $state(s0?.unitOfMeasure ?? 'ea');
	let reorder = $state(s0?.reorderPoint ?? '');
	let tooling = $state(s0?.isTooling ?? false);
	let calibration = $state(s0?.calibrationIntervalDays?.toString() ?? '');
	let bom = $state<VariantBom>('source');
	const BOM_CHOICES: [VariantBom, string][] = [
		['source', 'SOURCE PART'],
		['copy', 'COPY BOM'],
		['empty', 'EMPTY']
	];
	let assembly = $state<PartRef | null>(iAssembly);
	let assemblyQty = $state('1');
	let description = $state(s0?.description ?? '');
	// The schema's defaults fill a new part; a variant keeps its source's values.
	let metaVals = $state(metaValues(schema0.customFields, s0?.metadata ?? null, (f) => f.default));

	let preview = $state<{ partNumber: string; tier: number } | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let seq = 0;
	let qr = $state<string | null>(null);

	const tierInfo = $derived<SchemaTier | undefined>(schema0.tiers.find((t) => t.level === tier));

	// Tier drives the numbering preview and the tracking default.
	$effect(() => {
		const t = tier;
		if (t === null || variantMode) return;
		const mine = ++seq;
		opal.parts
			.nextPn({ tier: t })
			.then((r) => {
				if (mine !== seq) return;
				preview = { partNumber: r.partNumber, tier: t };
				if (!trackingTouched) tracking = r.defaultTracking;
			})
			.catch(() => {
				if (mine === seq) preview = null;
			});
	});

	if (src) partQr(src.id).then((u) => (qr = u));

	const shownPn = $derived(variantMode ? (variantPn ?? '') : (preview?.partNumber ?? ''));

	function onExternalInput() {
		if (!procurementTouched) procurement = externalPn.trim() ? 'buy' : 'make';
	}

	const missing = $derived(needs({ tier: tier !== null, name: name.trim() }));

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (tier === null) return (error = 'Select a tier');
		if (!name.trim()) return (error = 'Name is required');
		busy = true;
		try {
			const fields = {
				externalPn: externalPn.trim() || null,
				description: description.trim() || null,
				category: category.trim() || null,
				unitOfMeasure: uom.trim() || 'ea',
				trackingType: tracking,
				lotRule,
				procurement,
				reorderPoint: String(reorder).trim() === '' ? null : String(reorder).trim(),
				isTooling: tooling,
				calibrationIntervalDays: tooling && calibration.trim() ? Number(calibration) : null,
				metadata: buildMetadata(schema0.customFields, metaVals)
			};
			if (variantMode) {
				const created = await opal.parts.variants.create({
					...fields,
					id: src!.id,
					name: name.trim(),
					bom
				});
				toast.success(`${created.internalPn} created as draft`);
				await goto(`/parts/${created.id}`);
				return;
			}
			const body: PartCreate = { ...fields, name: name.trim(), tier };
			if (assembly) {
				body.assemblyId = assembly.id;
				body.assemblyQuantity = assemblyQty.trim() || '1';
			}
			const created = await opal.parts.create(body);
			toast.success(`${created.internalPn} created as draft`);
			await goto(`/parts/${created.id}`);
		} catch (err) {
			error =
				err instanceof ApiError || err instanceof Error ? err.message : 'Could not save the part';
		} finally {
			busy = false;
		}
	}

	function cancel() {
		if (history.length > 1) history.back();
		else goto(variantMode ? `/parts/${src!.id}` : '/parts');
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
			(e.currentTarget as HTMLFormElement).requestSubmit();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
	class="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,48rem)_24rem]"
	onsubmit={submit}
	{onkeydown}
	novalidate
>
	<div class="grid min-w-0 grid-cols-1 content-start gap-4">
		<Section title="Identity">
			<div class="grid grid-cols-1 gap-4 p-3">
				{#if variantMode}
					<DetailTable>
						<DetailRow label="Internal PN" value={variantPn} mono />
						<DetailRow
							label="Tier"
							value={`T${src?.tier}${src?.tierName ? ` ${src.tierName.toUpperCase()}` : ''}`}
						/>
						<DetailRow label="Source" value={src?.internalPn} mono />
					</DetailTable>
					<FormField label="Name" for="pf-name" required>
						<Input id="pf-name" bind:value={name} required />
					</FormField>
				{:else}
					<FormField label="Tier" required>
						<TierPicker tiers={schema.tiers} value={tier} onchange={(t) => (tier = t)} />
					</FormField>
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<FormField label="Internal PN" for="pf-pn">
							<Input
								id="pf-pn"
								class="font-mono"
								value={shownPn}
								readonly
								placeholder="Select a tier"
							/>
						</FormField>
						<FormField label="Name" for="pf-name" required>
							<Input id="pf-name" bind:value={name} required />
						</FormField>
					</div>
				{/if}
				<FormField label="External PN" for="pf-ext">
					<Input
						id="pf-ext"
						class="font-mono"
						bind:value={externalPn}
						oninput={onExternalInput}
						autocomplete="off"
					/>
				</FormField>
			</div>
		</Section>

		<Section title="Procurement and stock">
			<div class="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
				<FormField label="Procurement" for="pf-proc">
					<NativeSelect.Root
						id="pf-proc"
						class="w-full"
						bind:value={procurement}
						onchange={() => (procurementTouched = true)}
					>
						<NativeSelect.Option value="make">MAKE</NativeSelect.Option>
						<NativeSelect.Option value="buy">BUY</NativeSelect.Option>
						<NativeSelect.Option value="both">BOTH</NativeSelect.Option>
					</NativeSelect.Root>
				</FormField>
				<FormField label="Tracking" for="pf-tracking">
					<NativeSelect.Root
						id="pf-tracking"
						class="w-full"
						bind:value={tracking}
						onchange={() => (trackingTouched = true)}
					>
						<NativeSelect.Option value="bulk">BULK</NativeSelect.Option>
						<NativeSelect.Option value="serialized">SERIALIZED</NativeSelect.Option>
					</NativeSelect.Root>
				</FormField>
				{#if tracking === 'bulk'}
					<FormField label="Supplier lot" for="pf-lot">
						<NativeSelect.Root id="pf-lot" class="w-full" bind:value={lotRule}>
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
					</FormField>
				{/if}
				<FormField label="Category" for="pf-category">
					<Input id="pf-category" bind:value={category} list="pf-categories" autocomplete="off" />
					<datalist id="pf-categories">
						{#each schema.categories as c (c)}<option value={c}></option>{/each}
					</datalist>
				</FormField>
				<FormField label="Unit of measure" for="pf-uom">
					<Input id="pf-uom" bind:value={uom} class="font-mono" />
				</FormField>
				<FormField label="Reorder point" for="pf-reorder">
					<Input id="pf-reorder" class="font-mono" inputmode="decimal" bind:value={reorder} />
				</FormField>
			</div>
		</Section>

		<Section title="Structure and tooling">
			<div class="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
				{#if variantMode}
					<FormField label="BOM" class="sm:col-span-2">
						<div class="flex flex-wrap gap-1.5" role="group" aria-label="BOM">
							{#each BOM_CHOICES as [value, label] (value)}
								<Button
									type="button"
									size="sm"
									variant="outline"
									aria-pressed={bom === value}
									onclick={() => (bom = value)}>{label}</Button
								>
							{/each}
						</div>
					</FormField>
				{:else}
					<FormField label="Add to assembly" for="pf-assembly">
						<PartPicker id="pf-assembly" bind:value={assembly} placeholder="None" clearable />
					</FormField>
					{#if assembly}
						<FormField label="Quantity in assembly" for="pf-asm-qty">
							<Input
								id="pf-asm-qty"
								class="font-mono"
								inputmode="decimal"
								bind:value={assemblyQty}
							/>
						</FormField>
					{/if}
				{/if}
				<div class="flex items-center gap-2 sm:col-span-2">
					<Checkbox id="pf-tooling" bind:checked={tooling} />
					<Label for="pf-tooling">Tooling</Label>
				</div>
				{#if tooling}
					<FormField label="Calibration interval (days)" for="pf-cal">
						<Input id="pf-cal" type="number" min="1" step="1" bind:value={calibration} />
					</FormField>
				{/if}
			</div>
		</Section>

		<Section title="Description">
			<div class="p-3">
				<MarkdownField
					id="pf-description"
					ariaLabel="Description"
					bind:value={description}
					minRows={4}
				/>
			</div>
		</Section>

		<Section title={schema.customFields.length ? 'Custom fields' : 'Metadata'}>
			<div class="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
				{#each schema.customFields as f (f.key)}
					{#if f.type === 'boolean'}
						<div class="flex items-center gap-2">
							<CustomFieldInput field={f} id={`cf-${f.key}`} bind:checked={metaVals.bool[f.key]} />
							<Label for={`cf-${f.key}`}>{f.label}</Label>
						</div>
					{:else}
						<FormField label={f.label} for={`cf-${f.key}`} required={f.required}>
							<CustomFieldInput field={f} id={`cf-${f.key}`} bind:text={metaVals.text[f.key]} />
						</FormField>
					{/if}
				{/each}
				<FormField label="Other metadata (JSON)" for="pf-meta" class="sm:col-span-2">
					<Textarea
						id="pf-meta"
						class="font-mono"
						rows={2}
						bind:value={metaVals.extra}
						spellcheck={false}
					/>
				</FormField>
			</div>
		</Section>

		<FormKeys sticky submit={busy ? 'SAVING' : 'CREATE'} {cancel} {missing} {busy} {error} />
	</div>

	<aside class="min-w-0 xl:sticky xl:top-3 xl:self-start">
		<PartTag
			pn={shownPn || null}
			{name}
			tierLevel={tier}
			tierName={tierInfo?.name ?? null}
			tierCode={tierInfo?.code ?? null}
			{uom}
			{tracking}
			state="draft"
			{qr}
		/>
	</aside>
</form>
