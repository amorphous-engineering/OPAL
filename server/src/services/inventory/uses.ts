/**
 * Uses of a unit: the work orders that acted on it, and the ones that acted on an assembly while
 * it was inside. Counted per procedure, from completed work orders only. Derived from
 * `execution_unit` and genealogy; nothing is stored.
 */
import type { ExecutionStatus, ProcedureSnapshot, UnitWorkOrder, UseCount } from '@opal/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { execution, executionUnit, procedure, procedureVersion, stockRecord } from '../../db/schema/index.ts';
import { stays } from './genealogy.ts';

interface Window {
	/** Inclusive. */
	from?: string | null;
	/** Exclusive. Null: open. */
	to?: string | null;
}

/** The work orders that named this unit itself. */
function namedBy(db: Db, unitId: number): Omit<UnitWorkOrder, 'viaOpal'>[] {
	const rows = db
		.select({ u: executionUnit, e: execution, p: procedure })
		.from(executionUnit)
		.innerJoin(execution, eq(execution.id, executionUnit.executionId))
		.innerJoin(procedure, eq(procedure.id, execution.procedureId))
		.where(eq(executionUnit.stockId, unitId))
		.orderBy(asc(executionUnit.id))
		.all();
	if (!rows.length) return [];
	const snaps = new Map(
		db
			.select({ id: procedureVersion.id, content: procedureVersion.content })
			.from(procedureVersion)
			.where(inArray(procedureVersion.id, [...new Set(rows.map((r) => r.e.versionId))]))
			.all()
			.map((v) => [v.id, v.content as ProcedureSnapshot])
	);
	return rows.map(({ u, e, p }) => ({
		executionId: e.id,
		woNumber: e.woNumber,
		status: e.status as ExecutionStatus,
		procedureId: p.id,
		procedureNumber: p.templateNumber,
		procedureName: p.name,
		slotLabel:
			u.slot === null
				? null
				: (snaps.get(e.versionId)?.steps.flatMap((s) => s.units ?? []).find((x) => x.key === u.slot)?.label ?? u.slot),
		recordedAt: u.createdAt,
		completedAt: e.completedAt,
		counted: e.status === 'completed'
	}));
}

/** When an act happened: the work order's completion, else when the unit was named. */
const timeOf = (a: { completedAt: string | null; recordedAt: string }) => a.completedAt ?? a.recordedAt;
const inside = (t: string, w: Window) => (!w.from || t >= w.from) && (!w.to || t < w.to);

/**
 * Every work order that acted on the unit within the window, directly or through an assembly it
 * was in at the time, oldest first, and the completed ones counted per procedure.
 */
export function usesOf(db: Db, unitId: number, window: Window = {}): { workOrders: UnitWorkOrder[]; counts: UseCount[] } {
	const found = new Map<number, UnitWorkOrder>();
	const visit = (id: number, w: Window, path: Set<number>) => {
		if (path.has(id)) return;
		const opal = id === unitId ? null : (db.select({ o: stockRecord.opalNumber }).from(stockRecord).where(eq(stockRecord.id, id)).get()?.o ?? null);
		for (const a of namedBy(db, id)) {
			// The unit itself first: a work order that named both keeps the direct row.
			if (inside(timeOf(a), w) && !found.has(a.executionId)) found.set(a.executionId, { ...a, viaOpal: opal });
		}
		const next = new Set(path).add(id);
		for (const s of stays(db, id)) {
			const from = !w.from || s.start > w.from ? s.start : w.from;
			const to = s.end === null ? (w.to ?? null) : !w.to || s.end < w.to ? s.end : w.to;
			if (to !== null && to <= from) continue;
			visit(s.assemblyId, { from, to }, next);
		}
	};
	visit(unitId, window, new Set());
	const workOrders = [...found.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.executionId - b.executionId);
	const counts = new Map<number, UseCount>();
	for (const a of workOrders) {
		if (!a.counted) continue;
		const c = counts.get(a.procedureId) ?? { procedureId: a.procedureId, procedureNumber: a.procedureNumber, procedureName: a.procedureName, count: 0 };
		c.count += 1;
		counts.set(a.procedureId, c);
	}
	return { workOrders, counts: [...counts.values()].sort((a, b) => a.procedureName.localeCompare(b.procedureName)) };
}
