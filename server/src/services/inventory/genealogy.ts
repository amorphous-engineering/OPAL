/**
 * Genealogy: which stock went into which. The one home of the fact is the consume move: its
 * `into_stock_id` names the assembly record. Both directions are queries over those moves.
 */
import { type Qty, type StockGenealogyRow, formatQty } from '@opal/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { part, stockMove, stockRecord } from '../../db/schema/index.ts';

type DbCtx = Pick<Ctx, 'db'>;

interface Edge {
	/** The record on the far side of the edge. */
	otherId: number;
	opalNumber: string;
	partId: number;
	pn: string;
	name: string;
	qty: number;
	at: string;
}

/** Direct components of an assembly record: one edge per component record. */
function componentEdges(ctx: DbCtx, assemblyId: number): Edge[] {
	return ctx.db
		.select({
			otherId: stockRecord.id,
			opalNumber: stockRecord.opalNumber,
			partId: part.id,
			pn: part.internalPn,
			name: part.name,
			qty: sql<number>`-SUM(${stockMove.qty})`,
			at: sql<string>`MIN(${stockMove.at})`
		})
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.intoStockId, assemblyId)))
		.groupBy(stockRecord.id)
		.orderBy(sql`MIN(${stockMove.id})`)
		.all();
}

/** Direct assemblies a component record went into: one edge per assembly record. */
function assemblyEdges(ctx: DbCtx, componentId: number): Edge[] {
	return ctx.db
		.select({
			otherId: stockRecord.id,
			opalNumber: stockRecord.opalNumber,
			partId: part.id,
			pn: part.internalPn,
			name: part.name,
			qty: sql<number>`-SUM(${stockMove.qty})`,
			at: sql<string>`MIN(${stockMove.at})`
		})
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.intoStockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.stockId, componentId)))
		.groupBy(stockRecord.id)
		.orderBy(sql`MIN(${stockMove.id})`)
		.all();
}

function walk(
	ctx: DbCtx,
	rootId: number,
	rootOpal: string,
	depth: number,
	edges: (ctx: DbCtx, id: number) => Edge[]
): StockGenealogyRow[] {
	const out: StockGenealogyRow[] = [];
	const seen = new Set<number>([rootId]);
	let frontier = [{ id: rootId, opal: rootOpal }];
	for (let level = 1; level <= depth && frontier.length; level++) {
		const next: typeof frontier = [];
		for (const node of frontier) {
			for (const e of edges(ctx, node.id)) {
				out.push({
					depth: level,
					viaOpal: node.opal,
					opalNumber: e.opalNumber,
					partId: e.partId,
					partInternalPn: e.pn,
					partName: e.name,
					qtyUsed: formatQty(e.qty as Qty),
					at: e.at
				});
				if (!seen.has(e.otherId)) {
					seen.add(e.otherId);
					next.push({ id: e.otherId, opal: e.opalNumber });
				}
			}
		}
		frontier = next;
	}
	return out;
}

/** What went into this item. `depth` 1 is the direct components. */
export function componentsOf(
	ctx: DbCtx,
	record: { id: number; opalNumber: string },
	depth = 1
): StockGenealogyRow[] {
	return walk(ctx, record.id, record.opalNumber, depth, componentEdges);
}

/** The assemblies this item went into. `depth` 1 is the direct assemblies. */
export function usedIn(
	ctx: DbCtx,
	record: { id: number; opalNumber: string },
	depth = 1
): StockGenealogyRow[] {
	return walk(ctx, record.id, record.opalNumber, depth, assemblyEdges);
}
