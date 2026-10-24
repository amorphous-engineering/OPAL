/**
 * The ledger: balances are sums of `stock_move.qty`. Nothing else holds a quantity.
 * Other areas import `balanceOf`, `balancesForPart` and `onHandForPart` from here.
 */
import { type Qty, OpalError, QTY_SCALE, conflict, now } from '@opal/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { type Ctx, actorUserId } from '../../context.ts';
import { part, stockMove, stockRecord } from '../../db/schema/index.ts';
import { insert } from '../../write.ts';

type DbCtx = Pick<Ctx, 'db'>;

/**
 * SQL for the balance of the record in the surrounding query. Table names are written out:
 * drizzle drops the table qualifier of a column in a single-table query, which would turn
 * `stock_record.id` into the subquery's own `id`.
 */
export const balanceSql = sql<number>`COALESCE((SELECT SUM(m.qty) FROM stock_move m WHERE m.stock_id = stock_record.id), 0)`;

/** SQL for the time of the latest count move of the record in the surrounding query. */
export const lastCountSql = sql<string | null>`(SELECT MAX(m.at) FROM stock_move m WHERE m.stock_id = stock_record.id AND m.kind = 'count')`;

export function balanceOf(ctx: DbCtx, stockId: number): Qty {
	const row = ctx.db
		.select({ v: sql<number>`COALESCE(SUM(${stockMove.qty}), 0)` })
		.from(stockMove)
		.where(eq(stockMove.stockId, stockId))
		.get();
	return (row?.v ?? 0) as Qty;
}

export interface PartBalance {
	stockId: number;
	opalNumber: string;
	location: string;
	lotNumber: string | null;
	serialNumber: string | null;
	balance: Qty;
}

/** The balance of every stock record of a part, oldest record first. */
export function balancesForPart(ctx: DbCtx, partId: number): PartBalance[] {
	return ctx.db
		.select({
			stockId: stockRecord.id,
			opalNumber: stockRecord.opalNumber,
			location: stockRecord.location,
			lotNumber: stockRecord.lotNumber,
			serialNumber: stockRecord.serialNumber,
			balance: balanceSql
		})
		.from(stockRecord)
		.where(eq(stockRecord.partId, partId))
		.orderBy(stockRecord.id)
		.all() as PartBalance[];
}

/** Total on hand of a part over all its records. */
export function onHandForPart(ctx: DbCtx, partId: number): Qty {
	return onHandByPart(ctx, [partId]).get(partId) ?? (0 as Qty);
}

export function onHandByPart(ctx: DbCtx, partIds: number[]): Map<number, Qty> {
	const out = new Map<number, Qty>();
	if (!partIds.length) return out;
	const rows = ctx.db
		.select({ partId: stockRecord.partId, total: sql<number>`COALESCE(SUM(${stockMove.qty}), 0)` })
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.where(inArray(stockRecord.partId, partIds))
		.groupBy(stockRecord.partId)
		.all();
	for (const r of rows) out.set(r.partId, r.total as Qty);
	return out;
}

export function invalid(field: string, message: string): OpalError {
	return new OpalError(422, 'invalid_input', message, { [field]: message });
}

export interface NewMove {
	stockId: number;
	kind: (typeof stockMove.$inferInsert)['kind'];
	qty: Qty | number;
	reason?: string | null;
	notes?: string | null;
	at?: string;
	fromLocation?: string | null;
	toLocation?: string | null;
	fromLot?: string | null;
	toLot?: string | null;
	counterpartId?: number | null;
	intoStockId?: number | null;
	/** Link columns other areas add to `stock_move` (purchase line, execution, ...). */
	links?: Partial<
		Omit<
			typeof stockMove.$inferInsert,
			| 'id'
			| 'stockId'
			| 'kind'
			| 'qty'
			| 'reason'
			| 'notes'
			| 'at'
			| 'actorUserId'
			| 'fromLocation'
			| 'toLocation'
			| 'fromLot'
			| 'toLot'
			| 'counterpartId'
			| 'intoStockId'
		>
	>;
}

/**
 * Append one move. Refuses a move that would leave the balance below zero, or above one for a
 * serialized part. Every other writer in this area goes through here.
 */
export function writeMove(ctx: Ctx, m: NewMove): typeof stockMove.$inferSelect {
	const rec = ctx.db
		.select({ id: stockRecord.id, opalNumber: stockRecord.opalNumber, tracking: part.trackingType })
		.from(stockRecord)
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(eq(stockRecord.id, m.stockId))
		.get();
	if (!rec) throw new Error(`writeMove: stock record ${m.stockId} does not exist`);
	const after = balanceOf(ctx, m.stockId) + m.qty;
	if (after < 0) {
		throw conflict('insufficient_stock', `${rec.opalNumber} would go below zero on hand`);
	}
	if (rec.tracking === 'serialized' && after > QTY_SCALE) {
		throw invalid('quantity', 'A serialized unit cannot have a quantity above 1');
	}
	return insert(ctx, stockMove, {
		stockId: m.stockId,
		kind: m.kind,
		qty: m.qty,
		reason: m.reason ?? null,
		notes: m.notes ?? null,
		actorUserId: actorUserId(ctx.actor),
		at: m.at ?? now(),
		fromLocation: m.fromLocation ?? null,
		toLocation: m.toLocation ?? null,
		fromLot: m.fromLot ?? null,
		toLot: m.toLot ?? null,
		counterpartId: m.counterpartId ?? null,
		intoStockId: m.intoStockId ?? null,
		...m.links
	});
}

/** Ids of parts whose total on hand is below their reorder point. */
export function lowStockPartIds(ctx: DbCtx): number[] {
	const parts = ctx.db
		.select({ id: part.id, reorder: part.reorderPoint })
		.from(part)
		.where(and(sql`${part.reorderPoint} IS NOT NULL`, ne(part.state, 'obsolete')))
		.all();
	if (!parts.length) return [];
	const onHand = onHandByPart(
		ctx,
		parts.map((p) => p.id)
	);
	return parts.filter((p) => (onHand.get(p.id) ?? 0) < (p.reorder as number)).map((p) => p.id);
}
