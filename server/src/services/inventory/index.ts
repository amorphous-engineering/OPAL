/**
 * Inventory service. Other areas import from here:
 *
 *   balanceOf, balancesForPart, onHandForPart, onHandByPart   quantities (sums of the ledger)
 *   receiveStock    purchasing: stock arrives
 *   consumeStock    execution: material or tooling used
 *   produceStock    execution: an item is made
 *   createStockRecord, linkComponents   execution: reserve an OPAL number, record genealogy
 *   calibrationReport, expiringStock, lowStockParts   the overview
 */
import { eq, sql } from 'drizzle-orm';
import { stockRecord } from '../../db/schema/index.ts';
import { registerPartReference } from '../parts/references.ts';
export * from './ledger.ts';
export * from './records.ts';
export * from './moves.ts';
export * from './genealogy.ts';
export * from './tests.ts';
export * from './calibration.ts';
export * from './detail.ts';
export * from './labels.ts';

// Stock records describe the tracking type (one record per serial, or one lot): it cannot change under them.
registerPartReference({
	name: 'inventory_records',
	locksTracking: true,
	count: (ctx, id) =>
		ctx.db.select({ n: sql<number>`count(*)` }).from(stockRecord).where(eq(stockRecord.partId, id)).get()?.n ?? 0
});
