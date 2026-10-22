/** Risk API shapes and the scales the risks UI shares. */
import type { Tone } from '#lib/components/opal/index.js';

export interface LinkedIssue {
	issue_id: number;
	issue_number: string;
	title: string;
	status: string;
	role: string;
}

export interface Risk {
	id: number;
	risk_number: string;
	title: string;
	description: string | null;
	condition: string | null;
	departure: string | null;
	asset_part_id: number | null;
	asset_text: string | null;
	consequence: string | null;
	asset_display: string | null;
	asset_part_number: string | null;
	asset_part_name: string | null;
	statement: string | null;
	disposition: string;
	owner_id: number | null;
	owner_name: string | null;
	probability: number;
	impact: number;
	score: number;
	severity: Severity;
	residual_probability: number | null;
	residual_impact: number | null;
	residual_score: number | null;
	residual_severity: Severity | null;
	accepted_by_name: string | null;
	accepted_at: string | null;
	acceptance_rationale: string | null;
	watch_observable: string | null;
	watch_threshold: string | null;
	watch_contingency: string | null;
	last_reviewed_at: string | null;
	last_reviewed_by_name: string | null;
	realized_issue_id: number | null;
	realized_issue_number: string | null;
	linked_issues: LinkedIssue[];
	acceptance_invalidated: boolean;
	created_at: string;
	updated_at: string;
}

export type Severity = 'low' | 'medium' | 'high';

export interface Owner {
	id: number;
	name: string;
}

export interface LintSegment {
	text: string;
	severity: 'block' | 'warn' | null;
	findings: { rule: string; message: string }[];
}

export interface HistoryRow {
	at: string;
	by: string | null;
	action: string;
	changes: { field: string; from: string | number | null; to: string | number | null }[];
	note: string | null;
}

export const PROBABILITY = [
	{ value: 1, label: '1 · Rare' },
	{ value: 2, label: '2 · Unlikely' },
	{ value: 3, label: '3 · Possible' },
	{ value: 4, label: '4 · Likely' },
	{ value: 5, label: '5 · Almost certain' }
];

export const IMPACT = [
	{ value: 1, label: '1 · Negligible' },
	{ value: 2, label: '2 · Minor' },
	{ value: 3, label: '3 · Moderate' },
	{ value: 4, label: '4 · Major' },
	{ value: 5, label: '5 · Severe' }
];

export const DISPOSITIONS = [
	'open',
	'mitigate',
	'watch',
	'research',
	'accepted',
	'closed',
	'realized'
];

export const SEVERITIES: { value: Severity; label: string }[] = [
	{ value: 'low', label: 'LOW (1–5)' },
	{ value: 'medium', label: 'MEDIUM (6–12)' },
	{ value: 'high', label: 'HIGH (13–25)' }
];

export const severityOf = (score: number): Severity =>
	score <= 5 ? 'low' : score <= 12 ? 'medium' : 'high';

export const severityTone: Record<Severity, Tone> = {
	low: 'ok',
	medium: 'warn',
	high: 'error'
};

/** Disposition colour: only exceptional or settled states carry a tone. */
export function dispositionTone(d: string): Tone {
	if (d === 'realized') return 'error';
	if (d === 'accepted') return 'ok';
	if (d === 'closed') return 'muted';
	return 'default';
}

/** Changing any of these on an accepted risk withdraws the acceptance. */
export const SIGNATURE_FIELDS = [
	'condition',
	'departure',
	'asset_part_id',
	'asset_text',
	'consequence',
	'probability',
	'impact'
];
