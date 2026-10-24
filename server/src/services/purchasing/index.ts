/**
 * Purchasing service. Registers what references a part and how purchasing tables read in the
 * audit trail and in search.
 */
import { eq, sql } from 'drizzle-orm';
import { purchase, purchaseExpense, purchaseLine, supplier, supplierPart } from '../../db/schema/index.ts';
import { registerEntity, registerSearchable } from '../platform/index.ts';
import { registerPartReference } from '../parts/references.ts';

export * from './suppliers.ts';
export * from './orders.ts';

registerPartReference({
	name: 'supplier_entries',
	count: (ctx, id) =>
		ctx.db.select({ n: sql<number>`count(*)` }).from(supplierPart).where(eq(supplierPart.partId, id)).get()?.n ?? 0
});
registerPartReference({
	name: 'purchase_lines',
	count: (ctx, id) =>
		ctx.db.select({ n: sql<number>`count(*)` }).from(purchaseLine).where(eq(purchaseLine.partId, id)).get()?.n ?? 0
});

registerEntity(supplier, { label: 'Supplier', ref: (r) => ({ label: r.name, href: `/suppliers/${r.id}` }) });
registerEntity(supplierPart, { label: 'Supplier part', parent: { table: supplier, fk: 'supplierId' } });
registerEntity(purchase, { label: 'Purchase order', ref: (r) => ({ label: r.reference, href: `/purchases/${r.id}` }) });
registerEntity(purchaseLine, { label: 'PO line', parent: { table: purchase, fk: 'purchaseId' } });
registerEntity(purchaseExpense, { label: 'PO expense', parent: { table: purchase, fk: 'purchaseId' } });

registerSearchable({
	type: 'supplier',
	table: supplier,
	columns: [supplier.name, supplier.code],
	identifier: supplier.code,
	hit: (r) => ({ label: r.name, sublabel: r.code, href: `/suppliers/${r.id}`, status: r.isActive ? 'active' : 'inactive' })
});
registerSearchable({
	type: 'purchase',
	table: purchase,
	columns: [purchase.reference, purchase.supplierName, purchase.supplierReference],
	identifier: purchase.reference,
	hit: (r) => ({ label: r.reference, sublabel: r.supplierName, href: `/purchases/${r.id}`, status: r.status })
});
