import { ApiError, opal } from '#lib/api.js';
import type { LabelSpec } from '#lib/components/labels/types.js';
import { date, qty } from '#lib/format.js';
import type { StockLabel } from '@opal/shared';
import type { PageLoad } from './$types';

const svgUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

function spec(l: StockLabel): LabelSpec {
	if (l.kind === 'part') {
		const tier = l.tier === null ? '' : `T${l.tier}${l.tierName ? ` ${l.tierName}` : ''}`;
		return {
			key: l.key,
			primary: l.primary,
			name: l.name,
			footer: [tier, l.unitOfMeasure, l.trackingType].filter(Boolean).join(' · '),
			state: l.partState === 'draft' ? 'DRAFT' : null,
			qr: svgUri(l.qrSvg)
		};
	}
	const serialUnit = l.trackingType === 'serialized' && Number(l.balance) === 1;
	const facts = [
		l.serialNumber ? `SN ${l.serialNumber}` : null,
		l.lotNumber ? `LOT ${l.lotNumber}` : null,
		l.location ? `LOC ${l.location}` : null,
		serialUnit ? null : `QTY ${qty(l.balance, l.unitOfMeasure)}`,
		l.expirationDate ? `EXP ${date(l.expirationDate)}` : null
	].filter((x): x is string => !!x);
	return {
		key: l.key,
		primary: l.primary,
		secondary: l.secondary,
		name: l.name,
		facts,
		qr: svgUri(l.qrSvg)
	};
}

/**
 * /label?inventory=OPAL-00001,OPAL-00002   stock labels
 * /label?part=12,13                         part labels
 */
export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const inventory = p.get('inventory') ?? undefined;
	const part = p.get('part') ?? undefined;
	if (!inventory && !part) return { specs: [] as LabelSpec[], failures: [] as string[] };
	try {
		const r = await opal.using(fetch).inventory.labels({ inventory, part, origin: url.origin });
		return { specs: r.labels.map(spec), failures: r.failures };
	} catch (e) {
		return {
			specs: [] as LabelSpec[],
			failures: [e instanceof ApiError || e instanceof Error ? e.message : 'Could not load labels']
		};
	}
};
