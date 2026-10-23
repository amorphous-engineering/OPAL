/** Shapes returned by /api/procedures/*. */

export type ProcedureStatus = 'draft' | 'active' | 'deprecated';
export type ProcedureType = 'op' | 'build';

export interface StepNode {
	id: number;
	order: number;
	step_number: string;
	level: number;
	parent_step_id: number | null;
	title: string;
	instructions: string | null;
	is_contingency: boolean;
	requires_signoff: boolean;
	signoffs?: { label: string; role: string | null }[];
	estimated_duration_minutes: number | null;
	required_role: string | null;
	caution: string | null;
	required_data_schema: { fields?: DataField[] } | null;
	sub_steps: StepNode[];
}

export interface DataField {
	name: string;
	label?: string;
	type?: string;
	unit?: string;
	required?: boolean;
	min?: number;
	max?: number;
}

export interface ProcedureDetail {
	id: number;
	name: string;
	description: string | null;
	status: ProcedureStatus;
	procedure_type: ProcedureType;
	current_version_id: number | null;
	created_at: string;
	updated_at: string;
	unpublished_changes: boolean | null;
	steps: StepNode[];
}

export interface ProcedureRow {
	id: number;
	name: string;
	description: string | null;
	status: ProcedureStatus;
	procedure_type: ProcedureType;
	current_version_id: number | null;
	current_version_number: number | null;
	step_count: number;
	execution_count: number;
	created_at: string;
	updated_at: string;
}

export interface VersionRow {
	id: number;
	version_number: number;
	created_at: string;
	created_by_name: string | null;
	change_note: string | null;
	step_count: number;
}

export interface PartLine {
	id: number;
	part_id: number;
	part_name: string;
	part_internal_pn: string | null;
	part_external_pn: string | null;
	part_lifecycle_state: string | null;
}

export interface KitLine extends PartLine {
	part_on_hand: number | null;
	quantity_required: number;
}

export interface OutputLine extends PartLine {
	quantity_produced: number;
}

export interface SnapshotStep {
	id: number;
	order: number;
	step_number: string;
	level: number;
	parent_step_id: number | null;
	title: string;
	instructions: string | null;
	required_data_schema: { fields?: DataField[] } | null;
	is_contingency: boolean;
	requires_signoff: boolean;
	signoffs?: { label: string; role: string | null }[];
	estimated_duration_minutes: number | null;
	required_role: string | null;
	caution: string | null;
	strict_sequence: boolean;
	depends_on?: number[];
	images?: { attachment_id: number; caption: string | null }[];
	step_kit?: {
		part_id: number;
		part_name: string;
		quantity_required: number;
		usage_type: string;
		notes: string | null;
	}[];
}

export interface VersionDetail {
	id: number;
	version_number: number;
	created_at: string;
	created_by_name: string | null;
	change_note: string | null;
	procedure_id: number;
	procedure_name: string;
	procedure_type: ProcedureType;
	is_current: boolean;
	parts: { id: number; internal_pn: string | null; name: string }[];
	content: {
		procedure_name: string;
		procedure_description: string | null;
		steps: SnapshotStep[];
		kit_items: { part_id: number; quantity_required: number }[];
		output_items: { part_id: number; quantity_produced: number }[];
	};
}

export interface OpGroup {
	op: SnapshotStep;
	subs: SnapshotStep[];
}

/** Group a flat snapshot into ops (normal first, then contingency) with their sub-steps. */
export function groupOps(steps: SnapshotStep[]): { ops: OpGroup[]; contingency: OpGroup[] } {
	const byOrder = (a: SnapshotStep, b: SnapshotStep) => a.order - b.order;
	const children = new Map<number, SnapshotStep[]>();
	for (const s of steps) {
		if (s.parent_step_id != null) {
			const list = children.get(s.parent_step_id) ?? [];
			list.push(s);
			children.set(s.parent_step_id, list);
		}
	}
	const groups = steps
		.filter((s) => s.parent_step_id == null)
		.sort(byOrder)
		.map((op) => ({ op, subs: (children.get(op.id) ?? []).sort(byOrder) }));
	return {
		ops: groups.filter((g) => !g.op.is_contingency),
		contingency: groups.filter((g) => g.op.is_contingency)
	};
}

export function pn(part: { internal_pn?: string | null } | undefined): string {
	return part?.internal_pn ?? '—';
}

export interface RefDoc {
	id: number;
	original_filename: string;
	mime_type: string;
	size_bytes: number;
	created_at: string;
	uploaded_by_name: string | null;
}

export interface ExecutionRow {
	id: number;
	work_order_number: string | null;
	version_number: number;
	status: string;
	created_at: string;
}

export interface IssueRow {
	id: number;
	issue_number: string | null;
	title: string;
	priority: string;
	ticket_state: string;
}

export interface StepDiff {
	status: 'added' | 'removed' | 'modified' | 'unchanged';
	step_number: string;
	title_a: string | null;
	title_b: string | null;
	changed_fields: string[];
	changes: Record<string, { a: unknown; b: unknown }>;
}

export interface PartDiff {
	part_id: number;
	internal_pn: string | null;
	name: string | null;
	status: 'added' | 'removed' | 'modified';
	quantity_a: number | null;
	quantity_b: number | null;
}

export interface VersionDiff {
	procedure_id: number;
	procedure_name: string;
	version_a: VersionRow;
	version_b: VersionRow;
	procedure_changes: { field: string; a: string | null; b: string | null }[];
	steps: StepDiff[];
	kit: PartDiff[];
	outputs: PartDiff[];
	added: number;
	removed: number;
	modified: number;
	unchanged: number;
}
