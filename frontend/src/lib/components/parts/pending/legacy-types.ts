/** Wire types of the legacy part page, kept for the parked sections in this folder only. */

export type Procurement = 'make' | 'buy' | 'both';
export type Tracking = 'bulk' | 'serialized';
export type LifecycleState = 'draft' | 'active';

export interface Part {
	id: number;
	internal_pn: string | null;
	external_pn: string | null;
	name: string;
	description: string | null;
	category: string | null;
	unit_of_measure: string;
	tracking_type: Tracking;
	procurement: Procurement;
	tier: number;
	tier_name: string | null;
	parent_id: number | null;
	reorder_point: number | string | null;
	is_low_stock: boolean;
	is_tooling: boolean;
	calibration_interval_days: number | null;
	metadata: Record<string, unknown> | null;
	total_quantity: number | string;
	lifecycle_state: LifecycleState;
	activated_at: string | null;
	activation_cause: string | null;
	created_at: string;
	updated_at: string;
}

export interface SchemaTier {
	level: number;
	name: string;
	code: string;
	description: string;
	default_tracking: Tracking;
	require_lot: boolean;
	auto_serial: boolean;
}

export interface CustomFieldDef {
	key: string;
	label: string;
	type: 'text' | 'number' | 'boolean' | 'select';
	options: string[];
	default: unknown;
	required: boolean;
}

export interface PartSchema {
	tiers: SchemaTier[];
	categories: string[];
	custom_fields: CustomFieldDef[];
	numbering_format: string | null;
}

export interface BomLine {
	id: number;
	assembly_id: number;
	assembly_internal_pn: string | null;
	assembly_name: string | null;
	component_id: number;
	component_internal_pn: string | null;
	component_name: string;
	component_external_pn: string | null;
	component_tier: number;
	component_state: LifecycleState | null;
	quantity: number;
	reference_designator: string | null;
	notes: string | null;
}

export interface BomTreeNode {
	part_id: number;
	internal_pn: string | null;
	name: string;
	external_pn: string | null;
	tier: number;
	quantity: number;
	reference_designator: string | null;
	children: BomTreeNode[];
}

export interface StockRecord {
	id: number;
	opal_number: string | null;
	location: string;
	quantity: number | string;
	lot_number: string | null;
	expiration_date: string | null;
	is_expired: boolean;
	calibration_status: string | null;
	calibration_due_at: string | null;
}

export interface PartSupplier {
	id: number;
	supplier_id: number;
	supplier_name: string;
	vendor_pn: string;
	is_preferred: boolean;
	notes: string | null;
}

export interface PoLine {
	line_id: number;
	purchase_id: number;
	reference: string | null;
	supplier: string;
	status: string;
	qty_ordered: number | string;
	qty_received: number | string;
	unit_cost: number | string | null;
	target_date: string | null;
}

export interface ProcedureUse {
	procedure_id: number;
	procedure_name: string;
	procedure_status: string;
	role: 'kit' | 'consume' | 'tooling' | 'produces';
	step_number: string | null;
	quantity: number | string;
}

export interface Consumption {
	id: number;
	consumed_at: string;
	quantity: number | string;
	opal_number: string | null;
	execution_id: number | null;
	work_order_number: string | null;
	notes: string | null;
}

export interface RequirementAllocation {
	allocation_id: number;
	requirement_id: string;
	requirement_ref_id: number | null;
	title: string | null;
	lifecycle_state: string | null;
	tbd: boolean;
	tbr: boolean;
	stale: boolean;
	status: string;
}

export interface TestTemplate {
	id: number;
	name: string;
	required: boolean;
	test_type: 'boolean' | 'numeric' | 'text';
	min_value: number | string | null;
	max_value: number | string | null;
	unit: string | null;
}

export interface PartDetail {
	part: Part;
	parent: { id: number; internal_pn: string | null; name: string } | null;
	tier_code: string | null;
	activated_by: string | null;
	expects: { bom: boolean; suppliers: boolean; po_lines: boolean };
	references: Record<string, number>;
	deletable: boolean;
	stock: StockRecord[];
	bom: BomLine[];
	where_used: BomLine[];
	suppliers: PartSupplier[];
	po_lines: PoLine[];
	procedure_use: ProcedureUse[];
	consumption: Consumption[];
	consumption_truncated: boolean;
	requirements: RequirementAllocation[];
	tests: TestTemplate[];
	onshape: {
		document_id: string;
		name: string | null;
		part_number: string | null;
		last_synced_at: string | null;
		stale: boolean;
	} | null;
}

export interface HistoryEntry {
	timestamp: string;
	action: string;
	user_name: string | null;
	changes: { field: string; old: unknown; new: unknown }[];
}

export interface PartRef {
	id: number;
	internal_pn: string | null;
	name: string;
}

/** pn · name for pickers and links. */
export function partLabel(p: { internal_pn: string | null; name: string }): string {
	return p.internal_pn ? `${p.internal_pn}  ${p.name}` : p.name;
}

export const PARTS_PAGE_SIZE = 50;

export interface PartsQuery {
	q: string;
	tier: string;
	category: string;
	procurement: string;
	state: string;
	parent: string;
	low: boolean;
	tooling: string;
	sort: string;
	dir: 'asc' | 'desc';
	page: number;
}
