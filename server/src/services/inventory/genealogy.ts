/**
 * Genealogy: which stock went into which. A consume move's `into_stock_id` names the assembly it
 * went into; a `component_removal` row takes some of it out again (the ledger is append-only, so a
 * removal is its own fact). What is in an assembly now is the moves less the removals. Both
 * directions are queries over those two tables.
 */
import { type Qty, type StockGenealogyRow, formatQty } from '@opal/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { componentRemoval, execution, part, stockMove, stockRecord } from '../../db/schema/index.ts';
import { usesOf } from './uses.ts';

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
	lastAt: string;
}

const edgeColumns = {
	otherId: stockRecord.id,
	opalNumber: stockRecord.opalNumber,
	partId: part.id,
	pn: part.internalPn,
	name: part.name,
	qty: sql<number>`-SUM(${stockMove.qty})`,
	at: sql<string>`MIN(${stockMove.at})`,
	lastAt: sql<string>`MAX(${stockMove.at})`
};

/** Direct components of an assembly record: one edge per component record. */
function componentEdges(ctx: DbCtx, assemblyId: number): Edge[] {
	return ctx.db
		.select(edgeColumns)
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
		.select(edgeColumns)
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.intoStockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.stockId, componentId)))
		.groupBy(stockRecord.id)
		.orderBy(sql`MIN(${stockMove.id})`)
		.all();
}

interface Removed {
	qty: number;
	at: string;
	woNumber: string;
}

/** Removals of one pair, summed, with the last one's time and work order. */
function removedFrom(db: Db, assemblyId: number, componentId: number): Removed | null {
	const rows = db
		.select({ qty: componentRemoval.quantity, at: componentRemoval.at, wo: execution.woNumber })
		.from(componentRemoval)
		.innerJoin(execution, eq(execution.id, componentRemoval.executionId))
		.where(and(eq(componentRemoval.assemblyStockId, assemblyId), eq(componentRemoval.stockId, componentId)))
		.orderBy(componentRemoval.at, componentRemoval.id)
		.all();
	if (!rows.length) return null;
	const last = rows.at(-1)!;
	return { qty: rows.reduce((n, r) => n + r.qty, 0), at: last.at, woNumber: last.wo };
}

function walk(
	ctx: DbCtx,
	rootId: number,
	rootOpal: string,
	depth: number,
	edges: (ctx: DbCtx, id: number) => Edge[],
	pair: (nodeId: number, otherId: number) => { assemblyId: number; componentId: number }
): StockGenealogyRow[] {
	const out: StockGenealogyRow[] = [];
	const seen = new Set<number>([rootId]);
	let frontier = [{ id: rootId, opal: rootOpal }];
	for (let level = 1; level <= depth && frontier.length; level++) {
		const next: typeof frontier = [];
		for (const node of frontier) {
			for (const e of edges(ctx, node.id)) {
				const { assemblyId, componentId } = pair(node.id, e.otherId);
				const removed = removedFrom(ctx.db, assemblyId, componentId);
				const gone = removed !== null && removed.qty >= e.qty;
				out.push({
					depth: level,
					viaOpal: node.opal,
					opalNumber: e.opalNumber,
					partId: e.partId,
					partInternalPn: e.pn,
					partName: e.name,
					qtyUsed: formatQty(e.qty as Qty),
					at: e.at,
					qtyRemoved: formatQty((removed?.qty ?? 0) as Qty),
					installedAt: e.lastAt,
					removedAt: removed?.at ?? null,
					removedWoNumber: removed?.woNumber ?? null,
					// Since the last install: a replacement starts the count again.
					usesSinceInstalled: usesOf(ctx.db, assemblyId, { from: e.lastAt, to: removed !== null && gone && removed.at > e.lastAt ? removed.at : null }).counts
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
export function componentsOf(ctx: DbCtx, record: { id: number; opalNumber: string }, depth = 1): StockGenealogyRow[] {
	return walk(ctx, record.id, record.opalNumber, depth, componentEdges, (node, other) => ({ assemblyId: node, componentId: other }));
}

/** The assemblies this item went into. `depth` 1 is the direct assemblies. */
export function usedIn(ctx: DbCtx, record: { id: number; opalNumber: string }, depth = 1): StockGenealogyRow[] {
	return walk(ctx, record.id, record.opalNumber, depth, assemblyEdges, (node, other) => ({ assemblyId: other, componentId: node }));
}

// ---------------------------------------------------------------- what is in it now

/** How much of a component record is in an assembly now. Qty units. */
export function netInstalled(db: Db, componentId: number, assemblyId: number): number {
	const went =
		db
			.select({ q: sql<number>`COALESCE(-SUM(${stockMove.qty}), 0)` })
			.from(stockMove)
			.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.stockId, componentId), eq(stockMove.intoStockId, assemblyId)))
			.get()?.q ?? 0;
	return went - (removedFrom(db, assemblyId, componentId)?.qty ?? 0);
}

/** Is the record installed in some assembly now? */
export function isInstalled(db: Db, componentId: number): boolean {
	const into = db
		.selectDistinct({ id: stockMove.intoStockId })
		.from(stockMove)
		.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.stockId, componentId), isNotNull(stockMove.intoStockId)))
		.all();
	return into.some((r) => netInstalled(db, componentId, r.id!) > 0);
}

export interface InstalledRow {
	stockId: number;
	opalNumber: string;
	partId: number;
	partNumber: string;
	partName: string;
	serialNumber: string | null;
	serialized: boolean;
	uom: string;
	quantity: number;
	installedAt: string;
}

/** The components in an assembly now, net of removals, in the order they went in. */
export function installedIn(db: Db, assemblyId: number): InstalledRow[] {
	const rows = db
		.select({
			stockId: stockRecord.id,
			opalNumber: stockRecord.opalNumber,
			serialNumber: stockRecord.serialNumber,
			partId: part.id,
			partNumber: part.internalPn,
			partName: part.name,
			tracking: part.trackingType,
			uom: part.unitOfMeasure,
			qty: sql<number>`-SUM(${stockMove.qty})`,
			installedAt: sql<string>`MAX(${stockMove.at})`
		})
		.from(stockMove)
		.innerJoin(stockRecord, eq(stockRecord.id, stockMove.stockId))
		.innerJoin(part, eq(part.id, stockRecord.partId))
		.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.intoStockId, assemblyId)))
		.groupBy(stockRecord.id)
		.orderBy(sql`MIN(${stockMove.id})`)
		.all();
	const removed = new Map<number, number>();
	if (rows.length) {
		for (const r of db
			.select({ id: componentRemoval.stockId, q: componentRemoval.quantity })
			.from(componentRemoval)
			.where(and(eq(componentRemoval.assemblyStockId, assemblyId), inArray(componentRemoval.stockId, rows.map((r) => r.stockId))))
			.all()) {
			removed.set(r.id, (removed.get(r.id) ?? 0) + r.q);
		}
	}
	return rows
		.map((r) => ({
			stockId: r.stockId,
			opalNumber: r.opalNumber,
			partId: r.partId,
			partNumber: r.partNumber,
			partName: r.partName,
			serialNumber: r.serialNumber,
			serialized: r.tracking === 'serialized',
			uom: r.uom,
			quantity: r.qty - (removed.get(r.stockId) ?? 0),
			installedAt: r.installedAt
		}))
		.filter((r) => r.quantity > 0);
}

/**
 * When a record was in each assembly: install moves add, removals subtract, and the record is in
 * while the sum is above zero. `end` null: still in.
 */
export function stays(db: Db, componentId: number): { assemblyId: number; start: string; end: string | null }[] {
	const ins = db
		.select({ a: stockMove.intoStockId, q: stockMove.qty, at: stockMove.at })
		.from(stockMove)
		.where(and(eq(stockMove.kind, 'consume'), eq(stockMove.stockId, componentId), isNotNull(stockMove.intoStockId)))
		.all()
		.map((m) => ({ a: m.a!, d: -m.q, at: m.at }));
	const outs = db
		.select({ a: componentRemoval.assemblyStockId, q: componentRemoval.quantity, at: componentRemoval.at })
		.from(componentRemoval)
		.where(eq(componentRemoval.stockId, componentId))
		.all()
		.map((r) => ({ a: r.a, d: -r.q, at: r.at }));
	const byAssembly = new Map<number, { d: number; at: string }[]>();
	for (const e of [...ins, ...outs]) byAssembly.set(e.a, [...(byAssembly.get(e.a) ?? []), e]);
	const out: { assemblyId: number; start: string; end: string | null }[] = [];
	for (const [assemblyId, events] of byAssembly) {
		// Same instant: the install first, so a swap in one moment still counts as in.
		events.sort((x, y) => x.at.localeCompare(y.at) || y.d - x.d);
		let n = 0;
		let start: string | null = null;
		for (const e of events) {
			const before = n;
			n += e.d;
			if (before <= 0 && n > 0) start = e.at;
			if (before > 0 && n <= 0 && start !== null) {
				out.push({ assemblyId, start, end: e.at });
				start = null;
			}
		}
		if (start !== null) out.push({ assemblyId, start, end: null });
	}
	return out;
}
