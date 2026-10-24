/**
 * Queries for what needs attention: calibration due, stock expiring, parts below the reorder
 * point. The overview imports these.
 */
import { STOCK_ATTENTION_DAYS, type Qty, type StockRecord, formatQty } from '@opal/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { part, stockRecord } from '../../db/schema/index.ts';
import { balanceSql, lowStockPartIds, onHandByPart } from './ledger.ts';
import { stockSelect, toStockRecord, today } from './records.ts';

type DbCtx = Pick<Ctx, 'db'>;
const DAY_MS = 86_400_000;

/** Tooling records with a calibration date, split into overdue and due within `withinDays`. */
export function calibrationReport(
	ctx: DbCtx,
	withinDays = STOCK_ATTENTION_DAYS,
	at = new Date()
): { overdue: StockRecord[]; dueSoon: StockRecord[] } {
	const nowIso = at.toISOString();
	const horizon = new Date(at.getTime() + withinDays * DAY_MS).toISOString();
	const rows = stockSelect(ctx)
		.where(
			and(
				eq(part.isTooling, true),
				sql`${stockRecord.calibrationDueAt} IS NOT NULL`,
				lte(stockRecord.calibrationDueAt, horizon)
			)
		)
		.orderBy(asc(stockRecord.calibrationDueAt), asc(stockRecord.id))
		.all();
	return {
		overdue: rows.filter((r) => r.r.calibrationDueAt! <= nowIso).map(toStockRecord),
		dueSoon: rows.filter((r) => r.r.calibrationDueAt! > nowIso).map(toStockRecord)
	};
}

/** Stock on hand that is expired or expires within `withinDays`, soonest first. */
export function expiringStock(ctx: DbCtx, withinDays = STOCK_ATTENTION_DAYS): StockRecord[] {
	return stockSelect(ctx)
		.where(
			and(
				sql`${stockRecord.expirationDate} IS NOT NULL`,
				lte(stockRecord.expirationDate, today(withinDays)),
				sql`${balanceSql} > 0`
			)
		)
		.orderBy(asc(stockRecord.expirationDate), asc(stockRecord.id))
		.all()
		.map(toStockRecord);
}

/** Parts whose total on hand is below the reorder point. */
export function lowStockParts(ctx: DbCtx) {
	const ids = lowStockPartIds(ctx);
	if (!ids.length) return [];
	const onHand = onHandByPart(ctx, ids);
	return ids
		.map((id) => ({ id, p: ctx.db.select().from(part).where(eq(part.id, id)).get()! }))
		.sort((a, b) => a.p.internalPn.localeCompare(b.p.internalPn))
		.map(({ id, p }) => ({
			partId: id,
			internalPn: p.internalPn,
			name: p.name,
			unitOfMeasure: p.unitOfMeasure,
			onHand: formatQty((onHand.get(id) ?? 0) as Qty),
			reorderPoint: formatQty(p.reorderPoint as Qty)
		}));
}
