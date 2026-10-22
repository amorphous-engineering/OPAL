<script lang="ts">
	// Every fact about the part, always rendered; absence is a muted dash.
	import { DetailRow, DetailTable, Section, State, Timestamp } from '#lib/components/opal/index.js';
	import { markdown } from '#lib/markdown.js';
	import { qty, stateLabel } from '#lib/format.js';
	import type { CustomFieldDef, PartDetail } from './types.js';

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
			value={`T${part.tier}${part.tier_name ? ` ${part.tier_name.toUpperCase()}` : ''}`}
		/>
		<DetailRow label="Category" value={part.category} />
		<DetailRow label="UOM" value={part.unit_of_measure.toUpperCase()} />
		<DetailRow label="Tracking" value={stateLabel(part.tracking_type)} />
		<DetailRow label="Procurement" value={stateLabel(part.procurement)} />
		<DetailRow
			label="Reorder point"
			mono
			value={part.reorder_point === null ? null : qty(part.reorder_point)}
		/>
		<DetailRow label="Tooling" value={part.is_tooling ? 'YES' : null} />
		<DetailRow
			label="Calibration"
			mono
			value={part.calibration_interval_days ? `${part.calibration_interval_days} days` : null}
		/>
		<DetailRow label="Parent">
			{#if detail.parent}
				<a href={`/parts/${detail.parent.id}`} class="font-mono text-info hover:underline"
					>{detail.parent.internal_pn}</a
				>
				<span class="ml-1">{detail.parent.name}</span>
			{:else}<span class="text-muted-foreground">—</span>{/if}
		</DetailRow>
		<DetailRow label="External PN" mono value={part.external_pn} />
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
		{#if detail.onshape}
			<DetailRow label="Onshape">
				<a
					href={`https://cad.onshape.com/documents/${detail.onshape.document_id}`}
					target="_blank"
					rel="noopener noreferrer"
					class="text-info hover:underline">{detail.onshape.name ?? 'Open in Onshape'}</a
				>
				{#if detail.onshape.stale}<State
						value="stale"
						tone="warn"
						label="STALE"
						class="ml-2"
					/>{/if}
				{#if detail.onshape.last_synced_at}
					<span class="ml-2 text-xs text-muted-foreground"
						>synced <Timestamp value={detail.onshape.last_synced_at} /></span
					>
				{/if}
			</DetailRow>
		{/if}
		<DetailRow label="Created"><Timestamp value={part.created_at} /></DetailRow>
		<DetailRow label="Updated"><Timestamp value={part.updated_at} /></DetailRow>
		<DetailRow label="Activated">
			{#if part.activated_at}
				<Timestamp value={part.activated_at} />
				{#if detail.activated_by}<span class="ml-2">{detail.activated_by}</span>{/if}
				{#if part.activation_cause}<div class="text-xs text-muted-foreground">
						{part.activation_cause}
					</div>{/if}
			{:else}<span class="text-muted-foreground">—</span>{/if}
		</DetailRow>
	</DetailTable>
</Section>
