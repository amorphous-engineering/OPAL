/** API shapes for executions (work orders). Mirrors src/opal/api/routes/execution.py. */
import type {
	DocAttachment,
	DocConsumption,
	DocCursor,
	DocOp
} from '#lib/components/procedure-doc/index.js';

export type InstanceStatus = 'cut' | 'in_work' | 'completed' | 'aborted';

export interface RosterEntry {
	user_id: number;
	name: string | null;
	initials: string;
	avatar_url?: string | null;
	step_order: number | null;
	step_number: string | null;
	focused_at: string | null;
	stale: boolean;
}

export interface HoldEntry {
	issue_id: number;
	issue_number: string;
	title: string;
	disposition_state: string;
	ticket_state: string;
	blocks: string[];
}

export interface IssueRow {
	id: number;
	issue_number: string;
	title: string;
	issue_type: string;
	priority: string;
	status: string;
	/** undispositioned | dispositioned | open | closed */
	state: string;
	/** pending | in_work | in_review | done */
	ticket_state: string;
	containment: string;
	disposition_type: string | null;
	is_blocking: boolean;
	raised_step_number: string | null;
	created_at: string;
}

export interface KitRow {
	part_id: number;
	part_number: string | null;
	part_name: string;
	uom: string | null;
	qty_required: number;
	qty_consumed: number;
	variance: number;
}

export interface UnplannedRow {
	part_id: number;
	part_number: string | null;
	part_name: string;
	qty_consumed: number;
}

export interface OutputRow {
	part_id: number;
	part_number: string | null;
	part_name: string;
	quantity: number;
}

export interface ProductionRow {
	id: number;
	part_id: number;
	part_number: string | null;
	part_name: string;
	serial_number: string | null;
	opal_number: string | null;
	quantity: number;
	lot_number: string | null;
	location: string;
	status: 'planned' | 'wip' | 'completed' | string;
}

export interface DataRow {
	step_number: string;
	step_order: number;
	field: string;
	unit: string | null;
	value: string;
	by: string | null;
	at: string | null;
}

export interface InstanceFacts {
	id: number;
	work_order: string | null;
	status: InstanceStatus;
	active: boolean;
	priority: number;
	procedure: { id: number; template_number: string; name: string; type: string };
	version: {
		id: number;
		number: number | null;
		created_at: string | null;
		created_by: string | null;
	};
	created_at: string;
	created_by: string | null;
	started_at: string | null;
	completed_at: string | null;
	scheduled_start_at: string | null;
	target_completion_at: string | null;
	last_activity_at: string | null;
	duration_seconds: number | null;
}

export interface ExecutionDocument {
	instance: InstanceFacts;
	progress: { done: number; total: number };
	ops: DocOp[];
	contingency_ops: DocOp[];
	issues: IssueRow[];
	holds: HoldEntry[];
	roster: RosterEntry[];
	my_cursor_order: number | null;
	kit: { items: KitRow[]; unplanned: UnplannedRow[] };
	consumptions: DocConsumption[];
	outputs: OutputRow[];
	productions: ProductionRow[];
	kit_relevant: boolean;
	material_relevant: boolean;
	can_finalize: boolean;
	reference_attachments: DocAttachment[];
	attachments: DocAttachment[];
	data_rows: DataRow[];
	generated_at: string;
}

/** GET /state: the light poll payload. */
export interface ExecutionState {
	instance: {
		id: number;
		status: InstanceStatus;
		progress: { done: number; total: number };
	};
	steps: {
		order: number;
		status: string;
		cursors: DocCursor[];
		holds: { issue_id: number; issue_number: string; disposition_state: string; kind: string }[];
		attachments: number;
		consumed: number;
		notes: { id: number }[];
	}[];
	roster: RosterEntry[];
	holds: HoldEntry[];
	generated_at: string;
}

export interface OverviewRow {
	id: number;
	work_order_number: string | null;
	procedure_id: number;
	procedure_template_number: string;
	procedure_name: string;
	version_number: number;
	status: InstanceStatus;
	priority: number;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	target_completion_at: string | null;
	cut_by: string | null;
	progress_done: number;
	progress_total: number;
	held_by: string[];
	working: {
		user_id: number;
		name: string | null;
		avatar_url?: string | null;
		step_number: string | null;
	}[];
}

export interface Overview {
	items: OverviewRow[];
	total: number;
	page: number;
	page_size: number;
	counts: Record<InstanceStatus, number>;
}

export interface PreviewPart {
	part_id: number;
	part_number: string | null;
	part_name: string;
	uom: string | null;
	per_work_order: number;
	required: number;
	available: number;
	is_available: boolean;
	usage_type: string | null;
}

export interface CutPreview {
	procedure_id: number;
	procedure_template_number: string;
	procedure_name: string;
	procedure_type: string;
	versions: { id: number; number: number; created_at: string; is_current: boolean }[];
	version_id: number;
	version_number: number;
	step_count: number;
	op_count: number;
	quantity: number;
	outputs: {
		part_id: number;
		part_number: string | null;
		part_name: string;
		quantity_each: number;
		serials: string[];
	}[];
	kit: PreviewPart[];
	step_kit: PreviewPart[];
	all_available: boolean;
}

export interface Report {
	instance: {
		id: number;
		work_order: string | null;
		status: string;
		procedure_id: number;
		procedure_name: string | null;
		version_number: number | null;
		operator: string | null;
		started_at: string | null;
		completed_at: string | null;
	};
	generated_at: string;
	end_items: {
		part_id: number;
		part_name: string;
		part_number: string | null;
		opal_number: string | null;
		serial_number: string | null;
		quantity: number;
		status: string;
	}[];
	operations: {
		step_number: string;
		level: number;
		title: string;
		status: string;
		started_at: string | null;
		completed_at: string | null;
		operator: string | null;
		signoff: string | null;
		signoff_at: string | null;
		signoffs: {
			slot: number;
			label: string;
			role: string | null;
			signed_by: string | null;
			signed_at: string | null;
		}[];
	}[];
	data_collects: {
		step_number: string;
		step_title: string;
		rows: { label: string; value: string; unit: string | null }[];
	}[];
	chart_datasets: {
		dataset_id: number;
		name: string;
		chart_fields: { name: string; label?: string; unit?: string }[];
		fields: { name: string; label?: string; unit?: string }[];
		points: { recorded_at: string; values: Record<string, unknown> }[];
	}[];
	issues: {
		id: number;
		issue_number: string;
		issue_type: string;
		priority: string;
		status: string;
		title: string;
		root_cause: string | null;
		disposition_type: string | null;
		created_at: string;
	}[];
	closeout_attachments: { id: number; filename: string; created_at: string }[];
}
