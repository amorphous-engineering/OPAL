/**
 * View model of an execution document, the shape the procedure-doc components render.
 * `adapt.ts` builds it from the `execution.document` contract output. Lists, the cut preview
 * and the report use the contract types directly.
 */
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
	spec: string | null;
	out_of_spec: boolean;
	by: string | null;
	at: string | null;
}

export interface InstanceFacts {
	id: number;
	work_order: string | null;
	status: InstanceStatus;
	active: boolean;
	priority: string;
	project: { id: number; code: string; name: string };
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
		notes: number;
	}[];
	roster: RosterEntry[];
	holds: HoldEntry[];
	generated_at: string;
}
