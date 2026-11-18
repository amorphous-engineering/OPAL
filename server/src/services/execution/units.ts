/**
 * The units a work order acts on. An OP names them: an existing serialized stock record, or
 * borrowed gear OPAL does not hold. The naming is pencil while the OP is workable and pen once it
 * completes, like the rest of the step. Material can go into a named unit (a kit line's `into`)
 * and components can come out of it (a removal). A build never names units; it makes one.
 */
import {
	type ComponentRemoval,
	type ExecUnit,
	type InstalledComponent,
	OpalError,
	QTY_SCALE,
	type Qty,
	conflict,
	formatQty,
	notFound,
	now,
	parseQty
} from '@opal/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { componentRemoval, executionUnit, part, stockMove, stockRecord } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { balanceOf, installedIn, isInstalled, netInstalled, writeMove } from '../inventory/index.ts';
import { type Model, type Row, type UnitRow, getRow, isActive, loadModel } from './model.ts';
import { userNames } from './present.ts';
import { checkCompletion, markInWork } from './steps.ts';

const refuse = (message: string, status = 409) => new OpalError(status, 'step_blocked', message);

/** A unit can change while its OP is workable and the order is open. */
const pencil = (m: Model, u: UnitRow) => isActive(m.exec) && m.byId.get(u.stepExecutionId)?.se.status === 'pending';

const slotOf = (m: Model, u: UnitRow) => (u.slot === null ? undefined : m.byId.get(u.stepExecutionId)?.units.find((s) => s.key === u.slot));

// ---------------------------------------------------------------- present

export function presentUnits(db: Db, m: Model, units: UnitRow[] = m.units): ExecUnit[] {
	if (!units.length) return [];
	const ids = units.map((u) => u.stockId).filter((x): x is number => x !== null);
	const recs = new Map(
		ids.length
			? db
					.select({ r: stockRecord, p: part })
					.from(stockRecord)
					.innerJoin(part, eq(part.id, stockRecord.partId))
					.where(inArray(stockRecord.id, ids))
					.all()
					.map((x) => [x.r.id, x])
			: []
	);
	const names = userNames(db, units.map((u) => u.recordedById));
	return units.map((u) => {
		const rec = u.stockId === null ? undefined : recs.get(u.stockId);
		return {
			id: u.id,
			stepId: u.stepExecutionId,
			stepNumber: m.byId.get(u.stepExecutionId)?.number ?? '',
			slot: u.slot,
			slotLabel: slotOf(m, u)?.label ?? null,
			stockId: u.stockId,
			opalNumber: rec?.r.opalNumber ?? null,
			partId: rec?.p.id ?? null,
			partNumber: rec?.p.internalPn ?? null,
			partName: rec?.p.name ?? null,
			serialNumber: rec?.r.serialNumber ?? null,
			borrowed: u.borrowedName === null ? null : { name: u.borrowedName, serial: u.borrowedSerial, lentBy: u.borrowedFrom },
			recordedBy: u.recordedById === null ? null : (names.get(u.recordedById) ?? null),
			recordedAt: u.createdAt,
			pencil: pencil(m, u)
		};
	});
}

export function removalRows(db: Db, m: Model): ComponentRemoval[] {
	const rows = db
		.select({ r: componentRemoval, rec: stockRecord, p: part })
		.from(componentRemoval)
		.innerJoin(stockRecord, eq(stockRecord.id, componentRemoval.stockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(eq(componentRemoval.executionId, m.exec.id))
		.orderBy(componentRemoval.id)
		.all();
	if (!rows.length) return [];
	const assemblies = new Map(
		db
			.select({ id: stockRecord.id, opal: stockRecord.opalNumber })
			.from(stockRecord)
			.where(inArray(stockRecord.id, [...new Set(rows.map((x) => x.r.assemblyStockId))]))
			.all()
			.map((a) => [a.id, a.opal])
	);
	const names = userNames(db, rows.map((x) => x.r.removedById));
	const back = new Map(
		db
			.select({ id: stockMove.id, to: stockMove.toLocation })
			.from(stockMove)
			.where(inArray(stockMove.id, rows.map((x) => x.r.returnMoveId ?? -1)))
			.all()
			.map((x) => [x.id, x.to])
	);
	return rows.map(({ r, rec, p }) => ({
		id: r.id,
		stepId: r.stepExecutionId,
		stepNumber: m.byId.get(r.stepExecutionId)?.number ?? '',
		assemblyStockId: r.assemblyStockId,
		assemblyOpal: assemblies.get(r.assemblyStockId) ?? '',
		stockId: rec.id,
		opalNumber: rec.opalNumber,
		partId: p.id,
		partNumber: p.internalPn,
		partName: p.name,
		serialNumber: rec.serialNumber,
		quantity: formatQty(r.quantity as Qty),
		uom: p.unitOfMeasure,
		disposition: r.returnMoveId === null ? 'scrap' : 'stock',
		location: r.returnMoveId === null ? null : (back.get(r.returnMoveId) ?? null),
		notes: r.notes,
		removedBy: r.removedById === null ? null : (names.get(r.removedById) ?? null),
		at: r.at
	}));
}

export function listUnits(ctx: Pick<Ctx, 'db'>, executionId: number) {
	const m = loadModel(ctx.db, executionId);
	return { units: presentUnits(ctx.db, m), removals: removalRows(ctx.db, m) };
}

// ---------------------------------------------------------------- bind

function requireWorkableOp(m: Model, stepId: number): Row {
	if (!isActive(m.exec)) throw refuse(`A work order that is ${m.exec.status.replace('_', ' ')} names no more units`);
	const row = getRow(m, stepId);
	if (row.level !== 0) throw refuse('Units are named on an OP, not on a sub-step', 422);
	if (row.se.status !== 'pending') throw refuse(`OP ${row.number} is done: its units are on record`);
	return row;
}

/** A unit that still exists: on the shelf, or installed in something. */
function requireUnit(db: Db, stockId: number) {
	const found = db
		.select({ r: stockRecord, p: part })
		.from(stockRecord)
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(eq(stockRecord.id, stockId))
		.get();
	if (!found) throw notFound(`Stock record ${stockId}`);
	if (found.p.trackingType !== 'serialized') {
		throw new OpalError(422, 'invalid_input', `${found.r.opalNumber} is not a serialized unit`, { stockId: 'not serialized' });
	}
	if (balanceOf({ db }, stockId) <= 0 && !isInstalled(db, stockId)) {
		throw conflict('unit_gone', `${found.r.opalNumber} is neither in stock nor installed in anything`);
	}
	return found;
}

export function bindUnit(
	ctx: Ctx,
	input: {
		id: number;
		stepId: number;
		slot?: string | null;
		stockId?: number;
		borrowed?: { name: string; serial?: string | null; lentBy?: string | null };
	}
): ExecUnit {
	const m = loadModel(ctx.db, input.id);
	const row = requireWorkableOp(m, input.stepId);
	if ((input.stockId === undefined) === (input.borrowed === undefined)) {
		throw new OpalError(422, 'invalid_input', 'Name a stock record or borrowed gear, not both', { stockId: 'one of stockId, borrowed' });
	}
	const slot = input.slot ? row.units.find((s) => s.key === input.slot) : undefined;
	if (input.slot && !slot) throw new OpalError(422, 'invalid_input', `OP ${row.number} has no slot '${input.slot}'`, { slot: 'unknown slot' });
	if (slot && m.units.some((u) => u.slot === slot.key)) throw conflict('slot_filled', `${slot.label} is already named`);
	if (input.stockId !== undefined) {
		const unit = requireUnit(ctx.db, input.stockId);
		if (slot && unit.p.id !== slot.partId) {
			throw new OpalError(422, 'invalid_input', `${slot.label} takes a unit of another part`, { stockId: 'wrong part' });
		}
		if (m.units.some((u) => u.stockId === input.stockId)) throw conflict('unit_named', `${unit.r.opalNumber} is already named on this work order`);
	}
	const row2 = insert(ctx, executionUnit, {
		executionId: m.exec.id,
		stepExecutionId: row.id,
		slot: slot?.key ?? null,
		stockId: input.stockId ?? null,
		borrowedName: input.borrowed?.name.trim() ?? null,
		borrowedSerial: input.borrowed?.serial?.trim() || null,
		borrowedFrom: input.borrowed?.lentBy?.trim() || null,
		recordedById: actorUserId(ctx.actor)
	});
	// An OP with sub-steps completes on its own once they are done; a missing unit was all it waited on.
	checkCompletion(ctx, input.id);
	return presentUnits(ctx.db, loadModel(ctx.db, input.id), [row2])[0]!;
}

export function unbindUnit(ctx: Ctx, input: { id: number; unitId: number }): void {
	const m = loadModel(ctx.db, input.id);
	const u = m.units.find((x) => x.id === input.unitId);
	if (!u) throw notFound('Unit on this work order');
	if (!pencil(m, u)) throw refuse('Its OP is done: the unit is on record');
	if (u.stockId !== null) {
		// Material already moved against the unit on this order: the naming is part of that record.
		const into = ctx.db
			.select({ id: stockMove.id })
			.from(stockMove)
			.where(and(eq(stockMove.executionId, m.exec.id), eq(stockMove.intoStockId, u.stockId)))
			.get();
		const out = ctx.db
			.select({ id: componentRemoval.id })
			.from(componentRemoval)
			.where(and(eq(componentRemoval.executionId, m.exec.id), eq(componentRemoval.assemblyStockId, u.stockId)))
			.get();
		if (into || out) throw refuse('Parts went into or came out of this unit on this work order: it stays named');
	}
	remove(ctx, executionUnit, u.id);
}

// ---------------------------------------------------------------- install and remove

/**
 * The stock record a kit line installs into: the unit named in that slot. Null for borrowed gear:
 * the part is still used up, and OPAL keeps no record of what is inside someone else's unit.
 */
export function intoStockOf(m: Model, slotKey: string): number | null {
	const u = m.units.find((x) => x.slot === slotKey);
	const label = m.rows.flatMap((r) => r.units).find((s) => s.key === slotKey)?.label ?? slotKey;
	if (!u) throw refuse(`Name the ${label} before installing into it`);
	return u.stockId;
}

function boundStock(m: Model, unitId: number): { unit: UnitRow; stockId: number } {
	const unit = m.units.find((x) => x.id === unitId);
	if (!unit) throw notFound('Unit on this work order');
	if (unit.stockId === null) throw refuse('Borrowed gear has no record of its components');
	return { unit, stockId: unit.stockId };
}

export function installedComponents(ctx: Pick<Ctx, 'db'>, input: { id: number; unitId: number }): InstalledComponent[] {
	const m = loadModel(ctx.db, input.id);
	const { stockId } = boundStock(m, input.unitId);
	return installedIn(ctx.db, stockId).map((r) => ({ ...r, quantity: formatQty(r.quantity as Qty) }));
}

export function removeComponent(
	ctx: Ctx,
	input: { id: number; stepId: number; unitId: number; stockId: number; quantity: string; location?: string | null; notes?: string | null }
): ComponentRemoval {
	const m = loadModel(ctx.db, input.id);
	if (!isActive(m.exec)) throw refuse(`Nothing comes out of a unit on a work order that is ${m.exec.status.replace('_', ' ')}`);
	const row = getRow(m, input.stepId);
	if (row.se.status !== 'pending') throw refuse(`Step ${row.number} is done: record the removal on a step still open`);
	const { stockId: assemblyId } = boundStock(m, input.unitId);
	const comp = ctx.db
		.select({ r: stockRecord, p: part })
		.from(stockRecord)
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(eq(stockRecord.id, input.stockId))
		.get();
	if (!comp) throw notFound(`Stock record ${input.stockId}`);
	const qty = parseQty(input.quantity);
	if (qty <= 0) throw new OpalError(422, 'invalid_input', 'Quantity must be above zero', { quantity: 'must be above zero' });
	const have = netInstalled(ctx.db, comp.r.id, assemblyId);
	if (have < qty) {
		throw conflict('not_installed', `${comp.r.opalNumber}: ${formatQty(have as Qty)} ${comp.p.unitOfMeasure} installed, not ${formatQty(qty)}`);
	}
	const serialized = comp.p.trackingType === 'serialized';
	const location = input.location?.trim() || null;
	// A used part from a lot never rejoins the lot of new ones; only a unit keeps its own record.
	if (location && !serialized) {
		throw new OpalError(422, 'invalid_input', 'Only a serialized unit goes back to stock; lot and bulk parts are scrapped', { location: 'serialized only' });
	}
	if (serialized && qty !== QTY_SCALE) throw new OpalError(422, 'invalid_input', 'A serialized unit comes out whole', { quantity: 'must be 1' });
	const at = now();
	const links = { executionId: m.exec.id, stepExecutionId: row.id };
	let returnMoveId: number | null = null;
	if (location) {
		const from = comp.r.location;
		update(ctx, stockRecord, comp.r.id, { location });
		returnMoveId = writeMove(ctx, {
			stockId: comp.r.id,
			kind: 'adjust',
			qty,
			reason: 'removed',
			notes: input.notes,
			fromLocation: from || null,
			toLocation: location,
			at,
			links
		}).id;
	}
	markInWork(ctx, m);
	const rem = insert(ctx, componentRemoval, {
		executionId: m.exec.id,
		stepExecutionId: row.id,
		assemblyStockId: assemblyId,
		stockId: comp.r.id,
		quantity: qty,
		returnMoveId,
		notes: input.notes?.trim() || null,
		removedById: actorUserId(ctx.actor),
		at
	});
	const mm = loadModel(ctx.db, input.id);
	return removalRows(ctx.db, mm).find((r) => r.id === rem.id)!;
}
