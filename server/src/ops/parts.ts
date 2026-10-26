import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as bom from '../services/parts/bom.ts';
import * as csv from '../services/parts/csv.ts';
import { history } from '../services/parts/history.ts';
import * as parts from '../services/parts/index.ts';
import * as lifecycle from '../services/parts/lifecycle.ts';
import { previewNext } from '../services/parts/numbering.ts';
import { qrCode } from '../services/parts/qr.ts';

const p = contracts.parts;

// Order matters: static paths before `/parts/:id`.
export const partsImpls = [
	implement(p.nextPn, (ctx, i) => previewNext(ctx.db, i.tier)),
	implement(p.categories, (ctx) => parts.categories(ctx)),
	implement(p.schema, (ctx) => parts.schema(ctx)),
	implement(p.reserve, (ctx, i) => parts.reserve(ctx, i)),
	implement(p.importPreview, (ctx, i) => csv.preview(ctx, i.csv)),
	implement(p.import, (ctx, i) => csv.importRows(ctx, i.rows, i.skipDuplicates)),
	implement(p.activateMany, (ctx, i) => lifecycle.activateMany(ctx, i.partIds, i.cause)),
	implement(p.createMany, (ctx, i) => ({ parts: parts.createMany(ctx, i.parts) })),
	implement(p.list, (ctx, i) => parts.list(ctx, i)),
	implement(p.create, (ctx, i) => parts.create(ctx, i)),
	implement(p.get, (ctx, i) => parts.get(ctx, i.id)),
	implement(p.detail, (ctx, i) => parts.detail(ctx, i.id)),
	implement(p.history, (ctx, i) => history(ctx, i.id, i.limit)),
	implement(p.qrcode, (ctx, i) => qrCode(ctx, i.id, i.origin)),
	implement(p.update, (ctx, i) => parts.updatePart(ctx, i)),
	implement(p.delete, (ctx, i) => {
		parts.deletePart(ctx, i.id);
		return { ok: true as const };
	}),
	implement(p.activate, (ctx, i) => lifecycle.activate(ctx, i.id, i.cause)),
	implement(p.obsolete, (ctx, i) => lifecycle.obsolete(ctx, i.id, i.cause)),
	implement(p.variants.create, (ctx, i) => parts.createVariant(ctx, i)),
	implement(p.bom.list, (ctx, i) => bom.listLines(ctx, i.id)),
	implement(p.bom.tree, (ctx, i) => bom.tree(ctx, i.id, i.depth)),
	implement(p.bom.whereUsed, (ctx, i) => bom.whereUsedLines(ctx, i.id)),
	implement(p.bom.add, (ctx, i) =>
		bom.addLine(ctx, {
			assemblyId: i.id,
			componentId: i.componentId,
			quantity: i.quantity,
			referenceDesignator: i.referenceDesignator,
			notes: i.notes
		})
	),
	implement(p.bom.update, (ctx, i) => bom.updateLine(ctx, i)),
	implement(p.bom.remove, (ctx, i) => {
		bom.removeLine(ctx, i.lineId);
		return { ok: true as const };
	})
] as Impl[];
