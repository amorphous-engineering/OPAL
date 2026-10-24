/**
 * Purchasing: suppliers, their catalog numbers for parts, and purchase orders with lines,
 * receiving and an expense ledger.
 *
 * Status workflow (legacy): draft -> ordered -> partial -> received. `partial` and `received`
 * follow from receiving and are never set by hand. `on_hold` and `cancelled` are set by hand.
 * Money is a decimal string with at most 4 places on the wire.
 */
import { z } from 'zod';
import { op, zId, zOk, zPageInput } from '../op.ts';
import { zQty } from '../qty.ts';
import { zTimestamp } from '../time.ts';

export const PURCHASE_STATUSES = ['draft', 'ordered', 'partial', 'received', 'cancelled', 'on_hold'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
/** Statuses in which header and lines can still change. */
export const PURCHASE_OPEN_STATUSES = ['draft', 'ordered', 'partial', 'on_hold'] as const;
/** Hand-driven status changes. */
export const PURCHASE_TRANSITIONS: Record<PurchaseStatus, readonly PurchaseStatus[]> = {
	draft: ['ordered', 'cancelled'],
	ordered: ['draft', 'on_hold', 'cancelled'],
	partial: ['on_hold', 'cancelled'],
	on_hold: ['ordered', 'cancelled'],
	received: [],
	cancelled: []
};
export const PURCHASE_CHARGE_KINDS = ['shipping', 'tax', 'duty', 'fee', 'other'] as const;
export const PURCHASE_EXPENSE_KINDS = ['receipt', ...PURCHASE_CHARGE_KINDS] as const;
export const PURCHASE_SORT_KEYS = ['reference', 'supplier', 'status', 'targetDate', 'orderedAt', 'createdAt'] as const;
export const SUPPLIER_SORT_KEYS = ['name', 'code'] as const;

/** Money on the wire: a decimal with at most 4 places. */
export const zPurchaseMoney = zQty;

const zFlag = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const zText = (max: number) => z.string().trim().max(max);

// ------------------------------------------------------------------- suppliers

export const zSupplier = z.object({
	id: z.number().int(),
	name: z.string(),
	code: z.string().nullable(),
	description: z.string().nullable(),
	website: z.string().nullable(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
	address: z.string().nullable(),
	notes: z.string().nullable(),
	isActive: z.boolean(),
	purchaseCount: z.number().int(),
	partCount: z.number().int(),
	/** No order refers to it: it can be deleted. Otherwise deactivate it. */
	deletable: z.boolean(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Supplier = z.infer<typeof zSupplier>;

/** http(s) URL with a host. The site renders as a link, so other schemes are refused. */
const zSupplierWebsite = z
	.string()
	.trim()
	.max(255)
	.refine((v) => {
		if (!v) return true;
		try {
			const u = new URL(v);
			return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== '';
		} catch {
			return false;
		}
	}, 'website must be an http:// or https:// URL')
	.transform((v) => (v === '' ? null : v));

const supplierFields = {
	code: zText(50).nullable().optional(),
	description: z.string().nullable().optional(),
	website: zSupplierWebsite.nullable().optional(),
	email: zText(255).nullable().optional(),
	phone: zText(50).nullable().optional(),
	address: z.string().nullable().optional(),
	notes: z.string().nullable().optional()
};

export const zSupplierCreate = z.object({
	name: zText(255).min(1),
	isActive: z.boolean().default(true),
	...supplierFields
});
export const zSupplierUpdate = z.object({
	id: zId,
	/** Null is ignored: a supplier always has a name. */
	name: zText(255).min(1).nullable().optional(),
	isActive: z.boolean().nullable().optional(),
	...supplierFields
});

export const zSupplierPage = z.object({
	items: z.array(zSupplier),
	next: z.string().nullable(),
	total: z.number().int()
});

// ------------------------------------------------------------- supplier catalog

export const zSupplierPartRow = z.object({
	id: z.number().int(),
	supplierId: z.number().int(),
	supplierName: z.string(),
	supplierIsActive: z.boolean(),
	partId: z.number().int(),
	partName: z.string(),
	partInternalPn: z.string(),
	vendorPn: z.string(),
	isPreferred: z.boolean(),
	leadTimeDays: z.number().int().nullable(),
	notes: z.string().nullable(),
	createdAt: zTimestamp,
	/** Unit cost of this supplier's most recent order line for the part. */
	lastUnitCost: zPurchaseMoney.nullable(),
	lastOrderedAt: zTimestamp.nullable()
});
export type SupplierPartRow = z.infer<typeof zSupplierPartRow>;

export const zSupplierPartCreate = z.object({
	id: zId,
	partId: zId,
	vendorPn: zText(255).min(1),
	isPreferred: z.boolean().default(false),
	leadTimeDays: z.number().int().min(0).nullable().optional(),
	notes: z.string().nullable().optional()
});
export const zSupplierPartUpdate = z.object({
	id: zId,
	entryId: zId,
	vendorPn: zText(255).min(1).optional(),
	isPreferred: z.boolean().optional(),
	leadTimeDays: z.number().int().min(0).nullable().optional(),
	notes: z.string().nullable().optional()
});

/** A PO line seen from the part. */
export const zPartPoLine = z.object({
	lineId: z.number().int(),
	purchaseId: z.number().int(),
	reference: z.string(),
	supplierName: z.string(),
	status: z.enum(PURCHASE_STATUSES),
	qtyOrdered: zQty,
	qtyReceived: zQty,
	unitCost: zPurchaseMoney.nullable(),
	targetDate: zDate.nullable()
});
export type PartPoLine = z.infer<typeof zPartPoLine>;

// --------------------------------------------------------------------- purchases

export const zPurchaseLine = z.object({
	id: z.number().int(),
	purchaseId: z.number().int(),
	partId: z.number().int(),
	partName: z.string(),
	partInternalPn: z.string(),
	partExternalPn: z.string().nullable(),
	unitOfMeasure: z.string(),
	trackingType: z.enum(['serialized', 'bulk']),
	/** What the part's tier asks of a receipt. Drives the receive form. */
	lotRequired: z.boolean(),
	autoSerial: z.boolean(),
	qtyOrdered: zQty,
	/** Sum of the receive moves that point at this line. */
	qtyReceived: zQty,
	qtyOutstanding: zQty,
	unitCost: zPurchaseMoney.nullable(),
	destination: z.string().nullable(),
	notes: z.string().nullable(),
	isComplete: z.boolean()
});
export type PurchaseLine = z.infer<typeof zPurchaseLine>;

export const zPurchase = z.object({
	id: z.number().int(),
	reference: z.string(),
	supplierId: z.number().int().nullable(),
	/** The registered supplier's name, else the free-text name. */
	supplierName: z.string(),
	supplierReference: z.string().nullable(),
	status: z.enum(PURCHASE_STATUSES),
	targetDate: zDate.nullable(),
	destination: z.string().nullable(),
	orderedAt: zTimestamp.nullable(),
	receivedAt: zTimestamp.nullable(),
	isOverdue: z.boolean(),
	notes: z.string().nullable(),
	lines: z.array(zPurchaseLine),
	totalLines: z.number().int(),
	totalCost: zPurchaseMoney.nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp,
	createdById: z.number().int().nullable(),
	createdByName: z.string().nullable(),
	receivedById: z.number().int().nullable(),
	receivedByName: z.string().nullable()
});
export type Purchase = z.infer<typeof zPurchase>;

export const zPurchaseListItem = z.object({
	id: z.number().int(),
	reference: z.string(),
	supplierId: z.number().int().nullable(),
	supplierName: z.string(),
	supplierReference: z.string().nullable(),
	status: z.enum(PURCHASE_STATUSES),
	targetDate: zDate.nullable(),
	isOverdue: z.boolean(),
	orderedAt: zTimestamp.nullable(),
	receivedAt: zTimestamp.nullable(),
	totalLines: z.number().int(),
	linesComplete: z.number().int(),
	totalCost: zPurchaseMoney.nullable(),
	createdAt: zTimestamp
});
export type PurchaseListItem = z.infer<typeof zPurchaseListItem>;
export const zPurchasePage = z.object({
	items: z.array(zPurchaseListItem),
	next: z.string().nullable(),
	total: z.number().int()
});

export const zPurchaseLineInput = z.object({
	partId: zId,
	qtyOrdered: zQty,
	unitCost: zPurchaseMoney.nullable().optional(),
	destination: zText(255).nullable().optional(),
	notes: z.string().nullable().optional()
});

export const zPurchaseCreate = z.object({
	supplierId: zId.nullable().optional(),
	supplierName: zText(255).nullable().optional(),
	supplierReference: zText(100).nullable().optional(),
	reference: zText(64).nullable().optional(),
	targetDate: zDate.nullable().optional(),
	destination: zText(255).nullable().optional(),
	notes: z.string().nullable().optional(),
	lines: z.array(zPurchaseLineInput).default([])
});

export const zPurchaseUpdate = z.object({
	id: zId,
	supplierId: zId.nullable().optional(),
	supplierName: zText(255).nullable().optional(),
	supplierReference: zText(100).nullable().optional(),
	reference: zText(64).nullable().optional(),
	targetDate: zDate.nullable().optional(),
	destination: zText(255).nullable().optional(),
	notes: z.string().nullable().optional(),
	status: z.enum(PURCHASE_STATUSES).optional()
});

export const zPurchaseLineUpdate = z.object({
	id: zId,
	lineId: zId,
	qtyOrdered: zQty.optional(),
	unitCost: zPurchaseMoney.nullable().optional(),
	destination: zText(255).nullable().optional(),
	notes: z.string().nullable().optional()
});

export const zPurchaseReceive = z.object({
	id: zId,
	lines: z
		.array(
			z.object({
				lineId: zId,
				quantity: zQty,
				location: zText(255).nullable().optional(),
				lotNumber: zText(100).nullable().optional(),
				/** Receive more than is outstanding; the form asks the person to confirm. */
				allowOverReceipt: z.boolean().default(false)
			})
		)
		.min(1, 'Enter a quantity for at least one line')
});

/** A stock record that a receipt created. */
export const zPurchaseReceivedRecord = z.object({
	stockId: z.number().int(),
	opalNumber: z.string(),
	partId: z.number().int(),
	partName: z.string(),
	partInternalPn: z.string(),
	quantity: zQty,
	location: z.string(),
	lotNumber: z.string().nullable(),
	serialNumber: z.string().nullable(),
	purchaseLineId: z.number().int(),
	receivedAt: zTimestamp
});

export const zPurchaseExpense = z.object({
	id: z.number().int(),
	purchaseId: z.number().int(),
	kind: z.enum(PURCHASE_EXPENSE_KINDS),
	purchaseLineId: z.number().int().nullable(),
	partId: z.number().int().nullable(),
	partName: z.string().nullable(),
	partInternalPn: z.string().nullable(),
	quantity: zQty.nullable(),
	unitCost: zPurchaseMoney.nullable(),
	totalCost: zPurchaseMoney.nullable(),
	at: zTimestamp,
	notes: z.string().nullable()
});
export type PurchaseExpense = z.infer<typeof zPurchaseExpense>;

// ------------------------------------------------------------------ operations

const suppliers = {
	list: op({
		name: 'purchasing.suppliers.list',
		method: 'GET',
		path: '/suppliers',
		summary: 'List suppliers. Search by name, code or email; filter by active.',
		input: zPageInput.extend({
			q: z.string().optional(),
			active: zFlag.optional(),
			sort: z.enum(SUPPLIER_SORT_KEYS).default('name'),
			dir: z.enum(['asc', 'desc']).default('asc')
		}),
		output: zSupplierPage,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'purchasing.suppliers.create',
		method: 'POST',
		path: '/suppliers',
		summary: 'Create a supplier.',
		input: zSupplierCreate,
		output: zSupplier,
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'purchasing.suppliers.get',
		method: 'GET',
		path: '/suppliers/:id',
		summary: 'Get one supplier.',
		input: z.object({ id: zId }),
		output: zSupplier,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'purchasing.suppliers.update',
		method: 'PATCH',
		path: '/suppliers/:id',
		summary: 'Edit a supplier, or deactivate it.',
		input: zSupplierUpdate,
		output: zSupplier,
		access: 'signed-in',
		mcp: true
	}),
	delete: op({
		name: 'purchasing.suppliers.delete',
		method: 'DELETE',
		path: '/suppliers/:id',
		summary: 'Delete a supplier no order refers to. Otherwise deactivate it.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};

const catalog = {
	list: op({
		name: 'purchasing.catalog.list',
		method: 'GET',
		path: '/suppliers/:id/parts',
		summary: "A supplier's catalog: the parts it sells and its number for each.",
		input: z.object({ id: zId }),
		output: z.array(zSupplierPartRow),
		access: 'signed-in',
		mcp: true
	}),
	add: op({
		name: 'purchasing.catalog.add',
		method: 'POST',
		path: '/suppliers/:id/parts',
		summary: 'Add a part to a supplier catalog with its supplier part number.',
		input: zSupplierPartCreate,
		output: zSupplierPartRow,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'purchasing.catalog.update',
		method: 'PATCH',
		path: '/suppliers/:id/parts/:entryId',
		summary: 'Change a supplier part number, preferred flag, lead time or notes.',
		input: zSupplierPartUpdate,
		output: zSupplierPartRow,
		access: 'signed-in',
		mcp: true
	}),
	remove: op({
		name: 'purchasing.catalog.remove',
		method: 'DELETE',
		path: '/suppliers/:id/parts/:entryId',
		summary: 'Remove a catalog entry.',
		input: z.object({ id: zId, entryId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	forPart: op({
		name: 'purchasing.catalog.forPart',
		method: 'GET',
		path: '/parts/:id/suppliers',
		summary: 'Every supplier that sells a part, preferred first.',
		input: z.object({ id: zId }),
		output: z.array(zSupplierPartRow),
		access: 'signed-in',
		mcp: true
	}),
	poLinesForPart: op({
		name: 'purchasing.catalog.poLinesForPart',
		method: 'GET',
		path: '/parts/:id/po-lines',
		summary: 'Every purchase order line for a part, newest first.',
		input: z.object({ id: zId }),
		output: z.array(zPartPoLine),
		access: 'signed-in',
		mcp: true
	})
};

const orders = {
	list: op({
		name: 'purchasing.orders.list',
		method: 'GET',
		path: '/purchases',
		summary: 'List purchase orders. Filter by status, supplier, text, target date, open, awaiting or overdue.',
		input: zPageInput.extend({
			status: z.enum(PURCHASE_STATUSES).optional(),
			/** Draft, ordered, partial and on hold. */
			open: zFlag.optional(),
			/** Ordered or partially received: waiting for goods. */
			awaiting: zFlag.optional(),
			overdue: zFlag.optional(),
			supplierId: zId.optional(),
			supplier: z.string().optional(),
			q: z.string().optional(),
			targetFrom: zDate.optional(),
			targetTo: zDate.optional(),
			sort: z.enum(PURCHASE_SORT_KEYS).default('createdAt'),
			dir: z.enum(['asc', 'desc']).default('desc')
		}),
		output: zPurchasePage,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'purchasing.orders.create',
		method: 'POST',
		path: '/purchases',
		summary: 'Create a purchase order as a draft. A PO number is assigned unless one is given.',
		input: zPurchaseCreate,
		output: zPurchase,
		access: 'signed-in',
		mcp: true
	}),
	// Static path before `/purchases/:id`.
	get: op({
		name: 'purchasing.orders.get',
		method: 'GET',
		path: '/purchases/:id',
		summary: 'Get one purchase order with its lines.',
		input: z.object({ id: zId }),
		output: zPurchase,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'purchasing.orders.update',
		method: 'PATCH',
		path: '/purchases/:id',
		summary: 'Edit the header of a purchase order or move it through its status workflow.',
		input: zPurchaseUpdate,
		output: zPurchase,
		access: 'signed-in',
		mcp: true
	}),
	addLine: op({
		name: 'purchasing.orders.addLine',
		method: 'POST',
		path: '/purchases/:id/lines',
		summary: 'Add a line to an open purchase order. The part must be active.',
		input: zPurchaseLineInput.extend({ id: zId }),
		output: zPurchaseLine,
		access: 'signed-in',
		mcp: true
	}),
	updateLine: op({
		name: 'purchasing.orders.updateLine',
		method: 'PATCH',
		path: '/purchases/:id/lines/:lineId',
		summary: 'Change a line. Quantity cannot drop below what arrived. Unit cost locks after receipt.',
		input: zPurchaseLineUpdate,
		output: zPurchaseLine,
		access: 'signed-in',
		mcp: true
	}),
	removeLine: op({
		name: 'purchasing.orders.removeLine',
		method: 'DELETE',
		path: '/purchases/:id/lines/:lineId',
		summary: 'Remove a line nothing has been received against.',
		input: z.object({ id: zId, lineId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	receive: op({
		name: 'purchasing.orders.receive',
		method: 'POST',
		path: '/purchases/:id/receive',
		summary:
			'Receive goods against lines, in full or in part. Creates stock records, writes the expense ledger and settles the status.',
		input: zPurchaseReceive,
		output: zPurchase,
		access: 'signed-in',
		mcp: true
	}),
	received: op({
		name: 'purchasing.orders.received',
		method: 'GET',
		path: '/purchases/:id/inventory',
		summary: 'Stock records that receiving against this order created.',
		input: z.object({ id: zId }),
		output: z.array(zPurchaseReceivedRecord),
		access: 'signed-in',
		mcp: true
	}),
	expenses: op({
		name: 'purchasing.orders.expenses',
		method: 'GET',
		path: '/purchases/:id/expenses',
		summary: 'The expense ledger: one receipt row per received line, and the charges.',
		input: z.object({ id: zId }),
		output: z.array(zPurchaseExpense),
		access: 'signed-in',
		mcp: true
	}),
	addCharge: op({
		name: 'purchasing.orders.addCharge',
		method: 'POST',
		path: '/purchases/:id/expenses',
		summary: 'Record a cost that is not a line: shipping, tax, duty, fee or other.',
		input: z.object({
			id: zId,
			kind: z.enum(PURCHASE_CHARGE_KINDS),
			amount: zPurchaseMoney,
			note: zText(500).nullable().optional()
		}),
		output: zPurchaseExpense,
		access: 'signed-in',
		mcp: true
	}),
	removeCharge: op({
		name: 'purchasing.orders.removeCharge',
		method: 'DELETE',
		path: '/purchases/:id/expenses/:expenseId',
		summary: 'Remove a charge. Receipt rows are permanent.',
		input: z.object({ id: zId, expenseId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};

export const purchasing = { suppliers, catalog, orders };
