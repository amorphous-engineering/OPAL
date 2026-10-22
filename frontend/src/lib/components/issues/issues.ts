/** Issue shapes and display helpers shared by the issues pages. */
import type { Tone } from '#lib/components/opal/index.js';

export const ISSUE_TYPES = ['non_conformance', 'bug', 'task', 'improvement'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const CONTAINMENTS = ['advisory', 'step', 'op', 'wo'] as const;
export const DISPOSITIONS = [
	'use_as_is',
	'rework',
	'repair',
	'scrap',
	'return_to_supplier',
	'no_defect'
] as const;
export const STATES = ['open', 'undispositioned', 'dispositioned', 'closed'] as const;

export const TYPE_ABBREV: Record<string, string> = {
	non_conformance: 'NC',
	bug: 'BUG',
	task: 'TASK',
	improvement: 'IMPR'
};

/** Option text for the containment picker: scope, then what it holds. */
export const CONTAINMENT_OPTION: Record<string, string> = {
	advisory: 'ADVISORY — holds nothing',
	step: 'STEP — holds the step',
	op: 'OP — holds the operation',
	wo: 'WO — holds the work order'
};

export interface Issue {
	id: number;
	issue_number: string | null;
	title: string;
	description: string | null;
	issue_type: string;
	status: string;
	priority: string;
	containment: string;
	containment_step_id: number | null;
	disp_state: string;
	dispositioned: boolean;
	part_id: number | null;
	procedure_id: number | null;
	procedure_instance_id: number | null;
	raised_step_id: number | null;
	raised_by_id: number | null;
	should_be: string | null;
	actual: string | null;
	steps_to_reproduce: string | null;
	expected_behavior: string | null;
	actual_behavior: string | null;
	expected_benefit: string | null;
	root_cause: string | null;
	corrective_action: string | null;
	disposition_type: string | null;
	disposition_rationale: string | null;
	assigned_to_id: number | null;
	dispositioned_by_id: number | null;
	dispositioned_at: string | null;
	created_at: string;
	updated_at: string;
	part_number: string | null;
	part_name: string | null;
	procedure_name: string | null;
	work_order_number: string | null;
	raised_by_name: string | null;
	assigned_to_name: string | null;
	dispositioned_by_name: string | null;
	self_dispositioned: boolean;
	raised_step_label: string | null;
	containment_step_label: string | null;
}

export interface LinkedRisk {
	risk_id: number;
	risk_number: string;
	title: string;
	relation: 'mitigation' | 'research' | 'realized';
}

export interface RedlineOp {
	step_number: number;
	label: string;
	title: string;
	status: string;
}

export interface IssueDetail extends Issue {
	raised_op_order: number | null;
	risks: LinkedRisk[];
	redline_ops: RedlineOp[];
}

export interface HoldTarget {
	label: string;
	scope: string;
	href: string;
}

export interface Assignee {
	id: number;
	name: string;
}

export interface StepOption {
	id: number;
	label: string;
	title: string;
}

export interface IssueComment {
	id: number;
	issue_id: number;
	user_id: number | null;
	user_name: string | null;
	body: string;
	created_at: string;
}

export interface Attachment {
	id: number;
	original_filename: string;
	mime_type: string;
	size_bytes: number;
	uploaded_by_name: string | null;
	created_at: string;
}

/** Disposition gate state in state colour; ordinary open work stays neutral. */
export function stateTone(disp: string): Tone {
	if (disp === 'undispositioned') return 'error';
	if (disp === 'dispositioned') return 'ok';
	if (disp === 'closed') return 'muted';
	return 'default';
}

export function priorityTone(p: string): Tone {
	if (p === 'critical' || p === 'high') return 'error';
	if (p === 'low') return 'muted';
	return 'default';
}

export function kb(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return bytes >= 1048576
		? `${(bytes / 1048576).toFixed(1)} MB`
		: `${(bytes / 1024).toFixed(1)} KB`;
}
