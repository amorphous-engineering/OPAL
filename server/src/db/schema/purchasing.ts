/**
 * Tables for the purchasing area.
 *
 * Money is an integer scaled by 10,000 (4 decimals), the same scale as Qty. A quantity
 * received is never stored on a line: it is the sum of the receive moves that point at the
 * line (`stock_move.purchase_line_id`).
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { PURCHASE_EXPENSE_KINDS, PURCHASE_STATUSES } from '@opal/shared';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { part } from './parts.ts';

export const supplier = sqliteTable(
	'supplier',
	{
		id: id(),
		name: text('name').notNull(),
		code: text('code').unique(),
		description: text('description'),
		website: text('website'),
		email: text('email'),
		phone: text('phone'),
		address: text('address'),
		notes: text('notes'),
		isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [index('supplier_name_idx').on(t.name)]
);

/** A supplier's catalog number for a part. */
export const supplierPart = sqliteTable(
	'supplier_part',
	{
		id: id(),
		supplierId: integer('supplier_id')
			.notNull()
			.references(() => supplier.id, { onDelete: 'cascade' }),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		vendorPn: text('vendor_pn').notNull(),
		isPreferred: integer('is_preferred', { mode: 'boolean' }).notNull().default(false),
		leadTimeDays: integer('lead_time_days'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		unique('supplier_part_unique').on(t.supplierId, t.partId),
		index('supplier_part_part_idx').on(t.partId)
	]
);

export const purchase = sqliteTable(
	'purchase',
	{
		id: id(),
		/** PO-0001. Generated one past the highest PO-number in use, or typed by a person. */
		reference: text('reference').notNull().unique(),
		/** A registered supplier. The name then comes from the supplier row. */
		supplierId: integer('supplier_id').references(() => supplier.id),
		/** Free-text supplier, only when no registered supplier is chosen. */
		supplierName: text('supplier_name'),
		supplierReference: text('supplier_reference'),
		status: text('status', { enum: PURCHASE_STATUSES }).notNull().default('draft'),
		orderedAt: text('ordered_at'),
		receivedAt: text('received_at'),
		/** Expected delivery, a calendar date YYYY-MM-DD. */
		targetDate: text('target_date'),
		destination: text('destination'),
		createdById: integer('created_by_id').references(() => user.id, { onDelete: 'set null' }),
		receivedById: integer('received_by_id').references(() => user.id, { onDelete: 'set null' }),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('purchase_supplier_idx').on(t.supplierId),
		index('purchase_status_idx').on(t.status),
		oneOf('purchase_status_check', 'status', PURCHASE_STATUSES),
		check('purchase_supplier_check', sql`${t.supplierId} IS NOT NULL OR ${t.supplierName} IS NOT NULL`)
	]
);

export const purchaseLine = sqliteTable(
	'purchase_line',
	{
		id: id(),
		purchaseId: integer('purchase_id')
			.notNull()
			.references(() => purchase.id, { onDelete: 'cascade' }),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		qtyOrdered: integer('qty_ordered').notNull(),
		/** Money, scaled by 10,000. */
		unitCost: integer('unit_cost'),
		destination: text('destination'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('purchase_line_purchase_idx').on(t.purchaseId),
		index('purchase_line_part_idx').on(t.partId),
		check('purchase_line_qty_check', sql`${t.qtyOrdered} > 0`)
	]
);

/**
 * The expense ledger of an order. A `receipt` row is written once per received line and never
 * changes: it freezes the unit cost at the time of receipt. Any other kind is a charge
 * (shipping, tax, ...) a person adds and may remove. A receipt's total is quantity times unit
 * cost. A charge's total is `amount`.
 */
export const purchaseExpense = sqliteTable(
	'purchase_expense',
	{
		id: id(),
		purchaseId: integer('purchase_id')
			.notNull()
			.references(() => purchase.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: PURCHASE_EXPENSE_KINDS }).notNull(),
		purchaseLineId: integer('purchase_line_id').references(() => purchaseLine.id, {
			onDelete: 'set null'
		}),
		partId: integer('part_id').references(() => part.id),
		/** Qty received. Receipts only. */
		quantity: integer('quantity'),
		unitCost: integer('unit_cost'),
		/** Money, scaled by 10,000. Charges only. */
		amount: integer('amount'),
		at: text('at').notNull(),
		notes: text('notes'),
		createdAt: createdAt()
	},
	(t) => [
		index('purchase_expense_purchase_idx').on(t.purchaseId),
		oneOf('purchase_expense_kind_check', 'kind', PURCHASE_EXPENSE_KINDS),
		check(
			'purchase_expense_shape_check',
			sql`(${t.kind} = 'receipt' AND ${t.quantity} IS NOT NULL AND ${t.partId} IS NOT NULL AND ${t.amount} IS NULL)
				OR (${t.kind} <> 'receipt' AND ${t.amount} IS NOT NULL AND ${t.quantity} IS NULL AND ${t.partId} IS NULL)`
		)
	]
);
