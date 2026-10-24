/** Label data: what the print page needs, with the QR code drawn as SVG. */
import type { StockLabel } from '@opal/shared';
import { eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { Ctx } from '../../context.ts';
import { part } from '../../db/schema/index.ts';
import { getProjectConfig, getTier } from '../org/project.ts';
import { getStockByOpal } from './records.ts';

type DbCtx = Pick<Ctx, 'db'>;

const csv = (v: string | undefined) =>
	(v ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

export function qrSvg(text: string): Promise<string> {
	return QRCode.toString(text, { type: 'svg', margin: 1 });
}

/** The address a stock QR code opens. Without an origin the path alone is encoded. */
export function stockUrl(opalNumber: string, origin = ''): string {
	return `${origin.replace(/\/$/, '')}/inventory/opal/${opalNumber}`;
}

export async function stockLabel(ctx: DbCtx, opalNumber: string, origin = ''): Promise<StockLabel> {
	const r = getStockByOpal(ctx, opalNumber);
	const url = stockUrl(opalNumber, origin);
	return {
		key: `i-${r.id}`,
		kind: 'stock',
		primary: r.opalNumber,
		secondary: r.partInternalPn,
		name: r.partName,
		lotNumber: r.lotNumber,
		serialNumber: r.serialNumber,
		location: r.location,
		balance: r.balance,
		unitOfMeasure: r.partUom,
		trackingType: r.partTrackingType,
		expirationDate: r.expirationDate,
		tier: null,
		tierName: null,
		partState: null,
		url,
		qrSvg: await qrSvg(url)
	};
}

export async function partLabel(ctx: DbCtx, partId: number, origin = ''): Promise<StockLabel> {
	const p = ctx.db.select().from(part).where(eq(part.id, partId)).get();
	if (!p) throw new Error('Part not found');
	const url = `${origin.replace(/\/$/, '')}/parts/${p.id}`;
	return {
		key: `p-${p.id}`,
		kind: 'part',
		primary: p.internalPn,
		secondary: null,
		name: p.name,
		lotNumber: null,
		serialNumber: null,
		location: null,
		balance: null,
		unitOfMeasure: p.unitOfMeasure,
		trackingType: p.trackingType,
		expirationDate: null,
		tier: p.tier,
		tierName: getTier(getProjectConfig(ctx.db), p.tier)?.name ?? null,
		partState: p.state,
		url,
		qrSvg: await qrSvg(url)
	};
}

/** Labels in the order asked: stock first, then parts. A bad entry becomes a failure line. */
export async function buildLabels(
	ctx: DbCtx,
	input: { inventory?: string; part?: string; origin?: string }
): Promise<{ labels: StockLabel[]; failures: string[] }> {
	const labels: StockLabel[] = [];
	const failures: string[] = [];
	for (const opal of csv(input.inventory)) {
		try {
			labels.push(await stockLabel(ctx, opal, input.origin));
		} catch {
			failures.push(`${opal}: Stock record not found`);
		}
	}
	for (const raw of csv(input.part)) {
		const id = Number(raw);
		try {
			if (!Number.isInteger(id)) throw new Error();
			labels.push(await partLabel(ctx, id, input.origin));
		} catch {
			failures.push(`Part ${raw}: Part not found`);
		}
	}
	return { labels, failures };
}

