/** Purchase orders: header, lines, status workflow, receiving and the expense ledger. */
import {
	PURCHASE_OPEN_STATUSES,
	PURCHASE_TRANSITIONS,
	type Purchase,
	type PurchaseExpense,
	type PurchaseLine,
	type PurchaseListItem,
	type PurchaseStatus,
	type Qty,
	conflict,
	formatQty,
	notFound,
	now,
	parseQty,
	QTY_SCALE
} from '@opal/shared';
import { type SQL, and, asc, desc, eq, inArray, like, lt, notInArray, or, sql } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import {
	part,
	purchase,
	purchaseExpense,
	purchaseLine,
	stockMove,
	stockRecord,
	supplier,
	user
} from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { receiveStock, receivingRulesFor, today } from '../inventory/index.ts';
import { invalid } from '../inventory/ledger.ts';
import { ensurePartsActive } from '../parts/lifecycle.ts';
import { lineTotal, parseMoney, showMoney } from './money.ts';

type DbCtx = Pick<Ctx, 'db'>;
type PurchaseRow = typeof purchase.$inferSelect;
type LineRow = typeof purchaseLine.$inferSelect;
type PartRow = typeof part.$inferSelect;

const OPEN = PURCHASE_OPEN_STATUSES as readonly string[];
const DONE = ['received', 'cancelled'];

// ---------------------------------------------------------------- reading

/** Quantity received per line: the sum of the receive moves that point at it. */
function receivedByLine(ctx: DbCtx, lineIds: number[]): Map<number, number> {
	const out = new Map<number, number>();
	if (!lineIds.length) return out;
	const rows = ctx.db
		.select({ id: stockMove.purchaseLineId, total: sql<number>`COALESCE(SUM(${stockMove.qty}), 0)` })
		.from(stockMove)
		.where(and(inArray(stockMove.purchaseLineId, lineIds), eq(stockMove.kind, 'receive')))
		.groupBy(stockMove.purchaseLineId)
		.all();
	for (const r of rows) out.set(r.id as number, r.total);
	return out;
}

function isOverdue(p: Pick<PurchaseRow, 'targetDate' | 'status'>): boolean {
	return !!p.targetDate && !DONE.includes(p.status) && today() > p.targetDate;
}

function costOfLines(lines: { unitCost: number | null; qtyOrdered: number }[]): string | null {
	const total = lines.reduce((s, l) => (l.unitCost ? s + lineTotal(l.unitCost, l.qtyOrdered) : s), 0);
	return total > 0 ? showMoney(total) : null;
}

function presentLine(ctx: DbCtx, l: LineRow, p: PartRow, received: number): PurchaseLine {
	const rules = receivingRulesFor(ctx, p);
	return {
		id: l.id,
		purchaseId: l.purchaseId,
		partId: p.id,
		partName: p.name,
		partInternalPn: p.internalPn,
		partExternalPn: p.externalPn,
		unitOfMeasure: p.unitOfMeasure,
		trackingType: p.trackingType,
		lotRequired: rules.requireLot,
		autoSerial: rules.autoSerial,
		qtyOrdered: formatQty(l.qtyOrdered as Qty),
		qtyReceived: formatQty(received as Qty),
		qtyOutstanding: formatQty((l.qtyOrdered - received) as Qty),
		unitCost: showMoney(l.unitCost),
		destination: l.destination,
		notes: l.notes,
		isComplete: received >= l.qtyOrdered
	};
}

function linesOf(ctx: DbCtx, purchaseId: number) {
	const rows = ctx.db
		.select({ l: purchaseLine, p: part })
		.from(purchaseLine)
		.innerJoin(part, eq(part.id, purchaseLine.partId))
		.where(eq(purchaseLine.purchaseId, purchaseId))
		.orderBy(asc(purchaseLine.id))
		.all();
	const got = receivedByLine(ctx, rows.map((r) => r.l.id));
	return rows.map((r) => ({ ...r, received: got.get(r.l.id) ?? 0 }));
}

function supplierNameOf(ctx: DbCtx, p: PurchaseRow): string {
	if (p.supplierId === null) return p.supplierName ?? '';
	return ctx.db.select({ n: supplier.name }).from(supplier).where(eq(supplier.id, p.supplierId)).get()?.n ?? '';
}

function userName(ctx: DbCtx, id: number | null): string | null {
	if (id === null) return null;
	return ctx.db.select({ n: user.name }).from(user).where(eq(user.id, id)).get()?.n ?? null;
}

export function presentPurchase(ctx: DbCtx, p: PurchaseRow): Purchase {
	const lines = linesOf(ctx, p.id);
	return {
		id: p.id,
		reference: p.reference,
		supplierId: p.supplierId,
		supplierName: supplierNameOf(ctx, p),
		supplierReference: p.supplierReference,
		status: p.status,
		targetDate: p.targetDate,
		destination: p.destination,
		orderedAt: p.orderedAt,
		receivedAt: p.receivedAt,
		isOverdue: isOverdue(p),
		notes: p.notes,
		lines: lines.map((r) => presentLine(ctx, r.l, r.p, r.received)),
		totalLines: lines.length,
		totalCost: costOfLines(lines.map((r) => r.l)),
		createdAt: p.createdAt,
		updatedAt: p.updatedAt,
		createdById: p.createdById,
		createdByName: userName(ctx, p.createdById),
		receivedById: p.receivedById,
		receivedByName: userName(ctx, p.receivedById)
	};
}

function getRow(ctx: DbCtx, id: number): PurchaseRow {
	const p = ctx.db.select().from(purchase).where(eq(purchase.id, id)).get();
	if (!p) throw notFound(`Purchase order ${id}`);
	return p;
}

function getLineRow(ctx: DbCtx, purchaseId: number, lineId: number): LineRow {
	const l = ctx.db
		.select()
		.from(purchaseLine)
		.where(and(eq(purchaseLine.id, lineId), eq(purchaseLine.purchaseId, purchaseId)))
		.get();
	if (!l) throw notFound(`Purchase line ${lineId}`);
	return l;
}

export function getPurchase(ctx: DbCtx, id: number): Purchase {
	return presentPurchase(ctx, getRow(ctx, id));
}

function requireOpen(p: PurchaseRow, action: string): void {
	if (!OPEN.includes(p.status)) {
		throw conflict('wrong_state', `Cannot ${action} on a purchase in ${p.status} status`);
	}
}

// ---------------------------------------------------------------- list

export function listPurchases(
	ctx: DbCtx,
	i: {
		cursor?: string;
		limit: number;
		status?: PurchaseStatus;
		open?: boolean;
		awaiting?: boolean;
		overdue?: boolean;
		supplierId?: number;
		supplier?: string;
		q?: string;
		targetFrom?: string;
		targetTo?: string;
		sort: 'reference' | 'supplier' | 'status' | 'targetDate' | 'orderedAt' | 'createdAt';
		dir: 'asc' | 'desc';
	}
) {
	const supName = sql<string>`COALESCE(${supplier.name}, ${purchase.supplierName})`;
	const term = i.q ? `%${i.q}%` : undefined;
	const conds: (SQL | undefined)[] = [
		i.status ? eq(purchase.status, i.status) : undefined,
		i.open ? inArray(purchase.status, [...PURCHASE_OPEN_STATUSES]) : undefined,
		i.awaiting ? inArray(purchase.status, ['ordered', 'partial']) : undefined,
		i.overdue ? and(lt(purchase.targetDate, today()), notInArray(purchase.status, DONE as never[])) : undefined,
		i.supplierId ? eq(purchase.supplierId, i.supplierId) : undefined,
		i.supplier ? like(supName, `%${i.supplier}%`) : undefined,
		term ? or(like(purchase.reference, term), like(supName, term), like(purchase.supplierReference, term)) : undefined,
		i.targetFrom ? sql`${purchase.targetDate} >= ${i.targetFrom}` : undefined,
		i.targetTo ? sql`${purchase.targetDate} <= ${i.targetTo}` : undefined
	];
	const where = and(...conds);
	const total =
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(purchase)
			.leftJoin(supplier, eq(supplier.id, purchase.supplierId))
			.where(where)
			.get()?.n ?? 0;
	const col = {
		reference: purchase.reference,
		supplier: supName,
		status: purchase.status,
		targetDate: purchase.targetDate,
		orderedAt: purchase.orderedAt,
		createdAt: purchase.createdAt
	}[i.sort];
	const offset = Number(i.cursor ?? 0) || 0;
	const rows = ctx.db
		.select({ p: purchase, sup: supName })
		.from(purchase)
		.leftJoin(supplier, eq(supplier.id, purchase.supplierId))
		.where(where)
		.orderBy(i.dir === 'asc' ? asc(col) : desc(col), desc(purchase.id))
		.limit(i.limit)
		.offset(offset)
		.all();
	const lineRows = rows.length
		? ctx.db
				.select()
				.from(purchaseLine)
				.where(inArray(purchaseLine.purchaseId, rows.map((r) => r.p.id)))
				.all()
		: [];
	const got = receivedByLine(ctx, lineRows.map((l) => l.id));
	const items: PurchaseListItem[] = rows.map(({ p, sup }) => {
		const lines = lineRows.filter((l) => l.purchaseId === p.id);
		return {
			id: p.id,
			reference: p.reference,
			supplierId: p.supplierId,
			supplierName: sup ?? '',
			supplierReference: p.supplierReference,
			status: p.status,
			targetDate: p.targetDate,
			isOverdue: isOverdue(p),
			orderedAt: p.orderedAt,
			receivedAt: p.receivedAt,
			totalLines: lines.length,
			linesComplete: lines.filter((l) => (got.get(l.id) ?? 0) >= l.qtyOrdered).length,
			totalCost: costOfLines(lines),
			createdAt: p.createdAt
		};
	});
	return { items, next: offset + rows.length < total ? String(offset + rows.length) : null, total };
}

// ---------------------------------------------------------------- create and edit

/** PO-NNNN: one past the highest numeric suffix in use. */
export function nextReference(ctx: DbCtx): string {
	let max = 0;
	for (const r of ctx.db.select({ r: purchase.reference }).from(purchase).where(like(purchase.reference, 'PO-%')).all()) {
		const m = /^PO-(\d+)$/.exec(r.r);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `PO-${String(max + 1).padStart(4, '0')}`;
}

function resolveSupplier(ctx: DbCtx, id: number) {
	const s = ctx.db.select().from(supplier).where(eq(supplier.id, id)).get();
	if (!s) throw notFound(`Supplier ${id}`);
	return s;
}

function assertReferenceFree(ctx: DbCtx, ref: string, exceptId?: number) {
	const clash = ctx.db.select({ id: purchase.id }).from(purchase).where(eq(purchase.reference, ref)).get();
	if (clash && clash.id !== exceptId) throw conflict('duplicate_reference', `PO with reference '${ref}' already exists`);
}

interface LineInput {
	partId: number;
	qtyOrdered: string;
	unitCost?: string | null;
	destination?: string | null;
	notes?: string | null;
}

function checkedLine(ctx: DbCtx, l: LineInput) {
	const qty = parseQty(l.qtyOrdered);
	if (qty <= 0) throw invalid('qtyOrdered', 'Quantity must be greater than zero');
	const cost = l.unitCost == null ? null : parseMoney('unitCost', l.unitCost);
	const p = ctx.db.select().from(part).where(eq(part.id, l.partId)).get();
	if (!p) throw notFound(`Part ${l.partId}`);
	return { qty, cost, part: p };
}

export function createPurchase(
	ctx: Ctx,
	i: {
		supplierId?: number | null;
		supplierName?: string | null;
		supplierReference?: string | null;
		reference?: string | null;
		targetDate?: string | null;
		destination?: string | null;
		notes?: string | null;
		lines: LineInput[];
	}
): Purchase {
	const name = (i.supplierName ?? '').trim();
	if (!i.supplierId && !name) throw invalid('supplierId', 'Choose a supplier or enter a supplier name');
	if (i.supplierId) resolveSupplier(ctx, i.supplierId);
	const wanted = (i.reference ?? '').trim();
	if (wanted) assertReferenceFree(ctx, wanted);
	const reference = wanted || nextReference(ctx);
	const checked = i.lines.map((l) => checkedLine(ctx, l));
	// A line is a financial commitment: a draft part blocks it.
	ensurePartsActive(ctx, i.lines.map((l) => l.partId), `PO ${reference} line add`);

	const p = insert(ctx, purchase, {
		reference,
		supplierId: i.supplierId ?? null,
		supplierName: i.supplierId ? null : name,
		supplierReference: i.supplierReference?.trim() || null,
		status: 'draft',
		targetDate: i.targetDate ?? null,
		destination: i.destination?.trim() || null,
		notes: i.notes ?? null,
		createdById: actorUserId(ctx.actor)
	});
	i.lines.forEach((l, n) =>
		insert(ctx, purchaseLine, {
			purchaseId: p.id,
			partId: l.partId,
			qtyOrdered: checked[n]!.qty,
			unitCost: checked[n]!.cost,
			destination: l.destination?.trim() || null,
			notes: l.notes ?? null
		})
	);
	return getPurchase(ctx, p.id);
}

/** ordered / partial / received follow from what arrived. Draft, held and closed orders stay. */
function settleStatus(ctx: Ctx, id: number): PurchaseRow {
	const p = getRow(ctx, id);
	if (p.status !== 'ordered' && p.status !== 'partial') return p;
	const lines = linesOf(ctx, id);
	let next: PurchaseStatus = 'ordered';
	if (lines.length && lines.every((r) => r.received >= r.l.qtyOrdered)) next = 'received';
	else if (lines.some((r) => r.received > 0)) next = 'partial';
	if (next === p.status) return p;
	return update(ctx, purchase, id, next === 'received' ? { status: next, receivedAt: now() } : { status: next });
}

export function updatePurchase(
	ctx: Ctx,
	i: {
		id: number;
		supplierId?: number | null;
		supplierName?: string | null;
		supplierReference?: string | null;
		reference?: string | null;
		targetDate?: string | null;
		destination?: string | null;
		notes?: string | null;
		status?: PurchaseStatus;
	}
): Purchase {
	const p = getRow(ctx, i.id);
	const touched = Object.keys(i).filter((k) => k !== 'id' && k !== 'notes' && k !== 'status' && (i as never)[k] !== undefined);
	if (!OPEN.includes(p.status) && touched.length) {
		throw conflict('wrong_state', `A ${p.status} purchase order can only have its notes edited`);
	}
	const patch: Partial<typeof purchase.$inferInsert> = {};
	if (i.supplierId) {
		resolveSupplier(ctx, i.supplierId);
		patch.supplierId = i.supplierId;
		patch.supplierName = null;
	} else if (i.supplierName && i.supplierName.trim()) {
		patch.supplierId = null;
		patch.supplierName = i.supplierName.trim();
	}
	const ref = (i.reference ?? '').trim();
	if (ref && ref !== p.reference) {
		assertReferenceFree(ctx, ref, p.id);
		patch.reference = ref;
	}
	if (i.supplierReference !== undefined) patch.supplierReference = i.supplierReference?.trim() || null;
	if (i.targetDate !== undefined) patch.targetDate = i.targetDate;
	if (i.destination !== undefined) patch.destination = i.destination?.trim() || null;
	if (i.notes !== undefined) patch.notes = i.notes;

	if (i.status && i.status !== p.status) {
		if (!PURCHASE_TRANSITIONS[p.status].includes(i.status)) {
			throw conflict('bad_transition', `Cannot move a purchase from ${p.status} to ${i.status}`);
		}
		const lines = linesOf(ctx, p.id);
		if (i.status === 'ordered' && p.status === 'draft') {
			if (!lines.length) throw conflict('no_lines', 'Add at least one line before placing the order');
			patch.orderedAt = now();
		} else if (i.status === 'draft') {
			patch.orderedAt = null;
		}
		patch.status = i.status;
		// Resuming a held order that already took deliveries
		if (i.status === 'ordered' && lines.some((r) => r.received > 0)) patch.status = 'partial';
	}
	if (Object.keys(patch).length) update(ctx, purchase, p.id, patch);
	return getPurchase(ctx, p.id);
}

// ---------------------------------------------------------------- lines

export function addLine(ctx: Ctx, i: LineInput & { id: number }): PurchaseLine {
	const p = getRow(ctx, i.id);
	requireOpen(p, 'add lines');
	const c = checkedLine(ctx, i);
	ensurePartsActive(ctx, [i.partId], `PO ${p.reference} line add`);
	const l = insert(ctx, purchaseLine, {
		purchaseId: p.id,
		partId: i.partId,
		qtyOrdered: c.qty,
		unitCost: c.cost,
		destination: i.destination?.trim() || null,
		notes: i.notes ?? null
	});
	settleStatus(ctx, p.id);
	return presentLine(ctx, l, c.part, 0);
}

export function updateLine(
	ctx: Ctx,
	i: { id: number; lineId: number; qtyOrdered?: string; unitCost?: string | null; destination?: string | null; notes?: string | null }
): PurchaseLine {
	const p = getRow(ctx, i.id);
	requireOpen(p, 'edit lines');
	const l = getLineRow(ctx, p.id, i.lineId);
	const received = receivedByLine(ctx, [l.id]).get(l.id) ?? 0;
	const patch: Partial<typeof purchaseLine.$inferInsert> = {};
	if (i.qtyOrdered !== undefined) {
		const q = parseQty(i.qtyOrdered);
		if (q <= 0) throw invalid('qtyOrdered', 'Quantity must be greater than zero');
		if (q < received) {
			throw invalid('qtyOrdered', `Quantity cannot be below the ${formatQty(received as Qty)} already received`);
		}
		patch.qtyOrdered = q;
	}
	if (i.unitCost !== undefined) {
		const cost = i.unitCost === null ? null : parseMoney('unitCost', i.unitCost);
		if (cost !== l.unitCost && received > 0) {
			throw invalid('unitCost', 'Unit cost is locked once the line has been received (expense records exist)');
		}
		patch.unitCost = cost;
	}
	if (i.destination !== undefined) patch.destination = i.destination?.trim() || null;
	if (i.notes !== undefined) patch.notes = i.notes;
	const row = Object.keys(patch).length ? update(ctx, purchaseLine, l.id, patch) : l;
	settleStatus(ctx, p.id);
	const pt = ctx.db.select().from(part).where(eq(part.id, row.partId)).get()!;
	return presentLine(ctx, row, pt, received);
}

export function removeLine(ctx: Ctx, id: number, lineId: number): void {
	const p = getRow(ctx, id);
	requireOpen(p, 'remove lines');
	const l = getLineRow(ctx, p.id, lineId);
	if ((receivedByLine(ctx, [l.id]).get(l.id) ?? 0) > 0) {
		throw conflict('line_received', 'Cannot delete line that has been partially received');
	}
	remove(ctx, purchaseLine, l.id);
	settleStatus(ctx, p.id);
}

// ---------------------------------------------------------------- receiving

export function receive(
	ctx: Ctx,
	i: {
		id: number;
		lines: { lineId: number; quantity: string; location?: string | null; lotNumber?: string | null; allowOverReceipt: boolean }[];
	}
): Purchase {
	const p = getRow(ctx, i.id);
	if (p.status !== 'ordered' && p.status !== 'partial') {
		throw conflict('wrong_state', `Cannot receive against purchase in ${p.status} status`);
	}
	const seen = new Set<number>();
	for (const r of i.lines) {
		const l = getLineRow(ctx, p.id, r.lineId);
		if (seen.has(l.id)) throw invalid('lines', 'A line can appear only once per receipt');
		seen.add(l.id);
		const qty = parseQty(r.quantity);
		if (qty <= 0) throw invalid('quantity', 'Received quantity must be positive');
		const pt = ctx.db.select().from(part).where(eq(part.id, l.partId)).get()!;
		const got = receivedByLine(ctx, [l.id]).get(l.id) ?? 0;
		const outstanding = l.qtyOrdered - got;
		if (qty > outstanding && !r.allowOverReceipt) {
			throw conflict(
				'over_receipt',
				`${pt.name}: receiving ${formatQty(qty)} exceeds the ${formatQty(Math.max(outstanding, 0) as Qty)} outstanding; confirm the over-receipt to proceed`
			);
		}
		const location = r.location?.trim() || l.destination || p.destination;
		if (!location) throw invalid('location', `${pt.name}: a location is required to receive this line`);
		ensurePartsActive(ctx, [pt.id], `receive against PO ${p.reference}`);
		let lot = r.lotNumber?.trim() || null;
		let serial: string | null = null;
		// A serialized part with one unit takes the typed number as its serial.
		if (pt.trackingType === 'serialized' && lot && qty === QTY_SCALE) [lot, serial] = [null, lot];
		receiveStock(ctx, {
			partId: pt.id,
			quantity: qty as Qty,
			location,
			lotNumber: lot,
			serialNumber: serial,
			sourceType: 'purchase',
			links: { purchaseLineId: l.id }
		});
		insert(ctx, purchaseExpense, {
			purchaseId: p.id,
			kind: 'receipt',
			purchaseLineId: l.id,
			partId: pt.id,
			quantity: qty,
			unitCost: l.unitCost,
			amount: null,
			at: now(),
			notes: null
		});
	}
	const settled = settleStatus(ctx, p.id);
	if (settled.status === 'received') update(ctx, purchase, p.id, { receivedById: actorUserId(ctx.actor) });
	return getPurchase(ctx, p.id);
}

export function receivedRecords(ctx: DbCtx, id: number) {
	getRow(ctx, id);
	const rows = ctx.db
		.select({ m: stockMove, r: stockRecord, p: part })
		.from(stockMove)
		.innerJoin(purchaseLine, eq(purchaseLine.id, stockMove.purchaseLineId))
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(and(eq(purchaseLine.purchaseId, id), eq(stockMove.kind, 'receive')))
		.orderBy(asc(stockMove.id))
		.all();
	return rows.map(({ m, r, p }) => ({
		stockId: r.id,
		opalNumber: r.opalNumber,
		partId: p.id,
		partName: p.name,
		partInternalPn: p.internalPn,
		quantity: formatQty(m.qty as Qty),
		location: r.location,
		lotNumber: r.lotNumber,
		serialNumber: r.serialNumber,
		purchaseLineId: m.purchaseLineId as number,
		receivedAt: m.at
	}));
}

// ---------------------------------------------------------------- expenses

type ExpenseRow = typeof purchaseExpense.$inferSelect;

function presentExpense(e: ExpenseRow, p: { name: string; internalPn: string } | null): PurchaseExpense {
	const total =
		e.kind === 'receipt' ? (e.unitCost === null ? null : lineTotal(e.unitCost, e.quantity as number)) : e.amount;
	return {
		id: e.id,
		purchaseId: e.purchaseId,
		kind: e.kind,
		purchaseLineId: e.purchaseLineId,
		partId: e.partId,
		partName: p?.name ?? null,
		partInternalPn: p?.internalPn ?? null,
		quantity: e.quantity === null ? null : formatQty(e.quantity as Qty),
		unitCost: showMoney(e.kind === 'receipt' ? e.unitCost : e.amount),
		totalCost: showMoney(total),
		at: e.at,
		notes: e.notes
	};
}

export function listExpenses(ctx: DbCtx, id: number): PurchaseExpense[] {
	getRow(ctx, id);
	return ctx.db
		.select({ e: purchaseExpense, p: part })
		.from(purchaseExpense)
		.leftJoin(part, eq(part.id, purchaseExpense.partId))
		.where(eq(purchaseExpense.purchaseId, id))
		.orderBy(asc(purchaseExpense.at), asc(purchaseExpense.id))
		.all()
		.map(({ e, p }) => presentExpense(e, p));
}

export function addCharge(
	ctx: Ctx,
	i: { id: number; kind: Exclude<ExpenseRow['kind'], 'receipt'>; amount: string; note?: string | null }
): PurchaseExpense {
	const p = getRow(ctx, i.id);
	if (p.status === 'cancelled') throw conflict('wrong_state', 'Cannot add charges to a cancelled purchase');
	const note = (i.note ?? '').trim();
	const e = insert(ctx, purchaseExpense, {
		purchaseId: p.id,
		kind: i.kind,
		amount: parseMoney('amount', i.amount),
		at: now(),
		notes: note || null
	});
	return presentExpense(e, null);
}

export function removeCharge(ctx: Ctx, id: number, expenseId: number): void {
	getRow(ctx, id);
	const e = ctx.db
		.select()
		.from(purchaseExpense)
		.where(and(eq(purchaseExpense.id, expenseId), eq(purchaseExpense.purchaseId, id)))
		.get();
	if (!e) throw notFound(`Expense ${expenseId}`);
	if (e.kind === 'receipt') throw conflict('receipt_immutable', 'Receive records are immutable; only charges can be removed');
	remove(ctx, purchaseExpense, e.id);
}

// ---------------------------------------------------------------- part side

export function poLinesForPart(ctx: DbCtx, partId: number) {
	if (!ctx.db.select({ id: part.id }).from(part).where(eq(part.id, partId)).get()) throw notFound(`Part ${partId}`);
	const rows = ctx.db
		.select({ l: purchaseLine, p: purchase, sup: sql<string>`COALESCE(${supplier.name}, ${purchase.supplierName})` })
		.from(purchaseLine)
		.innerJoin(purchase, eq(purchase.id, purchaseLine.purchaseId))
		.leftJoin(supplier, eq(supplier.id, purchase.supplierId))
		.where(eq(purchaseLine.partId, partId))
		.orderBy(desc(purchase.createdAt), desc(purchaseLine.id))
		.all();
	const got = receivedByLine(ctx, rows.map((r) => r.l.id));
	return rows.map(({ l, p, sup }) => ({
		lineId: l.id,
		purchaseId: p.id,
		reference: p.reference,
		supplierName: sup ?? '',
		status: p.status,
		qtyOrdered: formatQty(l.qtyOrdered as Qty),
		qtyReceived: formatQty((got.get(l.id) ?? 0) as Qty),
		unitCost: showMoney(l.unitCost),
		targetDate: p.targetDate
	}));
}


