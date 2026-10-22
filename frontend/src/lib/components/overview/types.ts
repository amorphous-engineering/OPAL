/** Shapes served by GET /api/overview. */
import type { AuditEntry } from '#lib/components/audit/audit.js';

export interface Capped<T> {
	items: T[];
	total: number;
	/** How many of `total` are exceptional (blocked, overdue, expired). */
	flagged: number;
}

export interface IssueRow {
	issue_number: string;
	title: string;
	priority: string;
	issue_type: string;
	holding: boolean;
	assignee: string | null;
	mine: boolean;
	href: string;
}

export interface ExecutionRow {
	label: string;
	procedure: string | null;
	status: string;
	steps_done: number;
	steps_total: number;
	blocked: boolean;
	overdue: boolean;
	target_completion_at: string | null;
	mine: boolean;
	href: string;
}

export interface LowStockRow {
	part_number: string | null;
	name: string;
	on_hand: number;
	reorder_point: number;
	uom: string;
	href: string;
}

export interface PurchaseRow {
	reference: string;
	supplier: string;
	status: string;
	target_date: string | null;
	overdue: boolean;
	lines_open: number;
	href: string;
}

export interface StockAttentionRow {
	opal_number: string | null;
	part_number: string | null;
	part_name: string;
	kind: 'calibration_overdue' | 'expired' | 'expiring';
	due: string;
	href: string;
}

export interface RiskRow {
	risk_number: string;
	title: string;
	score: number;
	disposition: string;
	href: string;
}

export interface Overview {
	issue_counts: {
		open: number;
		critical: number;
		high: number;
		medium: number;
		low: number;
		unassigned: number;
		mine: number;
	};
	issues: Capped<IssueRow>;
	executions: Capped<ExecutionRow>;
	low_stock: Capped<LowStockRow>;
	purchases: Capped<PurchaseRow>;
	stock_attention: Capped<StockAttentionRow>;
	risks: Capped<RiskRow>;
	activity: AuditEntry[];
}
