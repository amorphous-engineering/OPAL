import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as ds from '../services/datasets/index.ts';

const d = contracts.datasets;

export const datasetsImpls = [
	implement(d.list, (ctx, i) => ds.list(ctx, i)),
	implement(d.create, (ctx, i) => ds.create(ctx, i)),
	implement(d.get, (ctx, i) => ds.get(ctx, i.id)),
	implement(d.update, (ctx, i) => ds.updateDataset(ctx, i)),
	implement(d.archive, (ctx, i) => ds.archive(ctx, i.id)),
	implement(d.delete, (ctx, i) => {
		ds.deleteDataset(ctx, i.id);
		return { ok: true as const };
	}),
	implement(d.exportCsv, (ctx, i) => ds.exportCsv(ctx, i.id)),
	implement(d.chart, (ctx, i) => ds.chart(ctx, i)),
	// Static paths before the `:pointId` route.
	implement(d.points.list, (ctx, i) => ds.listPoints(ctx, i)),
	implement(d.points.import, (ctx, i) => ds.importPoints(ctx, i.id, i.csv)),
	implement(d.points.add, (ctx, i) => ds.addPoint(ctx, i)),
	implement(d.points.remove, (ctx, i) => {
		ds.removePoint(ctx, i.id, i.pointId);
		return { ok: true as const };
	})
] as Impl[];
