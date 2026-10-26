/** Stock records: read models, receiving, edits, calibration. */
import {
	type CalibrationStatus,
	STOCK_ATTENTION_DAYS,
	type Qty,
	type StockByPart,
	type StockLocation,
	type StockRecord,
	type StockSource,
	conflict,
	formatQty,
	notFound,
	now,
	QTY_SCALE
} from '@opal/shared';
import { type SQL, and, asc, desc, eq, gt, inArray, like, lte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { part, stockMove, stockRecord } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';
import { getProjectConfig, getTier, levelDefaults } from '../org/project.ts';
import { nextDesignator, nextSerial } from '../designators.ts';
import {
	type NewMove,
	balanceSql,
	invalid,
	lastCountSql,
	lowStockPartIds,
	onHandByPart,
	writeMove
} from './ledger.ts';

type DbCtx = Pick<Ctx, 'db'>;
export type PartRow = typeof part.$inferSelect;
export type StockRow = typeof stockRecord.$inferSelect;

const DAY_MS = 86_400_000;

/**
 * One serialized receive writes a record, a move and audit rows per unit inside a single
 * synchronous write transaction. 500 covers a large reel or lot of serialized units; larger
 * intakes are split into several receives so one request cannot block every other write.
 */
export const MAX_SERIAL_UNITS_PER_RECEIVE = 500;

/** Today's calendar date, YYYY-MM-DD, in the server's time zone (a calendar date has no zone). */
export function today(offsetDays = 0): string {
	const d = new Date(Date.now() + offsetDays * DAY_MS);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(fromDate: string, toDate: string): number {
	const [fy, fm, fd] = fromDate.split('-').map(Number) as [number, number, number];
	const [ty, tm, td] = toDate.split('-').map(Number) as [number, number, number];
	return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

export function calibrationStatus(
	isTooling: boolean,
	dueAt: string | null,
	at = now()
): CalibrationStatus | null {
	if (!isTooling || !dueAt) return null;
	if (dueAt <= at) return 'overdue';
	const days = Math.floor((Date.parse(dueAt) - Date.parse(at)) / DAY_MS);
	return days <= STOCK_ATTENTION_DAYS ? 'due_soon' : 'ok';
}

interface Joined {
	r: StockRow;
	p: PartRow;
	balance: number;
	lastCountedAt: string | null;
}

export function toStockRecord(j: Joined): StockRecord {
	const { r, p } = j;
	const daysUntil = r.expirationDate ? daysBetween(today(), r.expirationDate) : null;
	return {
		id: r.id,
		opalNumber: r.opalNumber,
		partId: p.id,
		partInternalPn: p.internalPn,
		partName: p.name,
		partExternalPn: p.externalPn,
		partUom: p.unitOfMeasure,
		partTrackingType: p.trackingType,
		partIsTooling: p.isTooling,
		balance: formatQty(j.balance as Qty),
		location: r.location,
		lotNumber: r.lotNumber,
		serialNumber: r.serialNumber,
		alias: r.alias,
		sourceType: r.sourceType,
		expirationDate: r.expirationDate,
		isExpired: daysUntil !== null && daysUntil < 0,
		daysUntilExpiration: daysUntil,
		lastCountedAt: j.lastCountedAt,
		lastCalibratedAt: r.lastCalibratedAt,
		calibrationDueAt: r.calibrationDueAt,
		calibrationStatus: calibrationStatus(p.isTooling, r.calibrationDueAt),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

export function stockSelect(ctx: DbCtx) {
	return ctx.db
		.select({ r: stockRecord, p: part, balance: balanceSql, lastCountedAt: lastCountSql })
		.from(stockRecord)
		.innerJoin(part, eq(part.id, stockRecord.partId));
}

export function getStock(ctx: DbCtx, id: number): StockRecord {
	const row = stockSelect(ctx).where(eq(stockRecord.id, id)).get();
	if (!row) throw notFound('Stock record');
	return toStockRecord(row);
}

export function getStockByOpal(ctx: DbCtx, opalNumber: string): StockRecord {
	const row = stockSelect(ctx).where(eq(stockRecord.opalNumber, opalNumber)).get();
	if (!row) throw notFound(`Stock record ${opalNumber}`);
	return toStockRecord(row);
}

/** The raw row for an OPAL number; throws 404. */
export function recordByOpal(ctx: DbCtx, opalNumber: string): StockRow {
	const row = ctx.db.select().from(stockRecord).where(eq(stockRecord.opalNumber, opalNumber)).get();
	if (!row) throw notFound(`Stock record ${opalNumber}`);
	return row;
}

export function recordById(ctx: DbCtx, id: number): StockRow {
	const row = ctx.db.select().from(stockRecord).where(eq(stockRecord.id, id)).get();
	if (!row) throw notFound('Stock record');
	return row;
}

export function partById(ctx: DbCtx, id: number): PartRow {
	const row = ctx.db.select().from(part).where(eq(part.id, id)).get();
	if (!row) throw notFound('Part');
	return row;
}

// ---- lists ----

export interface StockFilters {
	partId?: number;
	location?: string;
	lotNumber?: string;
	q?: string;
	sourceType?: StockSource;
	hasStock?: boolean;
	lowStock?: boolean;
	expired?: boolean;
	expiringSoon?: boolean;
	calibrationOverdue?: boolean;
	attention?: boolean;
}

const never = sql`1 = 0`;

function stockWhere(ctx: DbCtx, f: StockFilters): SQL | undefined {
	const nowIso = now();
	const conds: (SQL | undefined)[] = [
		f.partId ? eq(stockRecord.partId, f.partId) : undefined,
		f.location ? eq(stockRecord.location, f.location) : undefined,
		f.lotNumber ? eq(stockRecord.lotNumber, f.lotNumber) : undefined,
		f.sourceType ? eq(stockRecord.sourceType, f.sourceType) : undefined
	];
	if (f.q?.trim()) {
		const term = `%${f.q.trim()}%`;
		conds.push(
			or(
				like(stockRecord.opalNumber, term),
				like(stockRecord.lotNumber, term),
				like(stockRecord.serialNumber, term),
				like(stockRecord.alias, term),
				like(stockRecord.location, term),
				like(part.name, term),
				like(part.internalPn, term),
				like(part.externalPn, term)
			)
		);
	}
	if (f.hasStock === true) conds.push(sql`${balanceSql} > 0`);
	if (f.hasStock === false) conds.push(sql`${balanceSql} <= 0`);
	if (f.lowStock) {
		const ids = lowStockPartIds(ctx);
		conds.push(ids.length ? inArray(stockRecord.partId, ids) : never);
	}
	if (f.expired) {
		conds.push(sql`${stockRecord.expirationDate} IS NOT NULL`, sql`${stockRecord.expirationDate} < ${today()}`);
	} else if (f.expiringSoon) {
		conds.push(
			sql`${stockRecord.expirationDate} IS NOT NULL`,
			lte(stockRecord.expirationDate, today(STOCK_ATTENTION_DAYS))
		);
	}
	const calOverdue = and(
		eq(part.isTooling, true),
		sql`${stockRecord.calibrationDueAt} IS NOT NULL`,
		lte(stockRecord.calibrationDueAt, nowIso)
	);
	if (f.calibrationOverdue) conds.push(calOverdue);
	if (f.attention) {
		conds.push(
			or(
				calOverdue,
				and(
					sql`${balanceSql} > 0`,
					sql`${stockRecord.expirationDate} IS NOT NULL`,
					lte(stockRecord.expirationDate, today(STOCK_ATTENTION_DAYS))
				)
			)
		);
	}
	return and(...conds);
}

const SORTS = {
	opalNumber: stockRecord.opalNumber,
	part: part.internalPn,
	name: part.name,
	location: stockRecord.location,
	quantity: balanceSql,
	lotNumber: stockRecord.lotNumber,
	expirationDate: stockRecord.expirationDate,
	createdAt: stockRecord.createdAt
} as const;

export function listStock(
	ctx: DbCtx,
	input: StockFilters & {
		cursor?: string;
		limit: number;
		sort?: keyof typeof SORTS;
		order: 'asc' | 'desc';
	}
) {
	const where = stockWhere(ctx, input);
	const offset = Math.max(0, Number(input.cursor) || 0);
	const total =
		ctx.db
			.select({ n: sql<number>`COUNT(*)` })
			.from(stockRecord)
			.innerJoin(part, eq(part.id, stockRecord.partId))
			.where(where)
			.get()?.n ?? 0;
	const dir = input.order === 'desc' ? desc : asc;
	const ordering = input.sort
		? [dir(SORTS[input.sort]), desc(stockRecord.id)]
		: [asc(stockRecord.location), asc(stockRecord.partId), asc(stockRecord.id)];
	const rows = stockSelect(ctx)
		.where(where)
		.orderBy(...ordering)
		.limit(input.limit)
		.offset(offset)
		.all();
	return {
		items: rows.map(toStockRecord),
		next: offset + rows.length < total ? String(offset + rows.length) : null,
		total
	};
}

export function stockByPart(
	ctx: DbCtx,
	input: StockFilters & {
		cursor?: string;
		limit: number;
		sort: 'part' | 'name' | 'quantity' | 'recordCount';
		order: 'asc' | 'desc';
	}
) {
	const where = stockWhere(ctx, input);
	const qtySum = sql<number>`COALESCE(SUM(${balanceSql}), 0)`;
	const count = sql<number>`COUNT(${stockRecord.id})`;
	const sortCol = { part: part.internalPn, name: part.name, quantity: qtySum, recordCount: count }[
		input.sort
	];
	const dir = input.order === 'desc' ? desc : asc;
	const offset = Math.max(0, Number(input.cursor) || 0);
	const total =
		ctx.db
			.select({ n: sql<number>`COUNT(DISTINCT ${part.id})` })
			.from(stockRecord)
			.innerJoin(part, eq(part.id, stockRecord.partId))
			.where(where)
			.get()?.n ?? 0;
	const rows = ctx.db
		.select({ p: part, qty: qtySum, n: count })
		.from(stockRecord)
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(where)
		.groupBy(part.id)
		.orderBy(dir(sortCol), asc(part.id))
		.limit(input.limit)
		.offset(offset)
		.all();
	const ids = rows.map((r) => r.p.id);
	const locs = new Map<number, string[]>();
	if (ids.length) {
		const held = ctx.db
			.selectDistinct({ partId: stockRecord.partId, location: stockRecord.location })
			.from(stockRecord)
			.where(and(inArray(stockRecord.partId, ids), sql`${balanceSql} > 0`))
			.orderBy(stockRecord.location)
			.all();
		for (const h of held) locs.set(h.partId, [...(locs.get(h.partId) ?? []), h.location]);
	}
	// Low stock is judged on the part's whole on-hand, not on the filtered sum.
	const onHand = onHandByPart(ctx, ids);
	const items: StockByPart[] = rows.map(({ p, qty, n }) => ({
		partId: p.id,
		internalPn: p.internalPn,
		externalPn: p.externalPn,
		name: p.name,
		unitOfMeasure: p.unitOfMeasure,
		trackingType: p.trackingType,
		reorderPoint: p.reorderPoint === null ? null : formatQty(p.reorderPoint as Qty),
		balance: formatQty(qty as Qty),
		recordCount: n,
		locations: locs.get(p.id) ?? [],
		isLowStock: p.reorderPoint !== null && (onHand.get(p.id) ?? 0) < p.reorderPoint
	}));
	return {
		items,
		next: offset + rows.length < total ? String(offset + rows.length) : null,
		total
	};
}

export function listLocations(ctx: DbCtx): StockLocation[] {
	return ctx.db
		.select({
			location: stockRecord.location,
			recordCount: sql<number>`COUNT(${stockRecord.id})`,
			partCount: sql<number>`COUNT(DISTINCT ${stockRecord.partId})`
		})
		.from(stockRecord)
		.groupBy(stockRecord.location)
		.orderBy(stockRecord.location)
		.all();
}

// ---- receiving ----

export interface ReceivingRules {
	requireLot: boolean;
	autoSerial: boolean;
	tierName: string | null;
}

/** What the part's tier asks of a receipt. A tier missing from the config gets the level rules. */
export function receivingRulesFor(ctx: DbCtx, p: PartRow): ReceivingRules {
	const tier = getTier(getProjectConfig(ctx.db), p.tier);
	const rules = tier ?? levelDefaults(p.tier);
	return {
		requireLot: rules.requireLot && p.trackingType === 'bulk',
		autoSerial: rules.autoSerial && p.trackingType === 'serialized',
		tierName: tier?.name ?? null
	};
}

export type MoveLinks = NewMove['links'];

export interface NewStockRecord {
	partId: number;
	location: string;
	lotNumber?: string | null;
	serialNumber?: string | null;
	alias?: string | null;
	expirationDate?: string | null;
	sourceType: StockSource;
}

/** A stock record with an OPAL number and no moves yet: the balance is zero until one is written. */
export function createStockRecord(ctx: Ctx, input: NewStockRecord): StockRow {
	return insert(ctx, stockRecord, {
		partId: input.partId,
		opalNumber: nextDesignator(ctx, 'OPAL'),
		location: input.location,
		lotNumber: input.lotNumber ?? null,
		serialNumber: input.serialNumber ?? null,
		alias: input.alias ?? null,
		sourceType: input.sourceType,
		expirationDate: input.expirationDate ?? null
	});
}

export function assertPartActive(p: PartRow, action: string): void {
	if (p.state === 'draft') {
		throw conflict(
			'draft_parts_blocked',
			`${p.internalPn} is a draft part. Activate it before you ${action}.`
		);
	}
}

export interface ReceiveInput {
	partId: number;
	quantity: Qty;
	location: string;
	lotNumber?: string | null;
	serialNumber?: string | null;
	alias?: string | null;
	expirationDate?: string | null;
	/** Default `manual`. Purchasing passes `purchase`. */
	sourceType?: StockSource;
	/** Default true. False skips the lot and serial rules of the tier (data migration). */
	enforceTierRules?: boolean;
	notes?: string | null;
	at?: string;
	/** Link columns of the receive move, such as the purchase line. */
	links?: MoveLinks;
}

/**
 * Receive stock: create the record or records and one receive move each. A serialized part gets
 * one record per unit. Purchasing calls this for a received purchase line.
 */
export function receiveStock(ctx: Ctx, input: ReceiveInput): StockRecord[] {
	const p = partById(ctx, input.partId);
	assertPartActive(p, 'receive stock');
	if (input.quantity <= 0) throw invalid('quantity', 'Quantity must be greater than zero');
	const enforce = input.enforceTierRules ?? true;
	const rules = enforce ? receivingRulesFor(ctx, p) : { requireLot: false, autoSerial: false };
	const lot = input.lotNumber?.trim() || null;
	const serial = input.serialNumber?.trim() || null;
	if (rules.requireLot && !lot) {
		throw invalid(
			'lotNumber',
			`Tier ${p.tier} lot-tracked part '${p.name}' requires a lot number when receiving`
		);
	}
	const sourceType = input.sourceType ?? 'manual';
	const created: number[] = [];
	if (p.trackingType === 'serialized') {
		if (input.quantity % QTY_SCALE !== 0 || input.quantity < QTY_SCALE) {
			throw invalid('quantity', 'Serialized parts are received in whole units, at least 1');
		}
		const units = input.quantity / QTY_SCALE;
		if (units > MAX_SERIAL_UNITS_PER_RECEIVE) {
			throw invalid(
				'quantity',
				`A serialized receive creates at most ${MAX_SERIAL_UNITS_PER_RECEIVE} units; split it into smaller receives`
			);
		}
		if (serial && units > 1) {
			throw invalid('serialNumber', 'One serial number identifies one unit');
		}
		for (let i = 0; i < units; i++) {
			const rec = createStockRecord(ctx, {
				partId: p.id,
				location: input.location,
				lotNumber: lot,
				serialNumber: serial ?? (rules.autoSerial ? nextSerial(ctx, p.internalPn) : null),
				alias: input.alias,
				expirationDate: input.expirationDate,
				sourceType
			});
			writeMove(ctx, {
				stockId: rec.id,
				kind: 'receive',
				qty: QTY_SCALE,
				notes: input.notes,
				at: input.at,
				links: input.links
			});
			created.push(rec.id);
		}
	} else {
		const rec = createStockRecord(ctx, {
			partId: p.id,
			location: input.location,
			lotNumber: lot,
			serialNumber: null,
			alias: input.alias,
			expirationDate: input.expirationDate,
			sourceType
		});
		writeMove(ctx, {
			stockId: rec.id,
			kind: 'receive',
			qty: input.quantity,
			notes: input.notes,
			at: input.at,
			links: input.links
		});
		created.push(rec.id);
	}
	return created.map((id) => getStock(ctx, id));
}

// ---- edits ----

export function updateStock(
	ctx: Ctx,
	id: number,
	patch: {
		lotNumber?: string | null;
		serialNumber?: string | null;
		alias?: string | null;
		expirationDate?: string | null;
	}
): StockRecord {
	recordById(ctx, id);
	const set: Partial<typeof stockRecord.$inferInsert> = {};
	if (patch.lotNumber !== undefined) set.lotNumber = patch.lotNumber?.trim() || null;
	if (patch.serialNumber !== undefined) set.serialNumber = patch.serialNumber?.trim() || null;
	if (patch.alias !== undefined) set.alias = patch.alias?.trim() || null;
	if (patch.expirationDate !== undefined) set.expirationDate = patch.expirationDate;
	if (Object.keys(set).length) update(ctx, stockRecord, id, set);
	return getStock(ctx, id);
}

export function calibrateStock(ctx: Ctx, id: number): StockRecord {
	const rec = recordById(ctx, id);
	const p = partById(ctx, rec.partId);
	if (!p.isTooling) throw invalid('id', 'This part is not marked as tooling');
	const at = new Date();
	update(ctx, stockRecord, id, {
		lastCalibratedAt: at.toISOString(),
		calibrationDueAt: p.calibrationIntervalDays
			? new Date(at.getTime() + p.calibrationIntervalDays * DAY_MS).toISOString()
			: null
	});
	return getStock(ctx, id);
}

// ---- summaries ----

export function partSummary(ctx: DbCtx, partId: number) {
	const p = partById(ctx, partId);
	const rows = ctx.db
		.select({ r: stockRecord, balance: balanceSql })
		.from(stockRecord)
		.where(eq(stockRecord.partId, partId))
		.orderBy(stockRecord.id)
		.all();
	const total = rows.reduce((s, r) => s + r.balance, 0);
	const dues = rows.map((r) => r.r.calibrationDueAt).filter((d): d is string => !!d);
	const earliest = dues.length ? dues.reduce((a, b) => (a < b ? a : b)) : null;
	return {
		partId: p.id,
		partName: p.name,
		internalPn: p.internalPn,
		tier: p.tier,
		totalQty: formatQty(total as Qty),
		recordCount: rows.length,
		byLocation: rows.map((r) => ({
			location: r.r.location,
			qty: formatQty(r.balance as Qty),
			opalNumber: r.r.opalNumber
		})),
		isTooling: p.isTooling,
		calibrationDueAt: p.isTooling ? earliest : null,
		calibrationStatus: p.isTooling
			? ((earliest === null ? 'unknown' : earliest <= now() ? 'overdue' : 'ok') as
					| 'ok'
					| 'overdue'
					| 'unknown')
			: null,
		calibrationIntervalDays: p.isTooling ? p.calibrationIntervalDays : null
	};
}

