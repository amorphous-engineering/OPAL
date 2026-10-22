/** Shapes returned by /api/inventory. Decimals arrive as numbers or strings. */
type Dec = number | string;

export interface InventoryItem {
	id: number;
	part_id: number;
	part_name: string;
	part_external_pn: string | null;
	part_uom: string | null;
	part_internal_pn: string | null;
	part_tracking_type: string | null;
	part_is_tooling: boolean;
	quantity: Dec;
	location: string;
	lot_number: string | null;
	last_counted_at: string | null;
	opal_number: string | null;
	source_type: string | null;
	expiration_date: string | null;
	is_expired: boolean;
	days_until_expiration: number | null;
	last_calibrated_at: string | null;
	calibration_due_at: string | null;
	calibration_status: 'ok' | 'due_soon' | 'overdue' | null;
	created_at: string;
	updated_at: string;
}

export interface StockByPart {
	part_id: number;
	internal_pn: string | null;
	external_pn: string | null;
	name: string;
	unit_of_measure: string | null;
	tracking_type: string;
	reorder_point: Dec | null;
	quantity: Dec;
	record_count: number;
	locations: string[];
	is_low_stock: boolean;
}

export interface LocationSummary {
	location: string;
	total_records: number;
	total_parts: number;
}

export interface DetailExecution {
	id: number;
	work_order_number: string | null;
	serial_number: string | null;
}

export interface LedgerRow {
	kind: string;
	timestamp: string;
	delta: Dec;
	balance: Dec;
	quantity: Dec | null;
	reason: string | null;
	notes: string | null;
	user_name: string | null;
	execution: DetailExecution | null;
	from_location: string | null;
	to_location: string | null;
	counterpart_opal: string | null;
}

export interface GenealogyRow {
	opal_number: string;
	part_id: number | null;
	part_number: string | null;
	part_name: string | null;
	quantity_used: Dec;
	work_order_number: string | null;
}

export interface StockTest {
	id: number;
	template_id: number | null;
	test_name: string;
	result: 'pass' | 'fail' | 'pending';
	value: string | null;
	notes: string | null;
	tested_at: string | null;
	tested_by_name: string | null;
}

export interface StockTestTemplate {
	id: number;
	name: string;
	description: string | null;
	required: boolean;
	test_type: string;
	min_value: Dec | null;
	max_value: Dec | null;
	unit: string | null;
}

export interface OpalDetail {
	inventory: InventoryItem;
	part: {
		id: number;
		internal_pn: string | null;
		external_pn: string | null;
		name: string;
		unit_of_measure: string | null;
		tracking_type: string;
		is_tooling: boolean;
		tier: number;
		tier_name: string | null;
		lifecycle_state: string;
	};
	source: {
		type: string | null;
		purchase: { id: number; reference: string | null; supplier: string | null } | null;
		execution: DetailExecution | null;
		transferred_from_opal: string | null;
	};
	ledger: LedgerRow[];
	components: GenealogyRow[];
	assemblies: GenealogyRow[];
	tests: StockTest[];
	test_templates: StockTestTemplate[];
}

export interface PickedPart {
	id: number;
	internal_pn: string | null;
	external_pn: string | null;
	name: string;
	unit_of_measure: string;
	tracking_type: string;
	tier: number;
	tier_name: string | null;
	lifecycle_state: string;
}

export interface TierRule {
	level: number;
	require_lot: boolean;
	auto_serial: boolean;
}

export const SOURCE_LABEL: Record<string, string> = {
	purchase: 'PURCHASE',
	production: 'PRODUCED',
	manual: 'MANUAL',
	transfer: 'MOVED'
};

export function sourceLabel(type: string | null | undefined): string {
	return type ? (SOURCE_LABEL[type] ?? type.toUpperCase()) : '—';
}

/** Ledger event kinds → state word and tone. */
export const LEDGER_KIND: Record<
	string,
	{ label: string; tone: 'ok' | 'warn' | 'error' | 'info' | 'muted' | 'default' }
> = {
	received: { label: 'RECEIVED', tone: 'ok' },
	produced: { label: 'PRODUCED', tone: 'ok' },
	planned: { label: 'PLANNED', tone: 'muted' },
	consumed: { label: 'CONSUMED', tone: 'warn' },
	tooling: { label: 'TOOLING', tone: 'info' },
	scrapped: { label: 'SCRAPPED', tone: 'error' },
	adjusted: { label: 'ADJUSTED', tone: 'default' },
	counted: { label: 'COUNTED', tone: 'info' },
	moved_in: { label: 'MOVED IN', tone: 'info' },
	moved_out: { label: 'MOVED OUT', tone: 'info' },
	moved: { label: 'MOVED', tone: 'info' }
};

export function num(v: Dec | null | undefined): number {
	return v === null || v === undefined || v === '' ? 0 : Number(v);
}
