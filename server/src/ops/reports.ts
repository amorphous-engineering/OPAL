import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as x from '../services/reports/exports.ts';
import * as life from '../services/reports/lifecycle.ts';
import { buildOverview } from '../services/reports/overview.ts';

const c = contracts.reports;

export const reportsImpls: Impl[] = [
	implement(c.overview, (ctx, i) => buildOverview(ctx, { projectId: i.projectId })),
	implement(c.partsCsv, (ctx, i) => x.partsCsv(ctx, i)),
	implement(c.inventoryCsv, (ctx, i) => x.inventoryCsv(ctx, i)),
	implement(c.executionsCsv, (ctx, i) => x.executionsCsv(ctx, i)),
	implement(c.issuesCsv, (ctx, i) => x.issuesCsv(ctx, i)),
	implement(c.risksCsv, (ctx, i) => x.risksCsv(ctx, i)),
	implement(c.executionMetrics, (ctx, i) => x.executionMetrics(ctx, i)),
	implement(c.issueMetrics, (ctx, i) => x.issueMetrics(ctx, i)),
	implement(c.lifecycle.get, (ctx) => life.lifecycleState(ctx)),
	implement(c.lifecycle.enterDemo, (ctx) => life.enterDemo(ctx)),
	implement(c.lifecycle.exitDemo, (ctx) => life.exitDemo(ctx)),
	implement(c.lifecycle.deleteDemo, (ctx) => life.deleteDemo(ctx)),
	implement(c.lifecycle.factoryReset, (ctx, i) => {
		life.factoryReset(ctx, i.confirm);
		return { ok: true as const };
	})
] as Impl[];
