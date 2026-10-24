/** Writing the ledger: adjust, count, transfer, and the consume and produce calls for execution. */
import {
	type AdjustReason,
	type Qty,
	type StockLedgerRow,
	type StockMoveRow,
	type StockRecord,
	QTY_SCALE,
	conflict,
	formatQty,
	notFound
} from '@opal/shared';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Ctx } from '../../context.ts';
import { part, purchaseLine, stockMove, stockRecord, user } from '../../db/schema/index.ts';
import { update } from '../../write.ts';
import { balanceOf, invalid, writeMove } from './ledger.ts';
import {
	type MoveLinks,
	type StockRow,
	assertPartActive,
	createStockRecord,
	getStock,
	partById,
	recordById
} from './records.ts';

// ---- adjust and count ----

export function adjustStock(
	ctx: Ctx,
	input: { stockId: number; adjustment: Qty; reason: AdjustReason; notes?: string | null }
): StockRecord {
	const rec = recordById(ctx, input.stockId);
	const { adjustment, reason } = input;
	if (adjustment === 0) throw invalid('adjustment', 'Adjustment must not be zero');
	if (reason === 'found' && adjustment <= 0) {
		throw invalid('adjustment', "'found' adjustments must be positive");
	}
	if ((reason === 'damage' || reason === 'scrap') && adjustment >= 0) {
		throw invalid('adjustment', `'${reason}' adjustments must be negative`);
	}
	writeMove(ctx, {
		stockId: rec.id,
		kind: reason === 'cycle_count' ? 'count' : 'adjust',
		qty: adjustment,
		reason: reason === 'cycle_count' ? null : reason,
		notes: input.notes
	});
	return getStock(ctx, rec.id);
}

/** A physical count. The move carries the difference, zero included, so the count is on record. */
export function countStock(
	ctx: Ctx,
	input: { stockId: number; counted: Qty; notes?: string | null }
): StockRecord {
	const rec = recordById(ctx, input.stockId);
	const p = partById(ctx, rec.partId);
	if (input.counted < 0) {
		throw invalid('countedQuantity', `Counted quantity cannot be negative (${formatQty(input.counted)})`);
	}
	if (p.trackingType === 'serialized' && input.counted > QTY_SCALE) {
		throw invalid('countedQuantity', 'A serialized unit cannot have a quantity above 1');
	}
	writeMove(ctx, {
		stockId: rec.id,
		kind: 'count',
		qty: input.counted - balanceOf(ctx, rec.id),
		notes: input.notes
	});
	return getStock(ctx, rec.id);
}

// ---- transfer ----

/**
 * Move stock to another location, and optionally another lot.
 *
 * - The target is the stock already there for this part, location and lot (never for a
 *   serialized unit). The two records exchange the quantity in two paired moves.
 * - Else a whole move relocates the record. It keeps its OPAL number. One zero move records it.
 * - Else a partial move creates a record with a new OPAL number. A serialized unit is not split.
 */
export function transferStock(
	ctx: Ctx,
	input: {
		sourceId: number;
		targetLocation: string;
		quantity: Qty;
		targetLotNumber?: string | null;
		notes?: string | null;
	}
): { source: StockRecord; target: StockRecord } {
	const source = recordById(ctx, input.sourceId);
	const p = partById(ctx, source.partId);
	const qty = input.quantity;
	if (qty <= 0) throw invalid('quantity', 'Transfer quantity must be positive');
	const have = balanceOf(ctx, source.id);
	if (have < qty) {
		throw conflict(
			'insufficient_stock',
			`Insufficient quantity at source (have ${formatQty(have)}, need ${formatQty(qty)})`
		);
	}
	const targetLocation = input.targetLocation.trim();
	const targetLot = input.targetLotNumber?.trim() || source.lotNumber;
	if (source.location === targetLocation && source.lotNumber === targetLot) {
		throw invalid('targetLocation', 'Cannot transfer to the same location with the same lot number');
	}
	const serialized = p.trackingType === 'serialized';
	const existing = serialized
		? undefined
		: ctx.db
				.select()
				.from(stockRecord)
				.where(
					and(
						eq(stockRecord.partId, source.partId),
						eq(stockRecord.location, targetLocation),
						targetLot === null ? sql`${stockRecord.lotNumber} IS NULL` : eq(stockRecord.lotNumber, targetLot),
						sql`${stockRecord.id} != ${source.id}`
					)
				)
				.orderBy(stockRecord.id)
				.get();

	const trail = {
		fromLocation: source.location,
		toLocation: targetLocation,
		fromLot: source.lotNumber,
		toLot: targetLot,
		notes: input.notes
	};

	let target: StockRow | undefined = existing;
	if (!target && qty === have) {
		// The whole record moves; it keeps its OPAL number.
		update(ctx, stockRecord, source.id, { location: targetLocation, lotNumber: targetLot });
		writeMove(ctx, { stockId: source.id, kind: 'transfer', qty: 0, ...trail });
		const rec = getStock(ctx, source.id);
		return { source: rec, target: rec };
	}
	if (!target) {
		if (serialized) throw invalid('quantity', 'Serialized units cannot be split');
		target = createStockRecord(ctx, {
			partId: source.partId,
			location: targetLocation,
			lotNumber: targetLot,
			expirationDate: source.expirationDate,
			sourceType: 'transfer'
		});
	}
	const out = writeMove(ctx, { stockId: source.id, kind: 'transfer', qty: -qty, ...trail });
	const inn = writeMove(ctx, {
		stockId: target.id,
		kind: 'transfer',
		qty,
		counterpartId: out.id,
		...trail
	});
	update(ctx, stockMove, out.id, { counterpartId: inn.id });
	return { source: getStock(ctx, source.id), target: getStock(ctx, target.id) };
}

// ---- consume and produce: the calls execution makes ----

export interface ConsumeInput {
	stockId: number;
	/** Positive quantity taken out. Ignored for tooling. */
	quantity: Qty;
	/** Tooling is used and returned: a consume move of zero. */
	tooling?: boolean;
	/** `scrap` for material lost during the work. */
	reason?: string | null;
	notes?: string | null;
	/** The record this material goes into (an assembly being built). */
	intoStockId?: number | null;
	at?: string;
	/** Link columns of the move, such as the execution and step execution. */
	links?: MoveLinks;
}

/** Take material out of a record. Refuses when the balance is too small. */
export function consumeStock(ctx: Ctx, input: ConsumeInput) {
	const rec = recordById(ctx, input.stockId);
	if (!input.tooling && input.quantity <= 0) {
		throw invalid('quantity', 'Quantity must be greater than zero');
	}
	if (input.intoStockId != null) recordById(ctx, input.intoStockId);
	return writeMove(ctx, {
		stockId: rec.id,
		kind: 'consume',
		qty: input.tooling ? 0 : -input.quantity,
		reason: input.tooling ? 'tooling' : (input.reason ?? null),
		notes: input.notes,
		intoStockId: input.intoStockId ?? null,
		at: input.at,
		links: input.links
	});
}

export interface ProduceInput {
	/** Credit this record (for example one created ahead with `createStockRecord`) ... */
	stockId?: number;
	/** ... or create a new record of this part. */
	partId?: number;
	quantity: Qty;
	location?: string;
	lotNumber?: string | null;
	serialNumber?: string | null;
	expirationDate?: string | null;
	/** Consume moves that went into this item. Each is linked once. */
	componentMoveIds?: number[];
	notes?: string | null;
	at?: string;
	links?: MoveLinks;
}

/** Add produced material to stock. Creates the record unless `stockId` names one. */
export function produceStock(ctx: Ctx, input: ProduceInput): { stock: StockRecord; moveId: number } {
	if (input.quantity <= 0) throw invalid('quantity', 'Quantity must be greater than zero');
	let stockId = input.stockId;
	if (stockId === undefined) {
		if (!input.partId) throw invalid('partId', 'Name the part or the stock record');
		if (!input.location?.trim()) throw invalid('location', 'Location is required');
		const p = partById(ctx, input.partId);
		assertPartActive(p, 'produce stock');
		stockId = createStockRecord(ctx, {
			partId: p.id,
			location: input.location.trim(),
			lotNumber: input.lotNumber?.trim() || null,
			serialNumber: input.serialNumber?.trim() || null,
			expirationDate: input.expirationDate,
			sourceType: 'production'
		}).id;
	}
	const move = writeMove(ctx, {
		stockId,
		kind: 'produce',
		qty: input.quantity,
		notes: input.notes,
		at: input.at,
		links: input.links
	});
	if (input.componentMoveIds?.length) linkComponents(ctx, stockId, input.componentMoveIds);
	return { stock: getStock(ctx, stockId), moveId: move.id };
}

/** Record that these consume moves went into the assembly. A move links to one assembly only. */
export function linkComponents(ctx: Ctx, intoStockId: number, moveIds: number[]): void {
	recordById(ctx, intoStockId);
	const moves = ctx.db.select().from(stockMove).where(inArray(stockMove.id, moveIds)).all();
	if (moves.length !== new Set(moveIds).size) throw notFound('Stock move');
	for (const m of moves) {
		if (m.kind !== 'consume') throw invalid('componentMoveIds', 'Only consume moves can be components');
		if (m.stockId === intoStockId) throw invalid('componentMoveIds', 'A record cannot go into itself');
		if (m.intoStockId !== null && m.intoStockId !== intoStockId) {
			throw conflict('component_linked', 'A consume move already went into another item');
		}
		if (m.intoStockId === null) update(ctx, stockMove, m.id, { intoStockId });
	}
}

// ---- reading the ledger ----

type MoveRowDb = typeof stockMove.$inferSelect;
const CORE = new Set([
	'id',
	'stockId',
	'kind',
	'qty',
	'reason',
	'notes',
	'actorUserId',
	'at',
	'fromLocation',
	'toLocation',
	'fromLot',
	'toLot',
	'counterpartId',
	'intoStockId'
]);

/** Link columns that other areas added to the table: every non-null column that is not core. */
export function moveLinks(m: MoveRowDb): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(m)) if (!CORE.has(k) && typeof v === 'number') out[k] = v;
	return out;
}

/** The ledger of one record, oldest first, with a running balance. */
export function ledgerFor(ctx: Pick<Ctx, 'db'>, stockId: number): StockLedgerRow[] {
	const cp = alias(stockMove, 'cp');
	const cpRec = alias(stockRecord, 'cp_rec');
	const rows = ctx.db
		.select({ m: stockMove, actor: user.name, counterpartOpal: cpRec.opalNumber })
		.from(stockMove)
		.leftJoin(user, eq(user.id, stockMove.actorUserId))
		.leftJoin(cp, eq(cp.id, stockMove.counterpartId))
		.leftJoin(cpRec, eq(cpRec.id, cp.stockId))
		.where(eq(stockMove.stockId, stockId))
		.orderBy(asc(stockMove.at), asc(stockMove.id))
		.all();
	// The order behind a receipt, so the ledger can link to it. // added by QA
	const lineIds = [...new Set(rows.flatMap(({ m }) => (m.purchaseLineId ? [m.purchaseLineId] : [])))];
	const orderOf = new Map(
		lineIds.length
			? ctx.db
					.select({ id: purchaseLine.id, purchaseId: purchaseLine.purchaseId })
					.from(purchaseLine)
					.where(inArray(purchaseLine.id, lineIds))
					.all()
					.map((l) => [l.id, l.purchaseId] as const)
			: []
	);
	let balance = 0;
	return rows.map(({ m, actor, counterpartOpal }) => {
		balance += m.qty;
		return {
			id: m.id,
			kind: m.kind,
			at: m.at,
			qty: formatQty(m.qty as Qty),
			balance: formatQty(balance as Qty),
			reason: m.reason,
			notes: m.notes,
			actorName: actor,
			fromLocation: m.fromLocation,
			toLocation: m.toLocation,
			fromLot: m.fromLot,
			toLot: m.toLot,
			counterpartOpal,
			links: {
				...moveLinks(m),
				...(m.purchaseLineId && orderOf.has(m.purchaseLineId)
					? { purchaseId: orderOf.get(m.purchaseLineId)! }
					: {})
			}
		};
	});
}

/** The ledger across records, newest first. The cursor is the id of the last move shown. */
export function listMoves(
	ctx: Pick<Ctx, 'db'>,
	input: { cursor?: string; limit: number; partId?: number; location?: string; kind?: StockMoveRow['kind'] }
) {
	const cp = alias(stockMove, 'cp');
	const cpRec = alias(stockRecord, 'cp_rec');
	const where = and(
		input.cursor ? lt(stockMove.id, Number(input.cursor)) : undefined,
		input.partId ? eq(stockRecord.partId, input.partId) : undefined,
		input.location ? eq(stockRecord.location, input.location) : undefined,
		input.kind ? eq(stockMove.kind, input.kind) : undefined
	);
	const rows = ctx.db
		.select({
			m: stockMove,
			actor: user.name,
			counterpartOpal: cpRec.opalNumber,
			opalNumber: stockRecord.opalNumber,
			partId: part.id,
			pn: part.internalPn,
			name: part.name
		})
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.leftJoin(user, eq(user.id, stockMove.actorUserId))
		.leftJoin(cp, eq(cp.id, stockMove.counterpartId))
		.leftJoin(cpRec, eq(cpRec.id, cp.stockId))
		.where(where)
		.orderBy(desc(stockMove.id))
		.limit(input.limit + 1)
		.all();
	const page = rows.slice(0, input.limit);
	return {
		items: page.map(
			({ m, actor, counterpartOpal, opalNumber, partId, pn, name }): StockMoveRow => ({
				id: m.id,
				kind: m.kind,
				at: m.at,
				qty: formatQty(m.qty as Qty),
				reason: m.reason,
				notes: m.notes,
				actorName: actor,
				fromLocation: m.fromLocation,
				toLocation: m.toLocation,
				fromLot: m.fromLot,
				toLot: m.toLot,
				counterpartOpal,
				links: moveLinks(m),
				opalNumber,
				partId,
				partInternalPn: pn,
				partName: name
			})
		),
		next: rows.length > input.limit ? String(page.at(-1)!.m.id) : null
	};
}
