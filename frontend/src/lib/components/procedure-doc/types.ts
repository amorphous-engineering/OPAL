/**
 * Procedure document model. One shape for a procedure rendered as a document:
 * the execution page fills the execution fields (status, captured data, notes,
 * gates), the template editor will fill only the authoring fields and leave the
 * rest at their empty defaults.
 */

/** execute: operator controls. readonly: facts only. author: reserved for the template editor. */
export type DocMode = 'execute' | 'author' | 'readonly';

export type StepStatus =
	| 'pending'
	| 'in_progress'
	| 'on_hold'
	| 'completed'
	| 'awaiting_signoff'
	| 'signed_off'
	| 'skipped';

export const TERMINAL_STATUSES: readonly string[] = ['completed', 'signed_off', 'skipped'];

export interface DocField {
	name: string;
	label?: string;
	type: 'text' | 'number' | 'checkbox' | 'select' | 'textarea' | 'photo' | string;
	required?: boolean;
	unit?: string;
	min?: number;
	max?: number;
	step?: number | string;
	options?: string[];
	placeholder?: string;
	rows?: number;
	multiple?: boolean;
}

export interface DocSchema {
	fields?: DocField[];
}

export interface DocImage {
	attachment_id: number;
	caption: string | null;
}

export interface DocStepKitItem {
	part_id: number;
	part_name: string;
	part_number: string | null;
	quantity_required: number;
	usage_type: 'consume' | 'tooling' | string;
	notes: string | null;
}

export interface DocBlocker {
	kind: string;
	message: string;
	issue_id: number | null;
	issue_number: string | null;
}

export interface DocHold {
	issue_id: number;
	issue_number: string;
	title: string;
	kind: 'raised' | 'bound';
	disposition_state: string;
}

export interface DocCursor {
	user_id: number;
	name: string | null;
	initials: string;
	focused_at: string | null;
	stale: boolean;
}

export interface DocNote {
	id: number;
	author: string | null;
	created_at: string;
	body: string;
}

export interface DocAttachment {
	id: number;
	filename: string;
	mime_type: string;
	size_bytes: number;
	kind: string | null;
	note: string | null;
	uploaded_by: string | null;
	created_at: string;
}

export interface DocConsumption {
	id: number;
	part_id: number;
	part_number: string | null;
	part_name: string;
	opal_number: string | null;
	quantity: number;
	lot_number: string | null;
	location: string;
	usage_type: string;
	step_execution_id: number | null;
	step_number: string | null;
}

export interface DocStep {
	/** Snapshot order: the step's identity within the document. */
	order: number;
	/** Row id of the execution record; absent when authoring. */
	execution_id?: number;
	/** Display number, "2.1". */
	number: string;
	title: string;
	level: number;
	is_op: boolean;
	parent_order: number | null;
	status: StepStatus | string;
	instructions: string | null;
	caution: string | null;
	role: string | null;
	requires_signoff: boolean;
	is_contingency: boolean;
	estimated_duration_minutes?: number | null;
	images: DocImage[];
	step_kit: DocStepKitItem[];
	data_schema: DocSchema | null;
	data_captured: Record<string, unknown> | null;
	skip_reason: string | null;
	started_at?: string | null;
	completed: { by: string | null; initials: string; at: string | null } | null;
	signed_off: { by: string | null; at: string | null } | null;
	duration_seconds?: number | null;
	cursors: DocCursor[];
	holds: DocHold[];
	issue_history: {
		issue_id: number;
		issue_number: string;
		state: string;
		disposition_type: string | null;
	}[];
	/** Everything refusing this step's COMPLETE; non-empty renders the control inert with a reason. */
	complete_blockers: DocBlocker[];
	skip_blockers: DocBlocker[];
	notes: DocNote[];
	attachments: DocAttachment[];
	consumptions: DocConsumption[];
	/** "WAITING ON OP 2" / "WAITING ON 1.1 +1" */
	waiting: string | null;
}

export interface DocOp {
	order: number;
	number: string;
	title: string;
	status: StepStatus | string;
	instructions: string | null;
	caution: string | null;
	role: string | null;
	strict_sequence: boolean;
	is_contingency: boolean;
	is_ad_hoc: boolean;
	redline: {
		issue_id: number;
		issue_number: string | null;
		title: string | null;
		host_order: number | null;
	} | null;
	waiting_on_ops: string[];
	holds: DocHold[];
	open_ncs: { id: number; issue_number: string; title: string }[];
	progress: { done: number; total: number };
	/** The OP's own row; the only row when `steps` is empty. */
	step: DocStep;
	steps: DocStep[];
}

/**
 * Rows a keyboard cursor can visit, in document order: a leaf OP is one row, an
 * OP with sub-steps is its header row followed by its steps while it is open.
 */
export function visibleRows(
	ops: DocOp[],
	isOpOpen: (op: DocOp) => boolean
): { op: DocOp; step: DocStep }[] {
	const rows: { op: DocOp; step: DocStep }[] = [];
	for (const op of ops) {
		rows.push({ op, step: op.step });
		if (op.steps.length && isOpOpen(op)) for (const s of op.steps) rows.push({ op, step: s });
	}
	return rows;
}

export function isTerminal(status: string): boolean {
	return TERMINAL_STATUSES.includes(status);
}
