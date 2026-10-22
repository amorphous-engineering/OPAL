export type PurchaseStatus = 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled' | 'on_hold';

export interface PurchaseLine {
	id: number;
	part_id: number;
	part_name: string;
	part_internal_pn: string | null;
	part_external_pn: string | null;
	unit_of_measure: string;
	tracking_type: string;
	lot_required: boolean;
	auto_serial: boolean;
	qty_ordered: string | number;
	qty_received: string | number;
	qty_outstanding: string | number;
	unit_cost: string | number | null;
	destination: string | null;
	notes: string | null;
	is_complete: boolean;
}

export interface Purchase {
	id: number;
	reference: string | null;
	supplier: string;
	supplier_id: number | null;
	supplier_name: string | null;
	supplier_reference: string | null;
	status: PurchaseStatus;
	target_date: string | null;
	destination: string | null;
	ordered_at: string | null;
	received_at: string | null;
	is_overdue: boolean;
	notes: string | null;
	lines: PurchaseLine[];
	total_lines: number;
	total_cost: string | number | null;
	created_at: string;
	updated_at: string;
	created_by_name: string | null;
	received_by_name: string | null;
}

export interface PurchaseListItem {
	id: number;
	reference: string | null;
	supplier: string;
	supplier_id: number | null;
	supplier_name: string | null;
	supplier_reference: string | null;
	status: PurchaseStatus;
	target_date: string | null;
	is_overdue: boolean;
	ordered_at: string | null;
	received_at: string | null;
	total_lines: number;
	lines_complete: number;
	total_cost: string | number | null;
	created_at: string;
}

export interface Expense {
	id: number;
	purchase_line_id: number | null;
	part_id: number | null;
	part_name: string | null;
	part_internal_pn: string | null;
	quantity: string | number;
	unit_cost: string | number | null;
	total_cost: string | number | null;
	tier: number | null;
	received_at: string;
	notes: string | null;
	charge_kind: string | null;
}

export interface ReceivedRecord {
	inventory_id: number;
	opal_number: string | null;
	part_id: number;
	part_name: string;
	part_internal_pn: string | null;
	quantity: string | number;
	location: string;
	lot_number: string | null;
	purchase_line_id: number | null;
	created_at: string;
}

export interface Attachment {
	id: number;
	original_filename: string;
	mime_type: string;
	size_bytes: number;
	kind: string | null;
	uploaded_by_name: string | null;
	created_at: string;
}

export interface Supplier {
	id: number;
	name: string;
	code: string | null;
	description: string | null;
	website: string | null;
	email: string | null;
	phone: string | null;
	address: string | null;
	notes: string | null;
	is_active: boolean;
	purchase_count: number;
	part_count: number;
	created_at: string | null;
	updated_at: string | null;
}

export interface SupplierPart {
	id: number;
	supplier_id: number;
	part_id: number;
	part_name: string;
	part_internal_pn: string | null;
	vendor_pn: string;
	is_preferred: boolean;
	notes: string | null;
	last_unit_cost: string | number | null;
	last_ordered_at: string | null;
}

export interface PickedPart {
	id: number;
	internal_pn: string | null;
	name: string;
	unit_of_measure?: string;
	procurement?: string;
}

export const PURCHASE_STATUSES: PurchaseStatus[] = [
	'draft',
	'ordered',
	'partial',
	'on_hold',
	'received',
	'cancelled'
];

/** Zero-safe numeric view of a server decimal. */
export const num = (v: string | number | null | undefined): number => Number(v ?? 0);

export const LIST_PAGE_SIZE = 50;
