/**
 * Contracts for the reports area: the overview page, CSV exports, analytics, and the
 * instance lifecycle (demo database, factory reset).
 */
import { z } from 'zod';
import { op, zEmpty, zId, zOk } from '../op.ts';
import { zTimestamp } from '../time.ts';
import { zAuditEntry } from './platform.ts';

/** Optional project filter. Absent means every project. */
const zProjectFilter = { projectId: zId.optional() };

// ---------------------------------------------------------------- overview

/** Rows shown per overview list. `total` says how many exist. */
export const OVERVIEW_LIST_CAP = 8;
/** A risk is "high" on the overview above this score. */
export const OVERVIEW_HIGH_RISK_SCORE = 12;

export const zOverviewCapped = <T extends z.ZodType>(row: T) =>
	z.object({
		items: z.array(row),
		total: z.number().int(),
		/** How many of `total` are exceptional (blocked, overdue, expired). 0 when none. */
		flagged: z.number().int()
	});

export const zOverviewIssue = z.object({
	issueNumber: z.string(),
	title: z.string(),
	priority: z.string(),
	issueType: z.string(),
	/** Open, containment-bearing and undispositioned: the issue holds a work order. */
	holding: z.boolean(),
	assignee: z.string().nullable(),
	mine: z.boolean(),
	href: z.string()
});

export const zOverviewIssueCounts = z.object({
	open: z.number().int(),
	critical: z.number().int(),
	high: z.number().int(),
	medium: z.number().int(),
	low: z.number().int(),
	unassigned: z.number().int(),
	mine: z.number().int()
});

/** One row of the active executions list. The execution area registers the section. */
export const zOverviewExecution = z.object({
	label: z.string(),
	procedure: z.string().nullable(),
	status: z.string(),
	stepsDone: z.number().int(),
	stepsTotal: z.number().int(),
	blocked: z.boolean(),
	overdue: z.boolean(),
	targetCompletionAt: zTimestamp.nullable(),
	mine: z.boolean(),
	href: z.string()
});

export const zOverviewLowStock = z.object({
	partNumber: z.string(),
	name: z.string(),
	onHand: z.string(),
	reorderPoint: z.string(),
	uom: z.string(),
	href: z.string()
});

export const zOverviewPurchase = z.object({
	reference: z.string(),
	supplier: z.string(),
	status: z.string(),
	targetDate: z.string().nullable(),
	overdue: z.boolean(),
	linesOpen: z.number().int(),
	href: z.string()
});

export const OVERVIEW_ATTENTION_KINDS = ['calibration_overdue', 'expired', 'expiring'] as const;
export const zOverviewStockAttention = z.object({
	opalNumber: z.string().nullable(),
	partNumber: z.string().nullable(),
	partName: z.string(),
	kind: z.enum(OVERVIEW_ATTENTION_KINDS),
	/** ISO 8601 date or instant. */
	due: z.string(),
	href: z.string()
});

export const zOverviewRisk = z.object({
	riskNumber: z.string(),
	title: z.string(),
	score: z.number().int(),
	disposition: z.string(),
	href: z.string()
});

export const zOverview = z.object({
	issues: zOverviewCapped(zOverviewIssue).extend({ counts: zOverviewIssueCounts }),
	executions: zOverviewCapped(zOverviewExecution),
	lowStock: zOverviewCapped(zOverviewLowStock),
	purchases: zOverviewCapped(zOverviewPurchase),
	stockAttention: zOverviewCapped(zOverviewStockAttention),
	risks: zOverviewCapped(zOverviewRisk),
	activity: z.array(zAuditEntry)
});
export type Overview = z.infer<typeof zOverview>;
export type OverviewSections = keyof Overview;

// ---------------------------------------------------------------- execution report rows

/**
 * What the execution area hands the reports area for the execution CSV and the analytics.
 * One row per execution (work order).
 */
export const zReportExecutionRow = z.object({
	id: z.number().int(),
	projectId: z.number().int().nullable().optional(),
	procedure: z.string().nullable(),
	version: z.number().int().nullable(),
	workOrder: z.string().nullable(),
	status: z.string(),
	priority: z.string().nullable(),
	createdAt: zTimestamp,
	startedAt: zTimestamp.nullable(),
	completedAt: zTimestamp.nullable(),
	stepsCompleted: z.number().int(),
	stepsTotal: z.number().int()
});
export type ReportExecutionRow = z.infer<typeof zReportExecutionRow>;

// ---------------------------------------------------------------- analytics

const zWindow = {
	from: z.string().optional(),
	to: z.string().optional()
};

export const zExecutionMetrics = z.object({
	totalExecutions: z.number().int(),
	completed: z.number().int(),
	inWork: z.number().int(),
	cut: z.number().int(),
	aborted: z.number().int(),
	avgDurationMinutes: z.number().nullable(),
	/** Percent of executions completed, one decimal. */
	completionRate: z.number()
});
export type ExecutionMetrics = z.infer<typeof zExecutionMetrics>;

/**
 * The disposition gate exists only above advisory containment, so
 * open = advisoryOpen + undispositioned + dispositioned.
 */
export const zIssueMetrics = z.object({
	totalIssues: z.number().int(),
	open: z.number().int(),
	advisoryOpen: z.number().int(),
	undispositioned: z.number().int(),
	dispositioned: z.number().int(),
	closed: z.number().int(),
	voided: z.number().int(),
	byType: z.record(z.string(), z.number().int()),
	byPriority: z.record(z.string(), z.number().int())
});
export type IssueMetrics = z.infer<typeof zIssueMetrics>;

// ---------------------------------------------------------------- lifecycle

export const zLifecycleState = z.object({
	demoActive: z.boolean(),
	demoFileExists: z.boolean(),
	demoDbPath: z.string()
});
export type LifecycleState = z.infer<typeof zLifecycleState>;

export const FACTORY_RESET_WORD = 'RESET';

const csv = (name: string, path: string, summary: string, input: z.ZodObject, filename: string) =>
	op({
		name,
		method: 'GET',
		path,
		summary,
		input,
		output: z.string(),
		produces: 'text/csv',
		filename,
		access: 'signed-in',
		mcp: true
	});

export const reports = {
	overview: op({
		name: 'reports.overview',
		method: 'GET',
		path: '/overview',
		summary:
			'The landing page in one call: open issues, active executions, low stock, purchases awaiting receipt, calibration and expiry, high risks, recent activity.',
		input: z.object(zProjectFilter),
		output: zOverview,
		access: 'signed-in',
		mcp: true
	}),
	partsCsv: csv(
		'reports.partsCsv',
		'/reports/parts/csv',
		'Parts with on-hand quantity and stocking locations, as CSV.',
		z.object({
			category: z.string().optional(),
			lowStock: z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]).optional()
		}),
		'parts.csv'
	),
	inventoryCsv: csv(
		'reports.inventoryCsv',
		'/reports/inventory/csv',
		'Stock records with balance, location and lot, as CSV.',
		z.object({ location: z.string().optional() }),
		'inventory.csv'
	),
	executionsCsv: csv(
		'reports.executionsCsv',
		'/reports/executions/csv',
		'Executions with status, timing and step progress, as CSV.',
		z.object({ status: z.string().optional(), procedureId: z.coerce.number().int().optional(), ...zProjectFilter, ...zWindow }),
		'executions.csv'
	),
	issuesCsv: csv(
		'reports.issuesCsv',
		'/reports/issues/csv',
		'Issues with type, state, priority and links, as CSV.',
		z.object({ status: z.string().optional(), issueType: z.string().optional(), priority: z.string().optional(), ...zProjectFilter }),
		'issues.csv'
	),
	risksCsv: csv(
		'reports.risksCsv',
		'/reports/risks/csv',
		'Risks with score, residual score and owner, as CSV.',
		z.object({ disposition: z.string().optional(), minScore: z.coerce.number().int().optional(), ...zProjectFilter }),
		'risks.csv'
	),
	executionMetrics: op({
		name: 'reports.executionMetrics',
		method: 'GET',
		path: '/reports/analytics/executions',
		summary: 'Execution counts by status, average duration and completion rate.',
		input: z.object({ procedureId: z.coerce.number().int().optional(), ...zProjectFilter, ...zWindow }),
		output: zExecutionMetrics,
		access: 'signed-in',
		mcp: true
	}),
	issueMetrics: op({
		name: 'reports.issueMetrics',
		method: 'GET',
		path: '/reports/analytics/issues',
		summary: 'Issue counts by state, type and priority.',
		input: z.object({ ...zProjectFilter, ...zWindow }),
		output: zIssueMetrics,
		access: 'signed-in',
		mcp: true
	}),
	lifecycle: {
		get: op({
			name: 'reports.lifecycle.get',
			method: 'GET',
			path: '/settings/lifecycle',
			summary: 'Whether the demo database is active or present.',
			input: zEmpty,
			output: zLifecycleState,
			access: 'signed-in',
			mcp: false
		}),
		enterDemo: op({
			name: 'reports.lifecycle.enterDemo',
			method: 'POST',
			path: '/settings/demo/enter',
			summary: 'Switch the instance to the separate demo database. Creates it on first entry.',
			input: zEmpty,
			output: zLifecycleState,
			access: 'admin',
			mcp: false
		}),
		exitDemo: op({
			name: 'reports.lifecycle.exitDemo',
			method: 'POST',
			path: '/settings/demo/exit',
			summary: 'Switch back to the real database and delete the demo database and its attachments.',
			input: zEmpty,
			output: zLifecycleState,
			access: 'admin',
			mcp: false
		}),
		deleteDemo: op({
			name: 'reports.lifecycle.deleteDemo',
			method: 'DELETE',
			path: '/settings/demo',
			summary: 'Delete the demo database file while it is not active.',
			input: zEmpty,
			output: zLifecycleState,
			access: 'admin',
			mcp: false
		}),
		factoryReset: op({
			name: 'reports.lifecycle.factoryReset',
			method: 'POST',
			path: '/settings/factory-reset',
			summary: 'Erase all data, attachments and the demo database. The instance returns to first-run setup.',
			input: z.object({ confirm: z.string() }),
			output: zOk,
			access: 'admin',
			humanOnly: true,
			mcp: false
		})
	}
};
