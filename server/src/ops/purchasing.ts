import { contracts } from '@opal/shared';
import { eq } from 'drizzle-orm';
import { purchase } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { evidenceFrozen, registerOwnerGuard } from '../services/platform/attachments.ts';
import * as po from '../services/purchasing/index.ts';

const s = contracts.purchasing.suppliers;
const c = contracts.purchasing.catalog;
const o = contracts.purchasing.orders;

// A placed order takes new files in every state and keeps the ones it has. Only a draft is pencil.
registerOwnerGuard('purchase', (ctx, id, change) => {
	if (change.action === 'attach') return;
	const p = ctx.db.select({ reference: purchase.reference, status: purchase.status }).from(purchase).where(eq(purchase.id, id)).get();
	if (p && p.status !== 'draft') throw evidenceFrozen(`${p.reference} was placed: its attachments stay on the record`);
});

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
	implement(o.place, (ctx, i) => po.place(ctx, i.id)),
	implement(o.hold, (ctx, i) => po.hold(ctx, i.id, i.reason)),
	implement(o.resume, (ctx, i) => po.resume(ctx, i.id)),
	implement(o.cancel, (ctx, i) => po.cancel(ctx, i.id, i.reason)),
	implement(o.closeShort, (ctx, i) => po.closeShort(ctx, i.id, i.reason)),
	implement(o.discard, (ctx, i) => {
		po.discard(ctx, i.id);
		return { ok: true as const };
	}),
	implement(o.copy, (ctx, i) => po.copyToDraft(ctx, i.id)),
	implement(o.amendLine, (ctx, i) => po.amendLine(ctx, i)),
	implement(o.cancelLine, (ctx, i) => po.cancelLine(ctx, i)),
	implement(o.receive, (ctx, i) => po.receive(ctx, i)),
	implement(o.received, (ctx, i) => po.receivedRecords(ctx, i.id)),
	implement(o.expenses, (ctx, i) => po.listExpenses(ctx, i.id)),
	implement(o.addCharge, (ctx, i) => po.addCharge(ctx, i)),
	implement(o.removeCharge, (ctx, i) => {
		po.removeCharge(ctx, i.id, i.expenseId);
		return { ok: true as const };
	})
] as Impl[];
