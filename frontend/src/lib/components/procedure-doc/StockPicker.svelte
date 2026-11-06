<script lang="ts" module>
	export interface StockOption {
		id: number;
		opal_number: string | null;
		location: string;
		lot_number: string | null;
		quantity: number | string;
		uom: string | null;
	}
</script>

<script lang="ts">
	// SOURCE for a part: a search over its stock on hand, given oldest first. A part can have more
	// records than any dropdown holds, so this searches by OPAL number, location or lot.
	import { EntityPicker, type PickerOption } from '#lib/components/opal/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { qtyUnit } from '#lib/format.js';

	let {
		records,
		value,
		label,
		onpick
	}: {
		/** Undefined while loading. */
		records: StockOption[] | undefined;
		value: string;
		label: string;
		onpick: (id: string) => void;
	} = $props();

	const facts = (r: StockOption) =>
		[r.location, qtyUnit(r.quantity, r.uom), r.lot_number].filter(Boolean).join(' · ');
	const current = $derived(records?.find((r) => String(r.id) === value));

	async function search(q: string): Promise<PickerOption[]> {
		const term = q.trim().toLowerCase();
		return (records ?? [])
			.filter(
				(r) =>
					!term ||
					[r.opal_number, r.location, r.lot_number].some((x) => x?.toLowerCase().includes(term))
			)
			.map((r) => ({ value: r.id, label: r.opal_number ?? '—', sub: facts(r) }));
	}
</script>

{#if !records}
	<span class="text-xs text-muted-foreground">Loading…</span>
{:else if !records.length}
	<span class="font-mono text-xs text-warn">No stock</span>
{:else}
	<EntityPicker
		{search}
		{label}
		placeholder="OPAL number, location or lot"
		onpick={(o) => onpick(String(o.value))}
	>
		{#snippet trigger({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				class="w-full min-w-48 justify-start font-mono"
				aria-label={label}
			>
				<span class="truncate"
					>{current ? `${current.opal_number ?? '—'} · ${facts(current)}` : 'SELECT'}</span
				>
			</Button>
		{/snippet}
	</EntityPicker>
{/if}
