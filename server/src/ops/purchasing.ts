import { contracts } from '@opal/shared';
import { type Impl, implement } from '../registry.ts';
import * as po from '../services/purchasing/index.ts';

const s = contracts.purchasing.suppliers;
const c = contracts.purchasing.catalog;
const o = contracts.purchasing.orders;

export const purchasingImpls = [
	implement(s.list, (ctx, i) => po.listSuppliers(ctx, i)),
	implement(s.create, (ctx, i) => po.createSupplier(ctx, i)),
	implement(s.get, (ctx, i) => po.getSupplier(ctx, i.id)),
	implement(s.update, (ctx, i) => po.updateSupplier(ctx, i)),
	implement(s.delete, (ctx, i) => {
		po.deleteSupplier(ctx, i.id);
		return { ok: true as const };
	}),
	implement(c.list, (ctx, i) => po.listCatalog(ctx, i.id)),
	implement(c.add, (ctx, i) => po.addCatalogEntry(ctx, i)),
	implement(c.update, (ctx, i) => po.updateCatalogEntry(ctx, i)),
	implement(c.remove, (ctx, i) => {
		po.removeCatalogEntry(ctx, i.id, i.entryId);
		return { ok: true as const };
	}),
	implement(c.forPart, (ctx, i) => po.catalogForPart(ctx, i.id)),
	implement(c.poLinesForPart, (ctx, i) => po.poLinesForPart(ctx, i.id)),
	implement(o.list, (ctx, i) => po.listPurchases(ctx, i)),
	implement(o.create, (ctx, i) => po.createPurchase(ctx, i)),
	implement(o.get, (ctx, i) => po.getPurchase(ctx, i.id)),
	implement(o.update, (ctx, i) => po.updatePurchase(ctx, i)),
	implement(o.addLine, (ctx, i) => po.addLine(ctx, i)),
	implement(o.updateLine, (ctx, i) => po.updateLine(ctx, i)),
	implement(o.removeLine, (ctx, i) => {
		po.removeLine(ctx, i.id, i.lineId);
		return { ok: true as const };
	}),
	implement(o.receive, (ctx, i) => po.receive(ctx, i)),
	implement(o.received, (ctx, i) => po.receivedRecords(ctx, i.id)),
	implement(o.expenses, (ctx, i) => po.listExpenses(ctx, i.id)),
	implement(o.addCharge, (ctx, i) => po.addCharge(ctx, i)),
	implement(o.removeCharge, (ctx, i) => {
		po.removeCharge(ctx, i.id, i.expenseId);
		return { ok: true as const };
	})
] as Impl[];
