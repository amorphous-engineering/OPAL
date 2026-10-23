<script lang="ts">
	// The one part form: create and edit share it. Identity (tier, PN) is
	// mutable only while the part is a draft; once active it renders as facts.
	import { goto } from '$app/navigation';
	import { Section, DetailRow, DetailTable, confirm, toast } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { api, ApiError } from '#lib/api.js';
	import { stateLabel } from '#lib/format.js';
	import FormField from './FormField.svelte';
	import PartPicker from './PartPicker.svelte';
	import PartTag from './PartTag.svelte';
	import { untrack } from 'svelte';
	import type { Part, PartRef, PartSchema, Procurement, SchemaTier, Tracking } from './types.js';

	let {
		schema,
		part = null,
		parent: initialParent = null,
		tier: initialTier = null
	}: {
		schema: PartSchema;
		part?: Part | null;
		parent?: PartRef | null;
		tier?: number | null;
	} = $props();
	// The form is mounted once per page (keyed by part), so props seed local state on purpose.
	const p0 = untrack(() => part);
	const schema0 = untrack(() => schema);
	const iParent = untrack(() => initialParent);
	const iTier = untrack(() => initialTier);

	// The form is mounted once per page, so props seed local state on purpose.
	const editing = p0 !== null;
	const draft = !p0 || p0.lifecycle_state === 'draft';
	const knownKeys = new Set(schema0.custom_fields.map((f) => f.key));
	const existingMeta = p0?.metadata ?? {};

	let tier = $state<number | null>(p0?.tier ?? iTier);
	let name = $state(p0?.name ?? '');
	let pn = $state(p0?.internal_pn ?? '');
	let pnEdited = $state(false);
	let externalPn = $state(p0?.external_pn ?? '');
	let procurement = $state<Procurement>(p0?.procurement ?? 'make');
	let procurementTouched = $state(editing);
	let tracking = $state<Tracking>(p0?.tracking_type ?? 'bulk');
	let trackingTouched = $state(editing);
	let category = $state(p0?.category ?? '');
	let uom = $state(p0?.unit_of_measure ?? 'ea');
	let reorder = $state(p0?.reorder_point != null ? String(Number(p0.reorder_point)) : '');
	let tooling = $state(p0?.is_tooling ?? false);
	let calibration = $state(p0?.calibration_interval_days?.toString() ?? '');
	let parent = $state<PartRef | null>(iParent);
	let description = $state(p0?.description ?? '');
	const seed = (key: string, fallback: unknown) => existingMeta[key] ?? fallback ?? '';
	let customText = $state<Record<string, string>>(
		Object.fromEntries(
			schema0.custom_fields
				.filter((f) => f.type !== 'boolean')
				.map((f) => [f.key, String(seed(f.key, f.default))])
		)
	);
	let customBool = $state<Record<string, boolean>>(
		Object.fromEntries(
			schema0.custom_fields
				.filter((f) => f.type === 'boolean')
				.map((f) => [f.key, Boolean(seed(f.key, f.default))])
		)
	);
	let extraJson = $state(
		(() => {
			const extra = Object.fromEntries(
				Object.entries(existingMeta).filter(([k]) => !knownKeys.has(k))
			);
			return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '';
		})()
	);

	let preview = $state<{ part_number: string; tier: number } | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let seq = 0;

	const tierInfo = $derived<SchemaTier | undefined>(schema0.tiers.find((t) => t.level === tier));
	const originalTier = p0?.tier ?? null;
	const tierChanged = $derived(editing && draft && tier !== originalTier);

	// Tier drives the numbering preview and the tracking default.
	$effect(() => {
		const t = tier;
		if (t === null || !draft) return;
		const mine = ++seq;
		api
			.get<{ part_number: string; default_tracking: Tracking }>('/parts/next-pn', { tier: t })
			.then((r) => {
				if (mine !== seq) return;
				preview = { part_number: r.part_number, tier: t };
				if (!trackingTouched) tracking = r.default_tracking;
			})
			.catch(() => {
				if (mine === seq) preview = null;
			});
	});

	$effect(() => {
		if (editing && draft && !pnEdited) pn = tierChanged ? '' : (p0?.internal_pn ?? '');
	});

	const shownPn = $derived(
		editing && !tierChanged
			? (p0?.internal_pn ?? '')
			: pnEdited && pn.trim()
				? pn.trim()
				: (preview?.part_number ?? '')
	);

	function onExternalInput() {
		if (!procurementTouched && !editing) procurement = externalPn.trim() ? 'buy' : 'make';
	}

	function buildMetadata(): Record<string, unknown> | null {
		let meta: Record<string, unknown> = {};
		if (extraJson.trim()) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(extraJson);
			} catch {
				throw new Error('Other metadata is not valid JSON');
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				throw new Error('Other metadata must be a JSON object');
			meta = parsed as Record<string, unknown>;
		}
		for (const f of schema0.custom_fields) {
			const v = customText[f.key];
			if (f.type === 'boolean') {
				if (customBool[f.key]) meta[f.key] = true;
			} else if (v !== '' && v !== undefined) {
				meta[f.key] = f.type === 'number' ? Number(v) : v;
			} else if (f.required) {
				throw new Error(`${f.label} is required`);
			}
		}
		return Object.keys(meta).length ? meta : null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (tier === null) return (error = 'Select a tier');
		if (!name.trim()) return (error = 'Name is required');
		busy = true;
		try {
			const body: Record<string, unknown> = {
				external_pn: externalPn.trim() || null,
				description: description.trim() || null,
				category: category.trim() || null,
				unit_of_measure: uom.trim() || 'ea',
				tracking_type: tracking,
				procurement,
				parent_id: parent?.id ?? null,
				reorder_point: reorder.trim() === '' ? null : Number(reorder),
				is_tooling: tooling,
				calibration_interval_days: tooling && calibration.trim() ? Number(calibration) : null,
				metadata: buildMetadata()
			};
			if (!editing) {
				body.name = name.trim();
				body.tier = tier;
				if (pnEdited && pn.trim()) body.internal_pn = pn.trim();
				const created = await api.post<Part>('/parts', body);
				toast.success(`${created.internal_pn} created as draft`);
				await goto(`/parts/${created.id}`);
				return;
			}
			if (name.trim() !== p0!.name) body.name = name.trim();
			if (draft) {
				if (tierChanged) {
					const next =
						pnEdited && pn.trim() ? pn.trim() : (preview?.part_number ?? 'the next number');
					const ok = await confirm({
						title: `Change tier to T${tier}`,
						body: `${p0!.internal_pn} is abandoned permanently and never reissued. New number: ${next}.`,
						action: 'CHANGE TIER',
						destructive: true
					});
					if (!ok) return;
					body.tier = tier;
				}
				if (pnEdited && pn.trim() && pn.trim() !== p0!.internal_pn) body.internal_pn = pn.trim();
			}
			await api.patch<Part>(`/parts/${p0!.id}`, body);
			toast.success('Saved');
			await goto(`/parts/${p0!.id}`);
		} catch (err) {
			error =
				err instanceof ApiError || err instanceof Error ? err.message : 'Could not save the part';
		} finally {
			busy = false;
		}
	}

	function cancel() {
		if (history.length > 1) history.back();
		else goto(editing ? `/parts/${p0!.id}` : '/parts');
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
		{#if error}
			<p
				role="alert"
				class="border border-error/40 bg-error-muted px-3 py-2 font-mono text-xs text-error"
			>
				{error}
			</p>
		{/if}

		<Section title="Identity">
			<div class="grid grid-cols-1 gap-4 p-3">
				{#if draft}
					<FormField label="Tier" required>
						{#if schema.tiers.length > 5}
							<NativeSelect.Root
								size="sm"
								aria-label="Tier"
								value={tier === null ? '' : String(tier)}
								onchange={(e) =>
									(tier = e.currentTarget.value ? Number(e.currentTarget.value) : null)}
							>
								<NativeSelect.Option value="">Select tier</NativeSelect.Option>
								{#each schema.tiers as t (t.level)}
									<NativeSelect.Option value={String(t.level)}
										>T{t.level} {t.name.toUpperCase()}</NativeSelect.Option
									>
								{/each}
							</NativeSelect.Root>
						{:else}
							<div class="flex flex-wrap gap-1.5" role="group" aria-label="Tier">
								{#each schema.tiers as t (t.level)}
									<Button
										type="button"
										size="sm"
										variant={tier === t.level ? 'default' : 'outline'}
										aria-pressed={tier === t.level}
										onclick={() => (tier = t.level)}>T{t.level} {t.name.toUpperCase()}</Button
									>
								{/each}
							</div>
						{/if}
						{#if tierInfo}
							<p class="font-mono text-xs text-muted-foreground">
								{tierInfo.default_tracking.toUpperCase()} default{tierInfo.require_lot
									? ' · LOT REQUIRED'
									: ''}{tierInfo.auto_serial ? ' · AUTO SERIAL' : ''}
							</p>
						{/if}
					</FormField>
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<FormField label="Internal PN" for="pf-pn">
							<Input
								id="pf-pn"
								class="font-mono"
								bind:value={pn}
								oninput={() => (pnEdited = true)}
								placeholder={preview && !(editing && !tierChanged)
									? preview.part_number
									: (p0?.internal_pn ?? 'Select a tier')}
								autocomplete="off"
								spellcheck="false"
							/>
						</FormField>
						<FormField label="Name" for="pf-name" required>
							<Input id="pf-name" bind:value={name} required />
						</FormField>
					</div>
				{:else}
					<DetailTable>
						<DetailRow label="Internal PN" value={p0?.internal_pn} mono />
						<DetailRow
							label="Tier"
							value={`T${p0?.tier}${p0?.tier_name ? ` ${p0.tier_name.toUpperCase()}` : ''}`}
						/>
						<DetailRow label="State" value={stateLabel(p0?.lifecycle_state)} />
					</DetailTable>
					<FormField label="Name" for="pf-name" required>
						<Input id="pf-name" bind:value={name} required />
					</FormField>
				{/if}
				<FormField label="External PN" for="pf-ext">
					<Input
						id="pf-ext"
						class="font-mono"
						bind:value={externalPn}
						oninput={onExternalInput}
						placeholder="Vendor PN or CAD designator"
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
						size="sm"
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
						size="sm"
						class="w-full"
						bind:value={tracking}
						onchange={() => (trackingTouched = true)}
					>
						<NativeSelect.Option value="bulk">BULK</NativeSelect.Option>
						<NativeSelect.Option value="serialized">SERIALIZED</NativeSelect.Option>
					</NativeSelect.Root>
				</FormField>
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
					<Input id="pf-reorder" type="number" min="0" step="any" bind:value={reorder} />
				</FormField>
			</div>
		</Section>

		<Section title="Structure and tooling">
			<div class="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
				<FormField label="Parent assembly" for="pf-parent" class="sm:col-span-2">
					<PartPicker
						id="pf-parent"
						bind:value={parent}
						exclude={p0 ? [p0.id] : []}
						placeholder="None"
						clearable
					/>
				</FormField>
				<div class="flex items-center gap-2 sm:col-span-2">
					<Checkbox id="pf-tooling" bind:checked={tooling} />
					<Label for="pf-tooling" class="label">Tooling</Label>
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
				<Textarea
					id="pf-description"
					aria-label="Description"
					bind:value={description}
					placeholder="Markdown"
					rows={4}
				/>
			</div>
		</Section>

		<Section title={schema.custom_fields.length ? 'Custom fields' : 'Metadata'}>
			<div class="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
				{#each schema.custom_fields as f (f.key)}
					{#if f.type === 'boolean'}
						<div class="flex items-center gap-2">
							<Checkbox id={`cf-${f.key}`} bind:checked={customBool[f.key]} />
							<Label for={`cf-${f.key}`} class="label">{f.label}</Label>
						</div>
					{:else if f.type === 'select'}
						<FormField label={f.label} for={`cf-${f.key}`} required={f.required}>
							<NativeSelect.Root
								id={`cf-${f.key}`}
								size="sm"
								class="w-full"
								bind:value={customText[f.key]}
							>
								<NativeSelect.Option value="">—</NativeSelect.Option>
								{#each f.options as o (o)}<NativeSelect.Option value={o}>{o}</NativeSelect.Option
									>{/each}
							</NativeSelect.Root>
						</FormField>
					{:else}
						<FormField label={f.label} for={`cf-${f.key}`} required={f.required}>
							<Input
								id={`cf-${f.key}`}
								type={f.type === 'number' ? 'number' : 'text'}
								step="any"
								bind:value={customText[f.key]}
							/>
						</FormField>
					{/if}
				{/each}
				<FormField label="Other metadata (JSON)" for="pf-meta" class="sm:col-span-2">
					<Textarea
						id="pf-meta"
						class="font-mono"
						rows={2}
						bind:value={extraJson}
						spellcheck={false}
					/>
				</FormField>
			</div>
		</Section>

		<div
			class="sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t border-border bg-background px-4 py-2"
		>
			<Button type="button" variant="outline" onclick={cancel} disabled={busy}>CANCEL</Button>
			<Button type="submit" disabled={busy}
				>{busy ? 'SAVING' : editing ? 'SAVE' : 'CREATE DRAFT'}</Button
			>
		</div>
	</div>

	<aside class="min-w-0 xl:sticky xl:top-14 xl:self-start">
		<PartTag
			pn={shownPn || null}
			{name}
			tierLevel={tier}
			tierName={tierInfo?.name ?? null}
			tierCode={tierInfo?.code ?? null}
			{uom}
			{tracking}
			state={p0?.lifecycle_state ?? 'draft'}
			qr={p0 ? `/api/parts/${p0.id}/qrcode` : null}
		/>
	</aside>
</form>
