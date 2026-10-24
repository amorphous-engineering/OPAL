import { contracts, parseQty } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as inv from '../services/inventory/index.ts';

const c = contracts.inventory;

// Single-segment routes (by-part, locations, ...) come before `/inventory/:id`.
export const inventoryImpls = [
	implement(c.list, (ctx, i) => inv.listStock(ctx, i)),
	implement(c.byPart, (ctx, i) => inv.stockByPart(ctx, i)),
	implement(c.locations, (ctx) => inv.listLocations(ctx)),
	implement(c.labels, (ctx, i) => inv.buildLabels(ctx, i)),
	implement(c.receivingRules, (ctx, i) => {
		const p = inv.partById(ctx, i.partId);
		return { partId: p.id, ...inv.receivingRulesFor(ctx, p) };
	}),
	implement(c.calibration, (ctx) => inv.calibrationReport(ctx)),
	implement(c.lowStock, (ctx) => inv.lowStockParts(ctx)),
	implement(c.moves, (ctx, i) => inv.listMoves(ctx, i)),
	implement(c.create, (ctx, i) => ({
		items: inv.receiveStock(ctx, { ...i, quantity: parseQty(i.quantity) })
	})),
	implement(c.transfer, (ctx, i) =>
		inv.transferStock(ctx, { ...i, quantity: parseQty(i.quantity) })
	),
	implement(c.getByOpal, (ctx, i) => inv.getStockByOpal(ctx, i.opalNumber)),
	implement(c.detail, (ctx, i) => inv.stockDetail(ctx, i.opalNumber)),
	implement(c.history, (ctx, i) => inv.ledgerFor(ctx, inv.recordByOpal(ctx, i.opalNumber).id)),
	implement(c.genealogy, (ctx, i) => {
		const rec = inv.recordByOpal(ctx, i.opalNumber);
		return {
			opalNumber: rec.opalNumber,
			components: inv.componentsOf(ctx, rec, i.depth),
			usedIn: inv.usedIn(ctx, rec, i.depth)
		};
	}),
	implement(c.partSummary, (ctx, i) => inv.partSummary(ctx, i.partId)),
	implement(c.templates.list, (ctx, i) => inv.listTemplates(ctx, i.partId)),
	implement(c.templates.create, (ctx, { partId, ...rest }) => inv.createTemplate(ctx, partId, rest)),
	implement(c.templates.delete, (ctx, i) => {
		inv.deleteTemplate(ctx, i.partId, i.templateId);
		return { ok: true as const };
	}),
	implement(c.get, (ctx, i) => inv.getStock(ctx, i.id)),
	implement(c.update, (ctx, { id, ...patch }) => inv.updateStock(ctx, id, patch)),
	implement(c.adjust, (ctx, i) =>
		inv.adjustStock(ctx, {
			stockId: i.id,
			adjustment: parseQty(i.adjustment),
			reason: i.reason,
			notes: i.notes
		})
	),
	implement(c.count, (ctx, i) =>
		inv.countStock(ctx, { stockId: i.id, counted: parseQty(i.countedQuantity), notes: i.notes })
	),
	implement(c.calibrate, (ctx, i) => inv.calibrateStock(ctx, i.id)),
	implement(c.tests.list, (ctx, i) => {
		inv.recordById(ctx, i.id);
		return inv.listResults(ctx, i.id);
	}),
	implement(c.tests.create, (ctx, { id, ...rest }) => inv.createResult(ctx, id, rest)),
	implement(c.tests.update, (ctx, { id, testId, ...rest }) => inv.updateResult(ctx, id, testId, rest)),
	implement(c.tests.delete, (ctx, i) => {
		inv.deleteResult(ctx, i.id, i.testId);
		return { ok: true as const };
	}),
	implement(c.tests.status, (ctx, i) => inv.testStatus(ctx, i.id))
] as Impl[];
