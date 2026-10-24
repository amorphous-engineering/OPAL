/** part, bom_lines (with part.parent_id), supplier, supplier_part, purchase, purchase_line, purchase_expense. */
import { PART_STATES, PROCUREMENT, PURCHASE_CHARGE_KINDS, PURCHASE_STATUSES, TRACKING_TYPES } from '@opal/shared';
import {
	bomLine,
	part,
	purchase,
	purchaseExpense,
	purchaseLine,
	supplier,
	supplierPart
} from '../db/schema/index.ts';
import { mergeLegacyBom } from '../services/parts/legacy.ts';
import {
	type ImportCtx,
	type Row,
	bool,
	dateOnly,
	derived,
	fail,
	insertRows,
	json,
	keep,
	legacyQty,
	num,
	oneOf,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';

const PART_COLS = [
	'id', 'internal_pn', 'external_pn', 'name', 'description', 'category', 'unit_of_measure',
	'tracking_type', 'procurement', 'tier', 'reorder_point', 'is_tooling',
	'calibration_interval_days', 'lifecycle_state', 'deleted_at', 'activated_at', 'activated_by_id',
	'created_at', 'updated_at', 'metadata', 'activation_cause', 'parent_id'
];

export function importParts(c: ImportCtx): void {
	const parts = readTable(c, 'part', PART_COLS);
	const rows = parts.map((r) => {
		const id = Number(r.id);
		let internalPn = str(r.internal_pn);
		if (!internalPn) {
			internalPn = `LEGACY-${id}`;
			c.report.placeholderPns.push({ id, internalPn });
		}
		let state = oneOf(c, r.lifecycle_state, PART_STATES, 'draft', `part ${id} lifecycle_state`);
		const deleted = ts(r.deleted_at);
		if (deleted) {
			state = 'obsolete';
			c.report.obsoleteParts.push({ id, internalPn });
		}
		const metadata = json<Record<string, unknown>>(r.metadata);
		return {
			id,
			internalPn,
			externalPn: str(r.external_pn),
			name: String(r.name),
			description: str(r.description),
			category: str(r.category),
			unitOfMeasure: String(r.unit_of_measure),
			trackingType: oneOf(c, r.tracking_type, TRACKING_TYPES, 'bulk', `part ${id} tracking_type`),
			procurement: oneOf(c, r.procurement, PROCUREMENT, 'make', `part ${id} procurement`),
			tier: Number(r.tier),
			reorderPoint: legacyQty(r.reorder_point),
			isTooling: bool(r.is_tooling),
			calibrationIntervalDays: num(r.calibration_interval_days),
			metadata: metadata && typeof metadata === 'object' && Object.keys(metadata).length ? metadata : null,
			state,
			activatedAt: ts(r.activated_at),
			activatedById: ref(c, 'user', r.activated_by_id, `part ${id} activated_by_id`),
			activationCause: str(r.activation_cause),
			obsoletedAt: deleted,
			obsoletedById: null,
			obsoleteCause: deleted ? 'Deleted before the import' : null,
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'part', insertRows(c, 'part', part, rows));

	// Assembly structure: bom_lines rows and part.parent_id become bom_line rows.
	const bomRows = readTable(c, 'bom_lines', ['id', 'assembly_id', 'component_id', 'quantity', 'reference_designator', 'notes', 'created_at', 'updated_at']);
	const merged = mergeLegacyBom(
		c.ids.part!,
		parts.filter((p) => c.ids.part!.has(Number(p.id))).map((p) => ({
			id: Number(p.id),
			parentId: num(p.parent_id),
			createdAt: tsReq(p.created_at),
			updatedAt: tsReq(p.updated_at)
		})),
		bomRows.map((r) => ({
			id: Number(r.id),
			assemblyId: Number(r.assembly_id),
			componentId: Number(r.component_id),
			quantity: Number(r.quantity),
			referenceDesignator: str(r.reference_designator),
			notes: str(r.notes),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		}))
	);
	c.report.warnings.push(...merged.warnings);
	// A line from bom_lines keeps its legacy id. A line from parent_id gets a new one.
	const legacyId = new Map(bomRows.map((r) => [`${r.assembly_id}>${r.component_id}`, Number(r.id)]));
	const used = new Set(legacyId.values());
	let next = Math.max(0, ...used);
	const lines = merged.lines.map((l) => ({ ...l, id: legacyId.get(`${l.assemblyId}>${l.componentId}`) ?? ++next }));
	const written = insertRows(c, 'bom_lines', bomLine, lines);
	derived(c, 'bom_line_from_parent_id', lines.filter((l) => !used.has(l.id)).length);
	void written;
}

export function importSuppliers(c: ImportCtx): void {
	const suppliers = readTable(c, 'supplier', ['id', 'name', 'code', 'description', 'website', 'email', 'phone', 'address', 'notes', 'is_active', 'created_at', 'updated_at', 'deleted_at']);
	track(c, 'supplier', insertRows(c, 'supplier', supplier, suppliers.map((r) => ({
		id: Number(r.id),
		name: String(r.name),
		code: str(r.code),
		description: str(r.description),
		website: str(r.website),
		email: str(r.email),
		phone: str(r.phone),
		address: str(r.address),
		notes: str(r.notes),
		// A deleted supplier stays as an inactive one: orders may still name it.
		isActive: bool(r.is_active) && !r.deleted_at,
		createdAt: tsReq(r.created_at),
		updatedAt: tsReq(r.updated_at)
	}))));

	const sp = readTable(c, 'supplier_part', ['id', 'supplier_id', 'part_id', 'vendor_pn', 'is_preferred', 'notes', 'created_at', 'updated_at']);
	insertRows(c, 'supplier_part', supplierPart, keep(c, 'supplier_part', sp, (r) =>
		c.ids.supplier!.has(Number(r.supplier_id)) && c.ids.part!.has(Number(r.part_id)) ? null : 'supplier or part is not imported')
		.map((r) => ({
			id: Number(r.id),
			supplierId: Number(r.supplier_id),
			partId: Number(r.part_id),
			vendorPn: String(r.vendor_pn),
			isPreferred: bool(r.is_preferred),
			leadTimeDays: null,
			notes: str(r.notes),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		})));
}

const CHARGE = new RegExp(`^\\s*(${PURCHASE_CHARGE_KINDS.join('|')})\\s*:\\s*(.*)$`, 'is');

export function importPurchasing(c: ImportCtx): void {
	const orders = readTable(c, 'purchase', ['id', 'reference', 'supplier', 'supplier_id', 'supplier_reference', 'status', 'ordered_at', 'received_at', 'target_date', 'destination', 'created_by_id', 'received_by_id', 'notes', 'created_at', 'updated_at']);
	const taken = new Set(orders.map((r) => str(r.reference)).filter((x): x is string => !!x));
	let poNumber = Math.max(0, ...[...taken].map((x) => Number(/^PO-(\d+)$/.exec(x)?.[1] ?? 0)));
	const rows = orders.map((r) => {
		const id = Number(r.id);
		let reference = str(r.reference);
		if (!reference) {
			do reference = `PO-${String(++poNumber).padStart(4, '0')}`;
			while (taken.has(reference));
			taken.add(reference);
			warn(c, `purchase ${id}: no reference, given ${reference}`);
		}
		const supplierId = ref(c, 'supplier', r.supplier_id, `purchase ${id} supplier_id`);
		return {
			id,
			reference,
			supplierId,
			supplierName: supplierId ? null : str(r.supplier)?.trim() || 'Unknown supplier',
			supplierReference: str(r.supplier_reference),
			status: oneOf(c, r.status, PURCHASE_STATUSES, 'draft', `purchase ${id} status`),
			orderedAt: ts(r.ordered_at),
			receivedAt: ts(r.received_at),
			targetDate: dateOnly(r.target_date),
			destination: str(r.destination),
			createdById: ref(c, 'user', r.created_by_id, `purchase ${id} created_by_id`),
			receivedById: ref(c, 'user', r.received_by_id, `purchase ${id} received_by_id`),
			notes: str(r.notes),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'purchase', insertRows(c, 'purchase', purchase, rows));

	const lines = readTable(c, 'purchase_line', ['id', 'purchase_id', 'part_id', 'qty_ordered', 'qty_received', 'unit_cost', 'destination', 'notes', 'created_at', 'updated_at']);
	const lineRows = lines.flatMap((r) => {
		const id = Number(r.id);
		if (!c.ids.purchase!.has(Number(r.purchase_id)) || !c.ids.part!.has(Number(r.part_id))) {
			fail(c, 'purchase_line', id, 'order or part is not imported');
			return [];
		}
		const qty = legacyQty(r.qty_ordered) ?? 0;
		if (qty <= 0) {
			fail(c, 'purchase_line', id, `quantity ordered ${String(r.qty_ordered)} is not above zero`);
			return [];
		}
		return [{
			id,
			purchaseId: Number(r.purchase_id),
			partId: Number(r.part_id),
			qtyOrdered: qty,
			unitCost: legacyQty(r.unit_cost),
			destination: str(r.destination),
			notes: str(r.notes),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		}];
	});
	track(c, 'purchase_line', insertRows(c, 'purchase_line', purchaseLine, lineRows));
	const lineById = new Map(lines.map((l) => [Number(l.id), l]));

	const exp = readTable(c, 'purchase_expense', ['id', 'purchase_id', 'purchase_line_id', 'part_id', 'quantity', 'unit_cost', 'total_cost', 'received_at', 'notes', 'created_at']);
	const expRows = exp.flatMap<Record<string, unknown>>((r: Row) => {
		const id = Number(r.id);
		if (!c.ids.purchase!.has(Number(r.purchase_id))) {
			fail(c, 'purchase_expense', id, 'order is not imported');
			return [];
		}
		const lineId = ref(c, 'purchase_line', r.purchase_line_id, `purchase_expense ${id} purchase_line_id`);
		const partId = ref(c, 'part', r.part_id, `purchase_expense ${id} part_id`) ?? (lineId ? Number(lineById.get(lineId)?.part_id) : null);
		const base = { id, purchaseId: Number(r.purchase_id), at: tsReq(r.received_at ?? r.created_at), createdAt: tsReq(r.created_at) };
		if (partId || lineId) {
			if (!partId) {
				fail(c, 'purchase_expense', id, 'receipt has no part');
				return [];
			}
			return [{ ...base, kind: 'receipt' as const, purchaseLineId: lineId, partId, quantity: legacyQty(r.quantity) ?? 0, unitCost: legacyQty(r.unit_cost), amount: null, notes: str(r.notes) }];
		}
		const m = CHARGE.exec(str(r.notes) ?? '');
		const amount = legacyQty(r.total_cost) ?? Math.round((legacyQty(r.quantity) ?? 0) * (Number(r.unit_cost ?? 0)));
		return [{ ...base, kind: ((m?.[1]?.toLowerCase() as (typeof PURCHASE_CHARGE_KINDS)[number]) ?? 'other'), purchaseLineId: null, partId: null, quantity: null, unitCost: null, amount, notes: m ? m[2]!.trim() || null : str(r.notes) }];
	});
	insertRows(c, 'purchase_expense', purchaseExpense, expRows);
}
