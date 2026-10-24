/** Suppliers and their catalog numbers for parts. */
import {
	OpalError,
	type Supplier,
	type SupplierPartRow,
	conflict,
	notFound
} from '@opal/shared';
import { and, asc, desc, eq, isNotNull, like, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { part, purchase, purchaseLine, supplier, supplierPart } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { invalid } from '../inventory/ledger.ts';
import { showMoney } from './money.ts';

type DbCtx = Pick<Ctx, 'db'>;
type SupplierRow = typeof supplier.$inferSelect;

function counts(ctx: DbCtx, id: number) {
	const purchaseCount =
		ctx.db.select({ n: sql<number>`count(*)` }).from(purchase).where(eq(purchase.supplierId, id)).get()?.n ?? 0;
	const partCount =
		ctx.db.select({ n: sql<number>`count(*)` }).from(supplierPart).where(eq(supplierPart.supplierId, id)).get()
			?.n ?? 0;
	return { purchaseCount, partCount };
}

function present(ctx: DbCtx, s: SupplierRow): Supplier {
	const { purchaseCount, partCount } = counts(ctx, s.id);
	return { ...s, purchaseCount, partCount, deletable: purchaseCount === 0 };
}

export function getRow(ctx: DbCtx, id: number): SupplierRow {
	const s = ctx.db.select().from(supplier).where(eq(supplier.id, id)).get();
	if (!s) throw notFound(`Supplier ${id}`);
	return s;
}

const blank = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

function assertCodeFree(ctx: DbCtx, code: string, exceptId?: number) {
	const clash = ctx.db.select().from(supplier).where(eq(supplier.code, code)).get();
	if (clash && clash.id !== exceptId) {
		throw conflict('duplicate_code', `Supplier with code '${code}' already exists`);
	}
}

export function listSuppliers(
	ctx: DbCtx,
	i: { cursor?: string; limit: number; q?: string; active?: boolean; sort: 'name' | 'code'; dir: 'asc' | 'desc' }
) {
	const term = i.q ? `%${i.q}%` : undefined;
	const where = and(
		term ? or(like(supplier.name, term), like(supplier.code, term), like(supplier.email, term)) : undefined,
		i.active === undefined ? undefined : eq(supplier.isActive, i.active)
	);
	const total = ctx.db.select({ n: sql<number>`count(*)` }).from(supplier).where(where).get()?.n ?? 0;
	const offset = Number(i.cursor ?? 0) || 0;
	const col = i.sort === 'name' ? supplier.name : supplier.code;
	const rows = ctx.db
		.select()
		.from(supplier)
		.where(where)
		.orderBy(i.dir === 'asc' ? asc(col) : desc(col), asc(supplier.id))
		.limit(i.limit)
		.offset(offset)
		.all();
	return {
		items: rows.map((r) => present(ctx, r)),
		next: offset + rows.length < total ? String(offset + rows.length) : null,
		total
	};
}

export function getSupplier(ctx: DbCtx, id: number): Supplier {
	return present(ctx, getRow(ctx, id));
}

export function createSupplier(
	ctx: Ctx,
	i: Omit<Partial<SupplierRow>, 'id' | 'createdAt' | 'updatedAt'> & { name: string }
): Supplier {
	const code = blank(i.code) ?? null;
	if (code) assertCodeFree(ctx, code);
	const row = insert(ctx, supplier, {
		name: i.name,
		code,
		description: i.description ?? null,
		website: blank(i.website) ?? null,
		email: blank(i.email) ?? null,
		phone: blank(i.phone) ?? null,
		address: i.address ?? null,
		notes: i.notes ?? null,
		isActive: i.isActive ?? true
	});
	return present(ctx, row);
}

export function updateSupplier(ctx: Ctx, i: Record<string, unknown> & { id: number }): Supplier {
	const cur = getRow(ctx, i.id);
	const patch: Partial<typeof supplier.$inferInsert> = {};
	// A supplier always has a name and a state: an explicit null leaves them alone.
	if (typeof i.name === 'string') patch.name = i.name;
	if (typeof i.isActive === 'boolean') patch.isActive = i.isActive;
	if (i.code !== undefined) {
		const code = blank(i.code as string | null) ?? null;
		if (code && code !== cur.code) assertCodeFree(ctx, code, cur.id);
		patch.code = code;
	}
	for (const k of ['website', 'email', 'phone'] as const) {
		if (i[k] !== undefined) patch[k] = blank(i[k] as string | null) ?? null;
	}
	for (const k of ['description', 'address', 'notes'] as const) {
		if (i[k] !== undefined) patch[k] = (i[k] as string | null) ?? null;
	}
	return present(ctx, update(ctx, supplier, cur.id, patch));
}

export function deleteSupplier(ctx: Ctx, id: number): void {
	getRow(ctx, id);
	if (counts(ctx, id).purchaseCount > 0) {
		throw conflict('supplier_in_use', 'Cannot delete supplier with existing purchase orders. Deactivate instead.');
	}
	for (const e of ctx.db.select().from(supplierPart).where(eq(supplierPart.supplierId, id)).all()) {
		remove(ctx, supplierPart, e.id);
	}
	remove(ctx, supplier, id);
}

// ---------------------------------------------------------------- catalog

function lastCost(ctx: DbCtx, supplierId: number, partId: number) {
	return ctx.db
		.select({ cost: purchaseLine.unitCost, at: purchase.createdAt })
		.from(purchaseLine)
		.innerJoin(purchase, eq(purchase.id, purchaseLine.purchaseId))
		.where(
			and(eq(purchase.supplierId, supplierId), eq(purchaseLine.partId, partId), isNotNull(purchaseLine.unitCost))
		)
		.orderBy(desc(purchase.createdAt), desc(purchaseLine.id))
		.limit(1)
		.get();
}

function presentEntry(ctx: DbCtx, id: number): SupplierPartRow {
	const r = ctx.db
		.select({ sp: supplierPart, sName: supplier.name, sActive: supplier.isActive, pName: part.name, pn: part.internalPn })
		.from(supplierPart)
		.innerJoin(supplier, eq(supplier.id, supplierPart.supplierId))
		.innerJoin(part, eq(part.id, supplierPart.partId))
		.where(eq(supplierPart.id, id))
		.get();
	if (!r) throw notFound('Catalog entry');
	const last = lastCost(ctx, r.sp.supplierId, r.sp.partId);
	return {
		id: r.sp.id,
		supplierId: r.sp.supplierId,
		supplierName: r.sName,
		supplierIsActive: r.sActive,
		partId: r.sp.partId,
		partName: r.pName,
		partInternalPn: r.pn,
		vendorPn: r.sp.vendorPn,
		isPreferred: r.sp.isPreferred,
		leadTimeDays: r.sp.leadTimeDays,
		notes: r.sp.notes,
		createdAt: r.sp.createdAt,
		lastUnitCost: last ? showMoney(last.cost) : null,
		lastOrderedAt: last ? last.at : null
	};
}

export function listCatalog(ctx: DbCtx, supplierId: number): SupplierPartRow[] {
	getRow(ctx, supplierId);
	return ctx.db
		.select({ id: supplierPart.id })
		.from(supplierPart)
		.where(eq(supplierPart.supplierId, supplierId))
		.orderBy(desc(supplierPart.isPreferred), asc(supplierPart.id))
		.all()
		.map((r) => presentEntry(ctx, r.id));
}

export function catalogForPart(ctx: DbCtx, partId: number): SupplierPartRow[] {
	if (!ctx.db.select({ id: part.id }).from(part).where(eq(part.id, partId)).get()) throw notFound(`Part ${partId}`);
	return ctx.db
		.select({ id: supplierPart.id })
		.from(supplierPart)
		.where(eq(supplierPart.partId, partId))
		.orderBy(desc(supplierPart.isPreferred), asc(supplierPart.id))
		.all()
		.map((r) => presentEntry(ctx, r.id));
}

export function addCatalogEntry(
	ctx: Ctx,
	i: { id: number; partId: number; vendorPn: string; isPreferred: boolean; leadTimeDays?: number | null; notes?: string | null }
): SupplierPartRow {
	getRow(ctx, i.id);
	if (!ctx.db.select({ id: part.id }).from(part).where(eq(part.id, i.partId)).get()) {
		throw invalid('partId', `Part ${i.partId} not found`);
	}
	const dup = ctx.db
		.select({ id: supplierPart.id })
		.from(supplierPart)
		.where(and(eq(supplierPart.supplierId, i.id), eq(supplierPart.partId, i.partId)))
		.get();
	if (dup) {
		throw new OpalError(409, 'duplicate', `A catalog entry for this supplier and part already exists`);
	}
	const row = insert(ctx, supplierPart, {
		supplierId: i.id,
		partId: i.partId,
		vendorPn: i.vendorPn,
		isPreferred: i.isPreferred,
		leadTimeDays: i.leadTimeDays ?? null,
		notes: i.notes ?? null
	});
	return presentEntry(ctx, row.id);
}

function entryRow(ctx: DbCtx, supplierId: number, entryId: number) {
	const e = ctx.db
		.select()
		.from(supplierPart)
		.where(and(eq(supplierPart.id, entryId), eq(supplierPart.supplierId, supplierId)))
		.get();
	if (!e) throw notFound(`Catalog entry ${entryId}`);
	return e;
}

export function updateCatalogEntry(
	ctx: Ctx,
	i: { id: number; entryId: number; vendorPn?: string; isPreferred?: boolean; leadTimeDays?: number | null; notes?: string | null }
): SupplierPartRow {
	const e = entryRow(ctx, i.id, i.entryId);
	const patch: Partial<typeof supplierPart.$inferInsert> = {};
	if (i.vendorPn !== undefined) patch.vendorPn = i.vendorPn;
	if (i.isPreferred !== undefined) patch.isPreferred = i.isPreferred;
	if (i.leadTimeDays !== undefined) patch.leadTimeDays = i.leadTimeDays;
	if (i.notes !== undefined) patch.notes = i.notes;
	update(ctx, supplierPart, e.id, patch);
	return presentEntry(ctx, e.id);
}

export function removeCatalogEntry(ctx: Ctx, supplierId: number, entryId: number): void {
	entryRow(ctx, supplierId, entryId);
	remove(ctx, supplierPart, entryId);
}
