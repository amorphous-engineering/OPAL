/** The record page: record, part, source, ledger, genealogy both ways, tests. */
import { type StockDetail, notFound } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { part } from '../../db/schema/index.ts';
import { getProjectConfig, getTier } from '../org/project.ts';
import { componentsOf, usedIn } from './genealogy.ts';
import { ledgerFor } from './moves.ts';
import { getStockByOpal, recordByOpal } from './records.ts';
import { listResults, listTemplates, testStatus } from './tests.ts';

type DbCtx = Pick<Ctx, 'db'>;

export function stockDetail(ctx: DbCtx, opalNumber: string): StockDetail {
	const rec = recordByOpal(ctx, opalNumber);
	const record = getStockByOpal(ctx, opalNumber);
	const p = ctx.db.select().from(part).where(eq(part.id, rec.partId)).get();
	if (!p) throw notFound('Part');
	const ledger = ledgerFor(ctx, rec.id);
	const opening = ledger.find((m) => m.kind === 'receive' || m.kind === 'produce');
	const arrival =
		rec.sourceType === 'transfer'
			? ledger.find((m) => m.kind === 'transfer' && Number(m.qty) > 0)
			: undefined;
	return {
		record,
		part: {
			id: p.id,
			internalPn: p.internalPn,
			externalPn: p.externalPn,
			name: p.name,
			unitOfMeasure: p.unitOfMeasure,
			trackingType: p.trackingType,
			isTooling: p.isTooling,
			tier: p.tier,
			tierName: getTier(getProjectConfig(ctx.db), p.tier)?.name ?? null,
			state: p.state
		},
		source: {
			type: rec.sourceType,
			links: opening?.links ?? {},
			transferredFromOpal: arrival?.counterpartOpal ?? null
		},
		ledger,
		components: componentsOf(ctx, rec),
		usedIn: usedIn(ctx, rec),
		tests: listResults(ctx, rec.id),
		testTemplates: listTemplates(ctx, rec.partId),
		testStatus: testStatus(ctx, rec.id)
	};
}
