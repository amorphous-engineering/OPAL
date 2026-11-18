/**
 * Material: the kit check, consumption (procedure level and step level), production, the BOM
 * reconciliation and finalize. Stock changes are ledger moves written by the inventory area;
 * this file links them to the execution and the step through the move's link columns.
 */
import {
	type DocConsumption,
	type ProductionRow,
	type Qty,
	OpalError,
	formatQty,
	notFound,
	parseQty
} from '@opal/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { executionOutput, part, stockMove, stockRecord } from '../../db/schema/index.ts';
import { update } from '../../write.ts';
import { balancesForPart, consumeStock, produceStock } from '../inventory/index.ts';
import { ensurePartsActive } from '../parts/lifecycle.ts';
import { getRow, isActive, loadModel, type Model, opRowOf, type Row } from './model.ts';
import { intoStockOf } from './units.ts';

// ---------------------------------------------------------------- consumption rows

export function consumptionRows(db: Db, m: Model, only?: { stepId: number }): DocConsumption[] {
	const rows = db
		.select({ mv: stockMove, rec: stockRecord, p: part })
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(
			and(
				eq(stockMove.executionId, m.exec.id),
				eq(stockMove.kind, 'consume'),
				only ? eq(stockMove.stepExecutionId, only.stepId) : undefined
			)
		)
		.orderBy(stockMove.id)
		.all();
	return rows.map(({ mv, rec, p }) => ({
		id: mv.id,
		stockId: rec.id,
		partId: p.id,
		partNumber: p.internalPn,
		partName: p.name,
		opalNumber: rec.opalNumber,
		quantity: formatQty(-mv.qty as Qty),
		uom: p.unitOfMeasure,
		lotNumber: rec.lotNumber,
		location: rec.location,
		usage: mv.reason === 'tooling' ? 'tooling' : 'consume',
		stepId: mv.stepExecutionId,
		stepNumber: mv.stepExecutionId === null ? null : (m.byId.get(mv.stepExecutionId)?.number ?? null)
	}));
}

export function listConsumptions(ctx: Pick<Ctx, 'db'>, executionId: number, stepId?: number) {
	const m = loadModel(ctx.db, executionId);
	if (stepId !== undefined) getRow(m, stepId);
	return consumptionRows(ctx.db, m, stepId === undefined ? undefined : { stepId });
}

// ---------------------------------------------------------------- kit check

export function kitAvailability(ctx: Pick<Ctx, 'db'>, executionId: number) {
	const m = loadModel(ctx.db, executionId);
	const ids = m.snapshot.kit.map((k) => k.partId);
	const parts = new Map(ids.length ? ctx.db.select().from(part).where(inArray(part.id, ids)).all().map((p) => [p.id, p]) : []);
	const items = m.snapshot.kit.map((k) => {
		const p = parts.get(k.partId)!;
		const stock = balancesForPart(ctx, k.partId).filter((b) => b.balance > 0);
		const available = stock.reduce((n, b) => n + b.balance, 0) as Qty;
		const required = parseQty(k.quantity);
		return {
			partId: p.id,
			partNumber: p.internalPn,
			partName: p.name,
			uom: p.unitOfMeasure,
			quantityRequired: k.quantity,
			quantityAvailable: formatQty(available),
			isAvailable: available >= required,
			locations: stock.map((b) => ({
				stockId: b.stockId,
				opalNumber: b.opalNumber,
				location: b.location,
				lotNumber: b.lotNumber,
				quantity: formatQty(b.balance)
			}))
		};
	});
	return { executionId, allAvailable: items.every((i) => i.isAvailable), items };
}

// ---------------------------------------------------------------- consume

function intoOther(stockId: number, into: number | null): number | null {
	if (into !== null && stockId === into) throw new OpalError(422, 'invalid_input', 'A unit cannot go into itself', { into: 'the same unit' });
	return into;
}

/** Material moves belong to the work done; a closed work order's record stays as signed. */
function requireOpen(m: Model) {
	if (!isActive(m.exec)) {
		throw new OpalError(409, 'execution_closed', `Material does not move on a work order that is ${m.exec.status.replace('_', ' ')}`);
	}
}

interface Line {
	stockId: number;
	quantity: string;
	usage: 'consume' | 'tooling';
	into?: string | null;
}

export function consume(ctx: Ctx, input: { id: number; stepId?: number; items: Line[]; notes?: string | null }) {
	const m = loadModel(ctx.db, input.id);
	requireOpen(m);
	const row = input.stepId === undefined ? null : getRow(m, input.stepId);
	if (row?.draft) throw new OpalError(409, 'redline_draft', `${row.number} is part of a draft redline; nothing is consumed there until it is released`);
	const stocks = ctx.db
		.select({ id: stockRecord.id, partId: stockRecord.partId })
		.from(stockRecord)
		.where(inArray(stockRecord.id, input.items.map((i) => i.stockId)))
		.all();
	const byId = new Map(stocks.map((s) => [s.id, s]));
	for (const i of input.items) if (!byId.has(i.stockId)) throw notFound(`Stock record ${i.stockId}`);
	// A consumption never references a draft part.
	ensurePartsActive(ctx, stocks.map((s) => s.partId), row ? 'step consumption' : 'procedure consumption');
	const links = { executionId: m.exec.id, ...(row ? { stepExecutionId: row.id } : {}) };
	for (const i of input.items) {
		if (i.into && i.usage === 'tooling') throw new OpalError(422, 'invalid_input', 'Tooling is returned; only consumed material is installed', { into: 'consume only' });
	}
	const moveIds: number[] = [];
	for (const i of input.items) {
		const mv = consumeStock(ctx, {
			stockId: i.stockId,
			quantity: parseQty(i.quantity),
			tooling: i.usage === 'tooling',
			notes: input.notes,
			intoStockId: i.into ? intoOther(i.stockId, intoStockOf(m, i.into)) : null,
			links
		});
		moveIds.push(mv.id);
	}
	const mm = loadModel(ctx.db, input.id);
	const done = new Set(moveIds);
	return consumptionRows(ctx.db, mm)
		.filter((c) => done.has(c.id))
		.map((c) => ({
			id: c.id,
			stockId: c.stockId,
			partId: c.partId,
			partName: c.partName,
			quantity: c.quantity,
			location: c.location,
			lotNumber: c.lotNumber
		}));
}

// ---------------------------------------------------------------- production

type OutputPlan = typeof executionOutput.$inferSelect;

function produceMoves(db: Db, executionId: number) {
	return db
		.select()
		.from(stockMove)
		.where(and(eq(stockMove.executionId, executionId), eq(stockMove.kind, 'produce')))
		.orderBy(stockMove.id)
		.all();
}

export function productionRows(db: Db, m: Model): ProductionRow[] {
	const plans = db.select().from(executionOutput).where(eq(executionOutput.executionId, m.exec.id)).orderBy(executionOutput.id).all();
	const moves = produceMoves(db, m.exec.id);
	const stockIds = [...new Set([...plans.map((p) => p.stockId), ...moves.map((x) => x.stockId)])];
	if (!stockIds.length) return [];
	const recs = new Map(
		db
			.select({ rec: stockRecord, p: part })
			.from(stockRecord)
			.innerJoin(part, eq(part.id, stockRecord.partId))
			.where(inArray(stockRecord.id, stockIds))
			.all()
			.map((r) => [r.rec.id, r])
	);
	const out: ProductionRow[] = [];
	const row = (stockId: number, qty: number, status: ProductionRow['status']): ProductionRow => {
		const { rec, p } = recs.get(stockId)!;
		return {
			id: stockId,
			stockId,
			partId: p.id,
			partNumber: p.internalPn,
			partName: p.name,
			serialNumber: rec.serialNumber,
			opalNumber: rec.opalNumber,
			quantity: formatQty(qty as Qty),
			uom: p.unitOfMeasure,
			lotNumber: rec.lotNumber,
			location: rec.location,
			status
		};
	};
	const booked = new Map<number, number>();
	for (const mv of moves) booked.set(mv.stockId, (booked.get(mv.stockId) ?? 0) + mv.qty);
	const planned = new Set(plans.map((p) => p.stockId));
	for (const p of plans) {
		out.push(row(p.stockId, booked.get(p.stockId) ?? p.quantity, booked.has(p.stockId) ? 'completed' : m.exec.status === 'cut' ? 'planned' : 'wip'));
	}
	for (const [stockId, qty] of booked) if (!planned.has(stockId)) out.push(row(stockId, qty, 'completed'));
	return out;
}

export function listProductions(ctx: Pick<Ctx, 'db'>, executionId: number) {
	return productionRows(ctx.db, loadModel(ctx.db, executionId));
}

export function outputsOf(ctx: Pick<Ctx, 'db'>, executionId: number) {
	const m = loadModel(ctx.db, executionId);
	const parts = new Map(
		m.snapshot.outputs.length
			? ctx.db.select().from(part).where(inArray(part.id, m.snapshot.outputs.map((o) => o.partId))).all().map((p) => [p.id, p])
			: []
	);
	return m.snapshot.outputs.map((o) => ({
		partId: o.partId,
		partNumber: parts.get(o.partId)!.internalPn,
		partName: parts.get(o.partId)!.name,
		uom: parts.get(o.partId)!.unitOfMeasure,
		quantity: o.quantity
	}));
}

export function produce(
	ctx: Ctx,
	input: {
		id: number;
		items: { partId: number; quantity: string; location: string; lotNumber?: string | null; serialNumber?: string | null }[];
		notes?: string | null;
	}
) {
	const m = loadModel(ctx.db, input.id);
	requireOpen(m);
	// A produced as-built item is a physical reference: draft parts block it.
	ensurePartsActive(ctx, input.items.map((i) => i.partId), 'production output (as-built)');
	const stockIds: number[] = [];
	for (const i of input.items) {
		const r = produceStock(ctx, {
			partId: i.partId,
			quantity: parseQty(i.quantity),
			location: i.location,
			lotNumber: i.lotNumber,
			serialNumber: i.serialNumber,
			notes: input.notes,
			links: { executionId: m.exec.id }
		});
		stockIds.push(r.stock.id);
	}
	const made = new Set(stockIds);
	return productionRows(ctx.db, loadModel(ctx.db, input.id)).filter((p) => made.has(p.stockId));
}

// ---------------------------------------------------------------- reconciliation

/** Planned kit lines replaced by a released redline: `${stepId}:${partId}` to the redline OP. */
export function struckLines(m: Model): Map<string, Row> {
	const out = new Map<string, Row>();
	for (const r of m.rows) {
		if (r.level !== 0 || !r.adhoc || r.draft) continue;
		for (const x of r.adhoc.strikes ?? []) out.set(`${x.stepId}:${x.partId}`, r);
	}
	return out;
}

/**
 * The kit against what was consumed. Expected is the procedure kit and every consumed step kit
 * line, released redline steps included, less the lines a released redline replaced. A replaced
 * line is listed apart with what was consumed at its step before the redline, so that consumption
 * is neither counted against the new plan nor reported as unplanned.
 */
export function reconcile(db: Db, m: Model) {
	const struck = struckLines(m);
	const consumed = new Map<number, number>();
	const consumedAt = new Map<string, number>();
	for (const c of consumptionRows(db, m)) {
		if (c.usage !== 'consume') continue;
		const at = `${c.stepId}:${c.partId}`;
		if (struck.has(at)) {
			consumedAt.set(at, (consumedAt.get(at) ?? 0) + parseQty(c.quantity));
			continue;
		}
		consumed.set(c.partId, (consumed.get(c.partId) ?? 0) + parseQty(c.quantity));
	}
	const expected = new Map<number, number>();
	const addedBy = new Map<number, string>();
	const add = (partId: number, qty: string) => expected.set(partId, (expected.get(partId) ?? 0) + parseQty(qty));
	for (const k of m.snapshot.kit) if (!struck.has(`null:${k.partId}`)) add(k.partId, k.quantity);
	for (const r of m.rows) {
		if (r.draft) continue;
		for (const k of r.kit) {
			if (k.usage !== 'consume' || struck.has(`${r.id}:${k.partId}`)) continue;
			add(k.partId, k.quantity);
			if (r.adhoc && !addedBy.has(k.partId)) addedBy.set(k.partId, opRowOf(m, r).number);
		}
	}
	const struckRows = [...struck].map(([key, op]) => {
		const [step, partId] = key.split(':');
		const stepId = step === 'null' ? null : Number(step);
		const row = stepId === null ? null : (m.byId.get(stepId) ?? null);
		const line = (row ? row.kit : m.snapshot.kit).find((k) => k.partId === Number(partId));
		return { key, stepId, row, partId: Number(partId), quantity: line?.quantity ?? '0', op };
	});
	const ids = [...new Set([...expected.keys(), ...consumed.keys(), ...struckRows.map((x) => x.partId)])];
	const parts = new Map(ids.length ? db.select().from(part).where(inArray(part.id, ids)).all().map((p) => [p.id, p]) : []);
	const kitItems = [...expected].map(([partId, req]) => {
		const got = consumed.get(partId) ?? 0;
		consumed.delete(partId);
		const p = parts.get(partId)!;
		return {
			partId,
			partNumber: p.internalPn,
			partName: p.name,
			uom: p.unitOfMeasure,
			qtyRequired: formatQty(req as Qty),
			qtyConsumed: formatQty(got as Qty),
			variance: formatQty((got - req) as Qty),
			addedBy: addedBy.get(partId) ?? null
		};
	});
	const struckOut = struckRows.map((x) => {
		const p = parts.get(x.partId)!;
		return {
			partId: x.partId,
			partNumber: p.internalPn,
			partName: p.name,
			uom: p.unitOfMeasure,
			quantity: x.quantity,
			qtyConsumed: formatQty((consumedAt.get(x.key) ?? 0) as Qty),
			stepNumber: x.row?.number ?? null,
			redline: x.op.number,
			redlineStepId: x.op.id
		};
	});
	const unplanned = [...consumed].map(([partId, qty]) => {
		const p = parts.get(partId)!;
		return { partId, partNumber: p.internalPn, partName: p.name, uom: p.unitOfMeasure, qtyConsumed: formatQty(qty as Qty) };
	});
	return { kitItems, struck: struckOut, unplanned };
}

export function bom(ctx: Pick<Ctx, 'db'>, executionId: number) {
	const m = loadModel(ctx.db, executionId);
	return { ...reconcile(ctx.db, m), outputs: productionRows(ctx.db, m) };
}

// ---------------------------------------------------------------- finalize

/** Planned outputs nothing was booked against yet. */
export function unbooked(db: Db, executionId: number): OutputPlan[] {
	const booked = new Set(produceMoves(db, executionId).map((x) => x.stockId));
	return db
		.select()
		.from(executionOutput)
		.where(eq(executionOutput.executionId, executionId))
		.all()
		.filter((p) => !booked.has(p.stockId));
}

export function finalize(ctx: Ctx, input: { id: number; location: string; notes?: string | null }) {
	const m = loadModel(ctx.db, input.id);
	if (m.exec.status !== 'completed') throw new OpalError(409, 'not_completed', 'Execution must be completed before finalizing production');
	const plans = unbooked(ctx.db, input.id);
	if (!plans.length) throw new OpalError(409, 'nothing_to_finalize', 'No planned production to finalize');
	// Components: consume moves of this execution not yet linked to an assembly. A move links to
	// one assembly only, so with several outputs the components go to the first.
	const componentMoveIds = ctx.db
		.select({ id: stockMove.id })
		.from(stockMove)
		.where(
			and(
				eq(stockMove.executionId, input.id),
				eq(stockMove.kind, 'consume'),
				isNull(stockMove.intoStockId),
				sql`${stockMove.qty} < 0`
			)
		)
		.all()
		.map((x) => x.id);
	const location = input.location.trim();
	plans.forEach((p, n) => {
		update(ctx, stockRecord, p.stockId, { location });
		produceStock(ctx, {
			stockId: p.stockId,
			quantity: p.quantity as Qty,
			notes: input.notes,
			componentMoveIds: n === 0 ? componentMoveIds : [],
			links: { executionId: input.id }
		});
	});
	const done = new Set(plans.map((p) => p.stockId));
	return { executionId: input.id, productions: productionRows(ctx.db, loadModel(ctx.db, input.id)).filter((p) => done.has(p.stockId)) };
}

