export interface Finding {
	rule: string;
	name: string;
	severity: 'warn' | 'block_baseline';
	message: string;
	span?: [number, number];
}

export type Verification = 'verified' | 'partial' | 'open' | 'unallocated' | 'not_applicable';

export interface TreePart {
	part_id: number;
	name: string;
	status: string;
}

export interface TreeItem {
	id: number;
	req_number: string;
	revision: number;
	lifecycle_state: string;
	title: string;
	statement: string;
	rationale: string | null;
	level: number;
	category: string | null;
	verification_method: string | null;
	tbd: boolean;
	tbr: boolean;
	stale: boolean;
	parent_id: number | null;
	orphan: boolean;
	updated_at: string;
	lint: Finding[];
	parts: TreePart[];
	verification: Verification;
}

export interface TreeResponse {
	items: TreeItem[];
	total: number;
	queue_count: number;
}

export interface Ref {
	id: number;
	req_number: string;
	title: string;
}

export interface Summary {
	total: number;
	by_state: Record<string, number>;
	coverage: { leaves: number; leaves_allocated: number; with_verification_method: number };
	verification: Record<Verification, number>;
	ready_to_baseline: number;
	stale: Ref[];
	overdue_tbrs: (Ref & { owner: string; days_over: number; tbr_due: string })[];
	stuck_drafts: Ref[];
	as_of: string;
}

export interface Check {
	key: string;
	label: string;
	passed: boolean;
	severity: 'hard' | 'warning';
	detail: string | null;
}

export interface Allocation {
	id: number;
	part_id: number;
	part_name: string;
	internal_pn: string | null;
	status: 'open' | 'verified' | 'waived' | 'not_applicable';
	notes: string | null;
	verified_at: string | null;
	verified_by: string | null;
	against_revision: number;
	outdated: boolean;
}

export interface Dossier {
	id: number;
	req_number: string;
	revision: number;
	lifecycle_state: string;
	title: string;
	statement: string;
	rationale: string | null;
	category: string | null;
	level: number;
	parent_id: number | null;
	verification_method: string | null;
	tbd: boolean;
	tbr: boolean;
	tbr_owner_id: number | null;
	tbr_owner: string | null;
	tbr_due: string | null;
	stale: boolean;
	baselined_at: string | null;
	baselined_by: string | null;
	supersedes_id: number | null;
	predecessor_revision: number | null;
	created_at: string;
	updated_at: string;
	parent_chain: Ref[];
	children: {
		id: number;
		req_number: string;
		title: string;
		lifecycle_state: string;
		level: number;
		stale: boolean;
	}[];
	allocations: Allocation[];
	verification: Verification;
	revisions: {
		id: number;
		revision: number;
		lifecycle_state: string;
		statement: string;
		baselined_at: string | null;
	}[];
	baseline_events: {
		event_id: number;
		label: string | null;
		created_at: string;
		revision: number;
	}[];
	readiness: { ready: boolean; checks: Check[] } | null;
	lint: Finding[];
	can_delete: boolean;
}

export interface Segment {
	op: 'equal' | 'delete' | 'insert';
	text: string;
}

export interface RedlineData {
	rev_a: number;
	rev_b: number;
	title: Segment[];
	statement: Segment[];
	rationale: Segment[];
}

export interface QueueItem {
	id: number;
	req_number: string;
	revision: number;
	title: string;
	statement: string;
	rationale: string | null;
	level: number;
	verification_method: string | null;
	stale: boolean;
	children_count: number;
	parts: string[];
	chain: { id: number; req_number: string; title: string; lifecycle_state: string }[];
	warnings: string[];
	change: RedlineData | null;
}

export interface EventSummary {
	id: number;
	label: string | null;
	note: string | null;
	signed_by: string | null;
	created_at: string;
	locked: number;
	revised: number;
}

export interface EventItem {
	id: number;
	req_number: string;
	revision: number;
	title: string;
	statement: string;
	lifecycle_state: string;
	previous_revision: number | null;
	changed: string[];
	diff: RedlineData | null;
}

export interface EventDetail extends EventSummary {
	items: EventItem[];
}
