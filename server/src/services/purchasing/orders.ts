/** Purchase orders: header, lines, status workflow, receiving and the expense ledger. */
import {
	storeDesignator,
	PURCHASE_FINAL_STATUSES,
	PURCHASE_LIVE_STATUSES,
	PURCHASE_OPEN_STATUSES,
	PURCHASE_TRANSITIONS,
	type Purchase,
	type PurchaseChange,
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
import { type SQL, and, asc, desc, eq, gte, inArray, like, lt, notInArray, or, sql } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import {
	attachment,
	auditLog,
	designatorSequence,
	part,
	purchase,
	purchaseExpense,
	purchaseLine,
	stockMove,
	stockRecord,
	supplier,
	user
} from '../../db/schema/index.ts';
import { nextValue } from '../designators.ts';
import { insert, remove, update } from '../../write.ts';
import { receiveStock, receivingRulesFor, today } from '../inventory/index.ts';
import { invalid } from '../inventory/ledger.ts';
import { ensurePartsActive } from '../parts/lifecycle.ts';
import { lineTotal, parseMoney, showMoney } from './money.ts';

type DbCtx = Pick<Ctx, 'db'>;
type PurchaseRow = typeof purchase.$inferSelect;
type LineRow = typeof purchaseLine.$inferSelect;
type PartRow = typeof part.$inferSelect;

const LIVE = PURCHASE_LIVE_STATUSES as readonly string[];
const DONE = PURCHASE_FINAL_STATUSES as readonly string[];

/** What a line still waits for: ordered, less what arrived and what was struck. */
const outstandingOf = (l: Pick<LineRow, 'qtyOrdered' | 'qtyCancelled'>, got: number) =>
	l.qtyOrdered - l.qtyCancelled - got;

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

function costOfLines(lines: { unitCost: number | null; qtyOrdered: number; qtyCancelled: number }[]): string | null {
	const total = lines.reduce(
		(s, l) => (l.unitCost ? s + lineTotal(l.unitCost, l.qtyOrdered - l.qtyCancelled) : s),
		0
	);
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
		autoSerial: rules.autoSerial,
		qtyOrdered: formatQty(l.qtyOrdered as Qty),
		qtyCancelled: formatQty(l.qtyCancelled as Qty),
		qtyReceived: formatQty(received as Qty),
		qtyOutstanding: formatQty(outstandingOf(l, received) as Qty),
		unitCost: showMoney(l.unitCost),
		destination: l.destination,
		notes: l.notes,
		isComplete: outstandingOf(l, received) <= 0
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
	const changes = changesOf(ctx, p);
	const closing = [...changes]
		.reverse()
		.find((c) => c.scope === 'order' && c.field === 'status' && (c.new === 'cancelled' || c.new === 'closed_short'));
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
		changes,
		closedReason: closing?.reason ?? null,
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

// ---------------------------------------------------------------- history

const HEADER_FIELDS = new Set(['status', 'supplierReference', 'targetDate', 'destination', 'notes']);
const LINE_FIELDS = new Set(['qtyOrdered', 'qtyCancelled', 'unitCost', 'destination', 'notes']);

/**
 * Everything that changed on an order since it was placed, from the audit log. Pencil edits
 * before placing are not history. A quantity or a cost in the log is the stored integer; the page
 * gets the decimal.
 */
function changesOf(ctx: DbCtx, p: PurchaseRow): PurchaseChange[] {
	if (!p.orderedAt) return [];
	const lineRows = ctx.db
		.select({ id: purchaseLine.id, pn: part.internalPn, uom: part.unitOfMeasure })
		.from(purchaseLine)
		.innerJoin(part, eq(part.id, purchaseLine.partId))
		.where(eq(purchaseLine.purchaseId, p.id))
		.all();
	const byLine = new Map(lineRows.map((l) => [l.id, l]));
	const lineScope = lineRows.length
		? and(eq(auditLog.entity, 'purchase_line'), inArray(auditLog.entityId, lineRows.map((l) => l.id)))
		: undefined;
	const rows = ctx.db
		.select({ e: auditLog, userName: user.name })
		.from(auditLog)
		.leftJoin(user, eq(user.id, auditLog.actorUserId))
		.where(
			and(
				gte(auditLog.at, p.orderedAt),
				or(and(eq(auditLog.entity, 'purchase'), eq(auditLog.entityId, p.id)), lineScope)
			)
		)
		.orderBy(asc(auditLog.at), asc(auditLog.id))
		.all();
	// A draft edit can land in the same millisecond as placing. The audit order decides which side it is on.
	const placedRow = rows.find(
		({ e }) =>
			e.entity === 'purchase' &&
			e.action === 'update' &&
			!(e.before as { orderedAt?: string | null } | null)?.orderedAt &&
			(e.after as { orderedAt?: string | null } | null)?.orderedAt
	);
	const out: PurchaseChange[] = [];
	for (const { e, userName } of rows) {
		if (placedRow && e.id < placedRow.e.id) continue;
		const before = (e.before ?? {}) as Record<string, unknown>;
		const after = (e.after ?? {}) as Record<string, unknown>;
		const base = { at: e.at, userName, reason: e.reason };
		if (e.entity === 'purchase') {
			if (e.action !== 'update') continue;
			for (const f of HEADER_FIELDS) {
				if (JSON.stringify(before[f] ?? null) === JSON.stringify(after[f] ?? null)) continue;
				out.push({
					...base,
					scope: 'order',
					lineId: null,
					partInternalPn: null,
					unitOfMeasure: null,
					field: f,
					old: (before[f] as string | null) ?? null,
					new: (after[f] as string | null) ?? null
				});
			}
			continue;
		}
		const line = byLine.get(e.entityId);
		if (!line) continue;
		const shown = (f: string, v: unknown): string | null => {
			if (v == null) return null;
			if (f === 'qtyOrdered' || f === 'qtyCancelled') return formatQty(v as Qty);
			if (f === 'unitCost') return showMoney(v as number);
			return String(v);
		};
		const lineBase = { ...base, scope: 'line' as const, lineId: line.id, partInternalPn: line.pn, unitOfMeasure: line.uom };
		if (e.action === 'create') {
			out.push({ ...lineBase, field: 'line', old: null, new: shown('qtyOrdered', after.qtyOrdered) });
			continue;
		}
		for (const f of LINE_FIELDS) {
			if (JSON.stringify(before[f] ?? null) === JSON.stringify(after[f] ?? null)) continue;
			out.push({ ...lineBase, field: f, old: shown(f, before[f]), new: shown(f, after[f]) });
		}
	}
	return out;
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
			linesComplete: lines.filter((l) => outstandingOf(l, got.get(l.id) ?? 0) <= 0).length,
			totalCost: costOfLines(lines),
			createdAt: p.createdAt
		};
	});
	return { items, next: offset + rows.length < total ? String(offset + rows.length) : null, total };
}

// ---------------------------------------------------------------- create and edit

const PO_PREFIX = 'PO';
/** The stored form has 10 digits, so a PO sequence stays in 1..MAX_PO_SEQUENCE. */
const MAX_PO_SEQUENCE = 9_999_999_999;

/**
 * PO-<sequence> from a counter that only goes up, stored at full width. A database from
 * before the counter has no row: the first use starts it at the highest PO-<digits> reference
 * in use, so no number in use is handed out again.
 */
export function nextReference(ctx: DbCtx): string {
	const row = ctx.db.select().from(designatorSequence).where(eq(designatorSequence.prefix, PO_PREFIX)).get();
	if (!row) {
		let max = 0;
		for (const r of ctx.db.select({ r: purchase.reference }).from(purchase).where(like(purchase.reference, 'PO-%')).all()) {
			const m = /^PO-(\d{1,10})$/.exec(r.r);
			if (m) max = Math.max(max, Number(m[1]));
		}
		ctx.db.insert(designatorSequence).values({ prefix: PO_PREFIX, lastValue: max }).run();
	}
	const sequence = nextValue(ctx, PO_PREFIX);
	if (sequence > MAX_PO_SEQUENCE) throw conflict('numbers_exhausted', 'No free PO number found');
	return storeDesignator('PO', sequence);
}

function resolveSupplier(ctx: DbCtx, id: number) {
	const s = ctx.db.select().from(supplier).where(eq(supplier.id, id)).get();
	if (!s) throw notFound(`Supplier ${id}`);
	return s;
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
	const reference = nextReference(ctx);
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

type LineWithGot = { l: LineRow; received: number };

/**
 * What the lines say the status is: waiting, partly in, or finished. Finished is received when
 * nothing was struck, closed short when something arrived and something was struck, and
 * cancelled when everything was struck and nothing arrived.
 */
function statusFromLines(lines: LineWithGot[]): PurchaseStatus {
	if (lines.length && lines.every((r) => outstandingOf(r.l, r.received) <= 0)) {
		if (!lines.some((r) => r.l.qtyCancelled > 0)) return 'received';
		return lines.some((r) => r.received > 0) ? 'closed_short' : 'cancelled';
	}
	return lines.some((r) => r.received > 0) ? 'partial' : 'ordered';
}

/** ordered / partial / received / closed short follow from the lines. Draft and held orders stay. */
function settleStatus(ctx: Ctx, id: number, reason?: string): PurchaseRow {
	const p = getRow(ctx, id);
	if (!LIVE.includes(p.status)) return p;
	const next = statusFromLines(linesOf(ctx, id));
	if (next === p.status) return p;
	return update(ctx, purchase, id, next === 'received' ? { status: next, receivedAt: now() } : { status: next }, reason);
}

const needReason = (reason: string) => {
	const r = reason.trim();
	if (!r) throw invalid('reason', 'Give a reason');
	return r;
};

export function updatePurchase(
	ctx: Ctx,
	i: {
		id: number;
		supplierId?: number | null;
		supplierName?: string | null;
		supplierReference?: string | null;
		targetDate?: string | null;
		destination?: string | null;
		notes?: string | null;
	}
): Purchase {
	const p = getRow(ctx, i.id);
	const touched = (k: keyof typeof i) => i[k] !== undefined;
	const changesSupplier = touched('supplierId') || touched('supplierName');
	if (p.status !== 'draft') {
		if (changesSupplier) {
			throw conflict('supplier_locked', 'The supplier does not change after placing. Cancel the order and copy it to a new draft');
		}
		const header = touched('supplierReference') || touched('targetDate') || touched('destination');
		if (header && !LIVE.includes(p.status)) {
			throw conflict('wrong_state', `A ${p.status} purchase order can only have its notes edited`);
		}
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
	if (i.supplierReference !== undefined) patch.supplierReference = i.supplierReference?.trim() || null;
	if (i.targetDate !== undefined) patch.targetDate = i.targetDate;
	if (i.destination !== undefined) patch.destination = i.destination?.trim() || null;
	if (i.notes !== undefined) patch.notes = i.notes;
	if (Object.keys(patch).length) update(ctx, purchase, p.id, patch);
	return getPurchase(ctx, p.id);
}

// ---------------------------------------------------------------- status acts

/** Place a draft: the commit moment. */
export function place(ctx: Ctx, id: number): Purchase {
	const p = getRow(ctx, id);
	if (p.status !== 'draft') throw conflict('wrong_state', `Cannot place a purchase order that is ${p.status}`);
	const lines = linesOf(ctx, id);
	if (!lines.length) throw conflict('no_lines', 'Add at least one line before placing the order');
	ensurePartsActive(ctx, lines.map((r) => r.l.partId), `placing PO ${p.reference}`);
	update(ctx, purchase, id, { status: 'ordered', orderedAt: now() });
	return getPurchase(ctx, id);
}

function requireTransition(p: PurchaseRow, to: PurchaseStatus, act: string): void {
	if (!PURCHASE_TRANSITIONS[p.status].includes(to)) {
		throw conflict('bad_transition', `Cannot ${act} a purchase order that is ${p.status}`);
	}
}

export function hold(ctx: Ctx, id: number, reason?: string): Purchase {
	const p = getRow(ctx, id);
	requireTransition(p, 'on_hold', 'put on hold');
	update(ctx, purchase, id, { status: 'on_hold' }, reason?.trim() || undefined);
	return getPurchase(ctx, id);
}

export function resume(ctx: Ctx, id: number): Purchase {
	const p = getRow(ctx, id);
	if (p.status !== 'on_hold') throw conflict('bad_transition', `Cannot resume a purchase order that is ${p.status}`);
	const next = statusFromLines(linesOf(ctx, id));
	update(ctx, purchase, id, { status: next, ...(next === 'received' ? { receivedAt: now() } : {}) });
	return getPurchase(ctx, id);
}

/** Strike every outstanding quantity of the order, with the order's reason. */
function strikeOutstanding(ctx: Ctx, id: number, reason: string): void {
	for (const r of linesOf(ctx, id)) {
		const open = outstandingOf(r.l, r.received);
		if (open > 0) update(ctx, purchaseLine, r.l.id, { qtyCancelled: r.l.qtyCancelled + open }, reason);
	}
}

/** Strike an order nothing arrived against. */
export function cancel(ctx: Ctx, id: number, reason: string): Purchase {
	const why = needReason(reason);
	const p = getRow(ctx, id);
	if (LIVE.includes(p.status) || p.status === 'on_hold') {
		if (linesOf(ctx, id).some((r) => r.received > 0)) {
			throw conflict('has_receipts', 'Stock arrived against this order. Close it short instead');
		}
	}
	requireTransition(p, 'cancelled', 'cancel');
	strikeOutstanding(ctx, id, why);
	update(ctx, purchase, id, { status: 'cancelled' }, why);
	return getPurchase(ctx, id);
}

/** Close an order that took part of its goods. The shortfall is struck, what arrived stays. */
export function closeShort(ctx: Ctx, id: number, reason: string): Purchase {
	const why = needReason(reason);
	const p = getRow(ctx, id);
	requireTransition(p, 'closed_short', 'close short');
	if (!linesOf(ctx, id).some((r) => r.received > 0)) {
		throw conflict('nothing_received', 'Nothing arrived against this order. Cancel it instead');
	}
	strikeOutstanding(ctx, id, why);
	update(ctx, purchase, id, { status: 'closed_short' }, why);
	return getPurchase(ctx, id);
}

/** Delete a draft. Nothing refers to it: no receipt, no stock, no signature. */
export function discard(ctx: Ctx, id: number): void {
	const p = getRow(ctx, id);
	if (p.status !== 'draft') {
		throw conflict('wrong_state', `A ${p.status} purchase order is cancelled, not deleted`);
	}
	for (const e of ctx.db.select().from(purchaseExpense).where(eq(purchaseExpense.purchaseId, id)).all()) {
		remove(ctx, purchaseExpense, e.id);
	}
	for (const l of ctx.db.select().from(purchaseLine).where(eq(purchaseLine.purchaseId, id)).all()) {
		remove(ctx, purchaseLine, l.id);
	}
	for (const a of ctx.db
		.select()
		.from(attachment)
		.where(and(eq(attachment.ownerType, 'purchase'), eq(attachment.ownerId, id)))
		.all()) {
		remove(ctx, attachment, a.id);
	}
	remove(ctx, purchase, id);
}

/** File a new draft with the same supplier and lines. */
export function copyToDraft(ctx: Ctx, id: number): Purchase {
	const p = getRow(ctx, id);
	if (!DONE.includes(p.status)) {
		throw conflict('wrong_state', `A ${p.status} purchase order is still live. Copy it once it is received, closed short or cancelled`);
	}
	return createPurchase(ctx, {
		supplierId: p.supplierId,
		supplierName: p.supplierName,
		destination: p.destination,
		lines: linesOf(ctx, id).map((r) => ({
			partId: r.l.partId,
			qtyOrdered: formatQty(r.l.qtyOrdered as Qty),
			unitCost: showMoney(r.l.unitCost),
			destination: r.l.destination,
			notes: r.l.notes
		}))
	});
}

// ---------------------------------------------------------------- lines

export function addLine(ctx: Ctx, i: LineInput & { id: number }): PurchaseLine {
	const p = getRow(ctx, i.id);
	if (p.status !== 'draft' && !LIVE.includes(p.status)) {
		throw conflict('wrong_state', `Cannot add lines on a purchase in ${p.status} status`);
	}
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

const penciled = (p: PurchaseRow) =>
	conflict('line_locked', `Lines of an order that has been placed are amended or cancelled, not edited or removed`);

/** Draft only. A placed order amends (amendLine) or strikes (cancelLine). */
export function updateLine(
	ctx: Ctx,
	i: { id: number; lineId: number; qtyOrdered?: string; unitCost?: string | null; destination?: string | null; notes?: string | null }
): PurchaseLine {
	const p = getRow(ctx, i.id);
	if (p.status !== 'draft') throw penciled(p);
	const l = getLineRow(ctx, p.id, i.lineId);
	const patch: Partial<typeof purchaseLine.$inferInsert> = {};
	if (i.qtyOrdered !== undefined) {
		const q = parseQty(i.qtyOrdered);
		if (q <= 0) throw invalid('qtyOrdered', 'Quantity must be greater than zero');
		patch.qtyOrdered = q;
	}
	if (i.unitCost !== undefined) patch.unitCost = i.unitCost === null ? null : parseMoney('unitCost', i.unitCost);
	if (i.destination !== undefined) patch.destination = i.destination?.trim() || null;
	if (i.notes !== undefined) patch.notes = i.notes;
	const row = Object.keys(patch).length ? update(ctx, purchaseLine, l.id, patch) : l;
	const pt = ctx.db.select().from(part).where(eq(part.id, row.partId)).get()!;
	return presentLine(ctx, row, pt, 0);
}

export function removeLine(ctx: Ctx, id: number, lineId: number): void {
	const p = getRow(ctx, id);
	if (p.status !== 'draft') throw penciled(p);
	remove(ctx, purchaseLine, getLineRow(ctx, p.id, lineId).id);
}

/** Correct a placed line. The old value stays in the audit row, the reason beside it. */
export function amendLine(
	ctx: Ctx,
	i: { id: number; lineId: number; qtyOrdered?: string; unitCost?: string | null; destination?: string | null; reason: string }
): PurchaseLine {
	const why = needReason(i.reason);
	const p = getRow(ctx, i.id);
	if (!LIVE.includes(p.status)) throw conflict('wrong_state', `Cannot amend lines on a purchase in ${p.status} status`);
	const l = getLineRow(ctx, p.id, i.lineId);
	const received = receivedByLine(ctx, [l.id]).get(l.id) ?? 0;
	const patch: Partial<typeof purchaseLine.$inferInsert> = {};
	if (i.qtyOrdered !== undefined) {
		const q = parseQty(i.qtyOrdered);
		if (q <= 0) throw invalid('qtyOrdered', 'Quantity must be greater than zero');
		const floor = received + l.qtyCancelled;
		if (q < floor) {
			throw invalid('qtyOrdered', `Quantity cannot be below the ${formatQty(floor as Qty)} already received or struck`);
		}
		if (q !== l.qtyOrdered) patch.qtyOrdered = q;
	}
	if (i.unitCost !== undefined) {
		const cost = i.unitCost === null ? null : parseMoney('unitCost', i.unitCost);
		if (cost !== l.unitCost) {
			if (received > 0) {
				throw invalid('unitCost', 'Unit cost is locked once the line has been received (expense records exist)');
			}
			patch.unitCost = cost;
		}
	}
	if (i.destination !== undefined) {
		const d = i.destination?.trim() || null;
		if (d !== l.destination) patch.destination = d;
	}
	if (!Object.keys(patch).length) throw invalid('reason', 'Nothing to amend: every value is the same');
	const row = update(ctx, purchaseLine, l.id, patch, why);
	settleStatus(ctx, p.id);
	const pt = ctx.db.select().from(part).where(eq(part.id, row.partId)).get()!;
	return presentLine(ctx, row, pt, received);
}

/** Strike what is still outstanding on a line. What arrived stays received. */
export function cancelLine(ctx: Ctx, i: { id: number; lineId: number; reason: string }): PurchaseLine {
	const why = needReason(i.reason);
	const p = getRow(ctx, i.id);
	if (!LIVE.includes(p.status)) throw conflict('wrong_state', `Cannot cancel lines on a purchase in ${p.status} status`);
	const l = getLineRow(ctx, p.id, i.lineId);
	const received = receivedByLine(ctx, [l.id]).get(l.id) ?? 0;
	const open = outstandingOf(l, received);
	if (open <= 0) throw conflict('nothing_outstanding', 'Nothing is outstanding on this line');
	const row = update(ctx, purchaseLine, l.id, { qtyCancelled: l.qtyCancelled + open }, why);
	settleStatus(ctx, p.id, why);
	const pt = ctx.db.select().from(part).where(eq(part.id, row.partId)).get()!;
	return presentLine(ctx, row, pt, received);
}

// ---------------------------------------------------------------- receiving

export function receive(
	ctx: Ctx,
	i: {
		id: number;
		lines: { lineId: number; quantity: string; location?: string | null; serialNumber?: string | null; allowOverReceipt: boolean }[];
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
		const outstanding = outstandingOf(l, got);
		if (qty > outstanding && !r.allowOverReceipt) {
			throw conflict(
				'over_receipt',
				`${pt.name}: receiving ${formatQty(qty)} exceeds the ${formatQty(Math.max(outstanding, 0) as Qty)} outstanding; confirm the over-receipt to proceed`
			);
		}
		const location = r.location?.trim() || l.destination || p.destination;
		if (!location) throw invalid('location', `${pt.name}: a location is required to receive this line`);
		ensurePartsActive(ctx, [pt.id], `receive against PO ${p.reference}`);
		const serial = r.serialNumber?.trim() || null;
		if (serial && (pt.trackingType !== 'serialized' || qty !== QTY_SCALE)) {
			throw invalid('serialNumber', `${pt.name}: a serial number applies to one serialized unit`);
		}
		// The order is the lot: everything received against it traces back to one purchase.
		receiveStock(ctx, {
			partId: pt.id,
			quantity: qty as Qty,
			location,
			lotNumber: p.reference,
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

function presentExpense(
	e: ExpenseRow,
	p: { name: string; internalPn: string; unitOfMeasure: string } | null,
	struckByName: string | null = null
): PurchaseExpense {
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
		unitOfMeasure: p?.unitOfMeasure ?? null,
		quantity: e.quantity === null ? null : formatQty(e.quantity as Qty),
		unitCost: showMoney(e.kind === 'receipt' ? e.unitCost : e.amount),
		totalCost: showMoney(total),
		at: e.at,
		notes: e.notes,
		struck: e.struckAt === null ? null : { at: e.struckAt, byName: struckByName, reason: e.strikeReason ?? '' }
	};
}

export function listExpenses(ctx: DbCtx, id: number): PurchaseExpense[] {
	getRow(ctx, id);
	return ctx.db
		.select({ e: purchaseExpense, p: part, by: user.name })
		.from(purchaseExpense)
		.leftJoin(part, eq(part.id, purchaseExpense.partId))
		.leftJoin(user, eq(user.id, purchaseExpense.struckById))
		.where(eq(purchaseExpense.purchaseId, id))
		.orderBy(asc(purchaseExpense.at), asc(purchaseExpense.id))
		.all()
		.map(({ e, p, by }) => presentExpense(e, p, by));
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

function chargeRow(ctx: DbCtx, id: number, expenseId: number): ExpenseRow {
	const e = ctx.db
		.select()
		.from(purchaseExpense)
		.where(and(eq(purchaseExpense.id, expenseId), eq(purchaseExpense.purchaseId, id)))
		.get();
	if (!e) throw notFound(`Expense ${expenseId}`);
	if (e.kind === 'receipt') throw conflict('receipt_immutable', 'Receive records are immutable; only charges can change');
	return e;
}

/** A draft is pencil, so its charge can go. On a placed order the charge is struck instead. */
export function removeCharge(ctx: Ctx, id: number, expenseId: number): void {
	const p = getRow(ctx, id);
	const e = chargeRow(ctx, id, expenseId);
	if (p.status !== 'draft') {
		throw conflict('charge_committed', `A charge on a ${p.status} order stays on the page. Strike it with a reason`);
	}
	remove(ctx, purchaseExpense, e.id);
}

/** The charge stays listed with who, when and why, and stops counting toward the total. */
export function strikeCharge(ctx: Ctx, id: number, expenseId: number, reason: string): PurchaseExpense {
	const p = getRow(ctx, id);
	const e = chargeRow(ctx, id, expenseId);
	if (p.status === 'draft') throw conflict('wrong_state', 'A charge on a draft is removed, not struck');
	if (e.struckAt !== null) throw conflict('already_struck', 'The charge is already struck');
	const by = actorUserId(ctx.actor);
	const struck = update(ctx, purchaseExpense, e.id, { struckAt: now(), struckById: by, strikeReason: reason.trim() }, reason.trim());
	const byName = by === null ? null : (ctx.db.select({ name: user.name }).from(user).where(eq(user.id, by)).get()?.name ?? null);
	return presentExpense(struck, null, byName);
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


