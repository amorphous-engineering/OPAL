import { api, ApiError } from '#lib/api.js';
import type { InventoryItem } from '#lib/components/inventory/types.js';
import type { LabelSpec } from '#lib/components/labels/types.js';
import { date, qty } from '#lib/format.js';
import type { PageLoad } from './$types';

interface LabelPart {
	id: number;
	internal_pn: string | null;
	name: string;
	unit_of_measure: string;
	tracking_type: string;
	tier: number;
	tier_name: string | null;
	lifecycle_state: string;
}

const csv = (v: string | null) =>
	(v ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * /label?inventory=OPAL-00001,OPAL-00002   stock labels
 * /label?part=12,13                         part labels
 * /label?type=part|inventory&id=12          legacy form
 */
export const load: PageLoad = async ({ fetch, url }) => {
	const client = api.using(fetch);
	const p = url.searchParams;
	const opals = csv(p.get('inventory'));
	let partIds = csv(p.get('part'));
	const legacyId = p.get('id');
	const legacyType = p.get('type');
	const legacyInventoryIds: string[] = [];
	if (legacyId && legacyType === 'part') partIds = [...partIds, legacyId];
	if (legacyId && legacyType === 'inventory') legacyInventoryIds.push(legacyId);

	const specs: LabelSpec[] = [];
	const failures: string[] = [];

	const stock = async (rec: InventoryItem) => {
		const facts = [
			rec.lot_number ? `LOT ${rec.lot_number}` : null,
			rec.location ? `LOC ${rec.location}` : null,
			Number(rec.quantity) !== 1 || rec.part_tracking_type !== 'serialized'
				? `QTY ${qty(rec.quantity, rec.part_uom)}`
				: null,
			rec.expiration_date ? `EXP ${date(rec.expiration_date)}` : null
		].filter((x): x is string => !!x);
		specs.push({
			key: `i-${rec.id}`,
			primary: rec.opal_number ?? `INV-${rec.id}`,
			secondary: rec.part_internal_pn,
			name: rec.part_name,
			facts,
			qr: `/api/inventory/${rec.id}/qrcode`
		});
	};

	// Fetch in request order so a sheet prints in the order it was asked for.
	const records = await Promise.all([
		...opals.map((o) =>
			client
				.get<InventoryItem>(`/inventory/opal/${encodeURIComponent(o)}`)
				.catch(
					(e) => (failures.push(`${o}: ${e instanceof ApiError ? e.message : 'failed'}`), null)
				)
		),
		...legacyInventoryIds.map((id) =>
			client
				.get<InventoryItem>(`/inventory/${encodeURIComponent(id)}`)
				.catch(
					(e) => (failures.push(`#${id}: ${e instanceof ApiError ? e.message : 'failed'}`), null)
				)
		)
	]);
	for (const r of records) if (r) await stock(r);

	const parts = await Promise.all(
		partIds.map((id) =>
			client
				.get<LabelPart>(`/parts/${encodeURIComponent(id)}`)
				.catch(
					(e) => (
						failures.push(`Part ${id}: ${e instanceof ApiError ? e.message : 'failed'}`),
						null
					)
				)
		)
	);
	for (const part of parts) {
		if (!part) continue;
		const tier = `T${part.tier}${part.tier_name ? ` ${part.tier_name}` : ''}`;
		specs.push({
			key: `p-${part.id}`,
			primary: part.internal_pn ?? `PART-${part.id}`,
			name: part.name,
			footer: `${tier} · ${part.unit_of_measure} · ${part.tracking_type}`,
			state: part.lifecycle_state === 'draft' ? 'DRAFT' : null,
			qr: `/api/parts/${part.id}/qrcode`
		});
	}

	return { specs, failures };
};
