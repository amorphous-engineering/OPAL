/** Where a part is used outside the BOM: in procedures (kits, outputs) and in what was consumed. */
import { type PartConsumption, type PartProcedureUse, type Qty, formatQty, notFound } from '@opal/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import {
	execution,
	kitItem,
	part,
	procedure,
	procedureOutput,
	procedureStep,
	stockMove,
	stockRecord,
	user
} from '../../db/schema/index.ts';

type DbCtx = Pick<Ctx, 'db'>;

function partUom(ctx: DbCtx, partId: number): string {
	const p = ctx.db.select({ uom: part.unitOfMeasure }).from(part).where(eq(part.id, partId)).get();
	if (!p) throw notFound(`Part ${partId}`);
	return p.uom;
}

/**
 * Procedures whose kit or outputs name the part: a kit line on the procedure, a kit line on one
 * step, or an output. Newest procedure first.
 */
export function procedureUse(ctx: DbCtx, partId: number): PartProcedureUse[] {
	const unitOfMeasure = partUom(ctx, partId);
	const kitRows = ctx.db
		.select({ k: kitItem, step: procedureStep.title, stepProc: procedureStep.procedureId })
		.from(kitItem)
		.leftJoin(procedureStep, eq(procedureStep.id, kitItem.stepId))
		.where(eq(kitItem.partId, partId))
		.all();
	const outRows = ctx.db.select().from(procedureOutput).where(eq(procedureOutput.partId, partId)).all();
	const procIds = [
		...new Set([
			...kitRows.map((r) => (r.k.procedureId ?? r.stepProc) as number),
			...outRows.map((r) => r.procedureId)
		])
	];
	if (!procIds.length) return [];
	const procs = new Map(
		ctx.db
			.select()
			.from(procedure)
			.all()
			.filter((p) => procIds.includes(p.id))
			.map((p) => [p.id, p])
	);
	const out: PartProcedureUse[] = [];
	const base = (id: number) => {
		const p = procs.get(id)!;
		return { procedureId: p.id, templateNumber: p.templateNumber, procedureName: p.name, procedureStatus: p.status, unitOfMeasure };
	};
	for (const r of kitRows) {
		out.push({
			...base((r.k.procedureId ?? r.stepProc) as number),
			scope: r.k.stepId === null ? 'procedure' : 'step',
			stepTitle: r.step ?? null,
			role: r.k.usage,
			quantity: formatQty(r.k.quantity as Qty)
		});
	}
	for (const r of outRows) {
		out.push({
			...base(r.procedureId),
			scope: 'procedure',
			stepTitle: null,
			role: 'output',
			quantity: formatQty(r.quantity as Qty)
		});
	}
	return out.sort(
		(a, b) => b.procedureId - a.procedureId || (a.stepTitle ?? '').localeCompare(b.stepTitle ?? '') || a.role.localeCompare(b.role)
	);
}

/** Consume moves against any stock record of the part, newest first. */
export function consumption(ctx: DbCtx, partId: number, limit: number) {
	const unitOfMeasure = partUom(ctx, partId);
	const where = sql`${stockRecord.partId} = ${partId} AND ${stockMove.kind} = 'consume'`;
	const total =
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(stockMove)
			.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
			.where(where)
			.get()?.n ?? 0;
	const rows = ctx.db
		.select({ m: stockMove, opal: stockRecord.opalNumber, wo: execution.woNumber, actor: user.name })
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.leftJoin(execution, eq(execution.id, stockMove.executionId))
		.leftJoin(user, eq(user.id, stockMove.actorUserId))
		.where(where)
		.orderBy(desc(stockMove.at), desc(stockMove.id))
		.limit(limit)
		.all();
	const items: PartConsumption[] = rows.map(({ m, opal, wo, actor }) => ({
		id: m.id,
		at: m.at,
		quantity: formatQty(Math.abs(m.qty) as Qty),
		unitOfMeasure,
		usage: m.reason === 'tooling' ? 'tooling' : 'consume',
		opalNumber: opal,
		executionId: m.executionId,
		woNumber: wo,
		reason: m.reason,
		notes: m.notes,
		actorName: actor
	}));
	return { items, total };
}
