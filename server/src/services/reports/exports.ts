/** CSV exports and analytics. Data comes from the owning areas' queries. */
import {
	type ExecutionMetrics,
	type IssueMetrics,
	OpalError,
	type ReportExecutionRow
} from '@opal/shared';
import type { Ctx } from '../../context.ts';
import { stockByPart, listStock, lowStockPartIds } from '../inventory/index.ts';
import * as issues from '../issues/service.ts';
import * as parts from '../parts/index.ts';
import * as risks from '../risks/service.ts';
import { clip, toCsv } from './csv.ts';
import { inProject } from './overview.ts';

function allPages<T>(page: (cursor: string | undefined) => { items: T[]; next: string | null }): T[] {
	const rows: T[] = [];
	let cursor: string | undefined;
	do {
		const p = page(cursor);
		rows.push(...p.items);
		cursor = p.next ?? undefined;
	} while (cursor);
	return rows;
}

/** A date or instant from a query string, as an ISO instant. A bare date is the start of that day (UTC). */
function bound(v: string | undefined, name: string): string | undefined {
	if (!v) return undefined;
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
	if (Number.isNaN(ms)) throw new OpalError(422, 'invalid_input', 'Invalid input', { [name]: 'must be ISO 8601' });
	return new Date(ms).toISOString();
}

function inWindow(at: string, from?: string, to?: string): boolean {
	return (!from || at >= from) && (!to || at <= to);
}

// ---------------------------------------------------------------- parts

export function partsCsv(ctx: Ctx, f: { category?: string; lowStock?: boolean }): string {
	const stock = new Map(
		allPages((cursor) => stockByPart(ctx, { limit: 500, sort: 'part', order: 'asc', cursor })).map((s) => [s.partId, s])
	);
	const low = f.lowStock ? new Set(lowStockPartIds(ctx)) : null;
	const rows = allPages((cursor) =>
		parts.list(ctx, { limit: 500, sort: 'internalPn', dir: 'asc', category: f.category, cursor })
	).filter((p) => !low || low.has(p.id));
	return toCsv(
		['Part Number', 'External PN', 'Name', 'Category', 'Description', 'Unit', 'Procurement', 'State', 'Total Quantity', 'Locations'],
		rows.map((p) => [
			p.internalPn,
			p.externalPn,
			p.name,
			p.category,
			clip(p.description, 100),
			p.unitOfMeasure,
			p.procurement,
			p.state,
			stock.get(p.id)?.balance ?? '0',
			(stock.get(p.id)?.locations ?? []).join(', ')
		])
	);
}

// ---------------------------------------------------------------- inventory

export function inventoryCsv(ctx: Ctx, f: { location?: string }): string {
	const rows = allPages((cursor) => listStock(ctx, { limit: 500, order: 'asc', cursor }));
	const want = f.location?.toLowerCase();
	return toCsv(
		['OPAL Number', 'Part Number', 'External PN', 'Part Name', 'Quantity', 'Location', 'Lot Number', 'Serial Number', 'Last Counted', 'Last Updated'],
		rows
			.filter((r) => !want || r.location.toLowerCase().includes(want))
			.map((r) => [
				r.opalNumber,
				r.partInternalPn,
				r.partExternalPn,
				r.partName,
				r.balance,
				r.location,
				r.lotNumber,
				r.serialNumber,
				r.lastCountedAt,
				r.updatedAt
			])
	);
}

// ---------------------------------------------------------------- executions (execution area supplies the rows)

export interface ExecutionReportFilter {
	status?: string;
	procedureId?: number;
	projectId?: number;
	from?: string;
	to?: string;
}

type ExecutionRows = (ctx: Ctx, f: { status?: string; procedureId?: number; projectId?: number }) => ReportExecutionRow[];
let executionRows: ExecutionRows = () => [];

/**
 * The execution area calls this once. Its function returns one row per execution matching
 * `status`, `procedureId` and `projectId` (the date window is applied here, on `createdAt`).
 */
export function registerExecutionReport(fn: ExecutionRows): void {
	executionRows = fn;
}

function executions(ctx: Ctx, f: ExecutionReportFilter): ReportExecutionRow[] {
	const from = bound(f.from, 'from');
	const to = bound(f.to, 'to');
	return inProject(executionRows(ctx, f), f.projectId).filter((r) => inWindow(r.createdAt, from, to));
}

const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

export function executionsCsv(ctx: Ctx, f: ExecutionReportFilter): string {
	const rows = executions(ctx, f).sort((a, b) => b.id - a.id);
	return toCsv(
		['ID', 'Procedure', 'Version', 'Work Order', 'Status', 'Created At', 'Started At', 'Completed At', 'Duration (min)', 'Steps Completed', 'Total Steps', 'Priority'],
		rows.map((r) => [
			r.id,
			r.procedure,
			r.version,
			r.workOrder,
			r.status,
			r.createdAt,
			r.startedAt,
			r.completedAt,
			r.startedAt && r.completedAt ? Math.round(minutes(r.startedAt, r.completedAt) * 10) / 10 : null,
			r.stepsCompleted,
			r.stepsTotal,
			r.priority
		])
	);
}

export function executionMetrics(ctx: Ctx, f: ExecutionReportFilter): ExecutionMetrics {
	const rows = executions(ctx, f);
	const n = (s: string) => rows.filter((r) => r.status === s).length;
	const durations = rows.filter((r) => r.startedAt && r.completedAt).map((r) => minutes(r.startedAt!, r.completedAt!));
	const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
	const completed = n('completed');
	return {
		totalExecutions: rows.length,
		completed,
		inWork: n('in_work'),
		cut: n('cut'),
		aborted: n('aborted'),
		avgDurationMinutes: avg ? Math.round(avg * 10) / 10 : null,
		completionRate: rows.length ? Math.round((completed / rows.length) * 1000) / 10 : 0
	};
}

// ---------------------------------------------------------------- issues

export interface IssueReportFilter {
	status?: string;
	issueType?: string;
	priority?: string;
	projectId?: number;
	from?: string;
	to?: string;
}

function issueRows(ctx: Ctx, f: IssueReportFilter) {
	const from = bound(f.from, 'from');
	const to = bound(f.to, 'to');
	return inProject(
		allPages((cursor) =>
			issues.list(ctx, {
				limit: 500,
				dir: 'desc',
				cursor,
				status: f.status as never,
				issueType: f.issueType as never,
				priority: f.priority as never
			})
		),
		f.projectId
	).filter((i) => inWindow(i.createdAt, from, to));
}

export function issuesCsv(ctx: Ctx, f: IssueReportFilter): string {
	const rows = issueRows(ctx, f).sort((a, b) => b.id - a.id);
	return toCsv(
		['Issue', 'Title', 'Type', 'Status', 'State', 'Priority', 'Containment', 'Description', 'Assigned To', 'Execution', 'Linked Parts', 'Created At', 'Updated At'],
		rows.map((i) => [
			i.issueNumber,
			i.title,
			i.issueType,
			i.status,
			i.ticketState,
			i.priority,
			i.containment,
			clip(i.description, 200),
			i.assignedTo?.name,
			i.execution?.label,
			i.links.filter((l) => l.kind === 'part').map((l) => l.label).join(', '),
			i.createdAt,
			i.updatedAt
		])
	);
}

export function issueMetrics(ctx: Ctx, f: IssueReportFilter): IssueMetrics {
	const rows = issueRows(ctx, f);
	const count = (pick: (i: (typeof rows)[number]) => string) => {
		const out: Record<string, number> = {};
		for (const i of rows) out[pick(i)] = (out[pick(i)] ?? 0) + 1;
		return out;
	};
	const disp = (s: string) => rows.filter((i) => i.dispState === s).length;
	return {
		totalIssues: rows.length,
		open: rows.filter((i) => i.status === 'open').length,
		advisoryOpen: disp('open'),
		undispositioned: disp('undispositioned'),
		dispositioned: disp('dispositioned'),
		closed: rows.filter((i) => i.status === 'closed').length,
		voided: rows.filter((i) => i.status === 'void').length,
		byType: count((i) => i.issueType),
		byPriority: count((i) => i.priority)
	};
}

// ---------------------------------------------------------------- risks

export function risksCsv(ctx: Ctx, f: { disposition?: string; minScore?: number; projectId?: number }): string {
	const rows = inProject(
		allPages((cursor) =>
			risks.list(ctx, {
				limit: 500,
				sort: 'riskNumber',
				dir: 'desc',
				cursor,
				disposition: f.disposition as never,
				minScore: f.minScore
			})
		),
		f.projectId
	);
	return toCsv(
		['Risk', 'Title', 'Disposition', 'Probability', 'Impact', 'Score', 'Severity', 'Residual Probability', 'Residual Impact', 'Residual Score', 'Owner', 'Statement', 'Narrative', 'Last Reviewed At', 'Created At'],
		rows.map((r) => [
			r.riskNumber,
			r.title,
			r.disposition,
			r.probability,
			r.impact,
			r.score,
			r.severity,
			r.residualProbability,
			r.residualImpact,
			r.residualScore,
			r.ownerName,
			r.statement,
			clip(r.description, 200),
			r.lastReviewedAt,
			r.createdAt
		])
	);
}
