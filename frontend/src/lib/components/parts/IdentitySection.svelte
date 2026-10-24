<script lang="ts">
	// Every fact about the part, always rendered; absence is a muted dash.
	import { DetailRow, DetailTable, Section, Timestamp } from '#lib/components/opal/index.js';
	import { markdown } from '#lib/markdown.js';
	import { qty, stateLabel } from '#lib/format.js';
	import type { CustomFieldDef, PartDetail } from '@opal/shared';

	let { detail, fields }: { detail: PartDetail; fields: CustomFieldDef[] } = $props();
	const part = $derived(detail.part);

	const meta = $derived(part.metadata ?? {});
	const known = $derived(new Set(fields.map((f) => f.key)));
	const extra = $derived(Object.entries(meta).filter(([k]) => !known.has(k)));

	function show(v: unknown): string | null {
		if (v === null || v === undefined || v === '' || v === false) return null;
		if (v === true) return 'YES';
		return typeof v === 'object' ? JSON.stringify(v) : String(v);
	}
</script>

<Section title="Part">
	<DetailTable>
		<DetailRow
			label="Tier"
			value={`T${part.tier}${part.tierName ? ` ${part.tierName.toUpperCase()}` : ''}`}
		/>
		<DetailRow label="Category" value={part.category} />
		<DetailRow label="UOM" value={part.unitOfMeasure.toUpperCase()} />
		<DetailRow label="Tracking" value={stateLabel(part.trackingType)} />
		<DetailRow label="Procurement" value={stateLabel(part.procurement)} />
		<DetailRow
			label="Reorder point"
			mono
			value={part.reorderPoint === null ? null : qty(part.reorderPoint)}
		/>
		<DetailRow label="Tooling" value={part.isTooling ? 'YES' : null} />
		<DetailRow
			label="Calibration"
			mono
			value={part.calibrationIntervalDays ? `${part.calibrationIntervalDays} days` : null}
		/>
		<DetailRow label="External PN" mono value={part.externalPn} />
		<DetailRow label="Description">
			{#if part.description}
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<div class="prose-opal">{@html markdown(part.description)}</div>
			{:else}<span class="text-muted-foreground">—</span>{/if}
		</DetailRow>
		{#each fields as f (f.key)}
			<DetailRow label={f.label} value={show(meta[f.key])} />
		{/each}
		{#each extra as [k, v] (k)}
			<DetailRow label={k.replace(/_/g, ' ')} value={show(v)} />
		{/each}
		<DetailRow label="Created"><Timestamp value={part.createdAt} /></DetailRow>
		<DetailRow label="Updated"><Timestamp value={part.updatedAt} /></DetailRow>
		<DetailRow label="Activated">
			{#if part.activatedAt}
				<Timestamp value={part.activatedAt} />
				{#if detail.activatedBy}<span class="ml-2">{detail.activatedBy}</span>{/if}
				{#if part.activationCause}<div class="text-xs text-muted-foreground">
						{part.activationCause}
					</div>{/if}
			{:else}<span class="text-muted-foreground">—</span>{/if}
		</DetailRow>
		<DetailRow label="Obsoleted">
			{#if part.obsoletedAt}
				<Timestamp value={part.obsoletedAt} />
				{#if part.obsoleteCause}<div class="text-xs text-muted-foreground">
						{part.obsoleteCause}
					</div>{/if}
			{:else}<span class="text-muted-foreground">—</span>{/if}
		</DetailRow>
	</DetailTable>
</Section>
