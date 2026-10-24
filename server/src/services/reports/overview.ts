/**
 * The overview page. Every list is a section registered by name. Areas that own the data
 * register their own section (the execution area registers `executions`); this file registers
 * the rest by calling the owning areas' queries, never their tables.
 *
 * A section that nobody registered renders as an empty list.
 */
import {
	OVERVIEW_HIGH_RISK_SCORE,
	OVERVIEW_LIST_CAP as CAP,
	type Overview,
	type OverviewSections,
	parseQty
} from '@opal/shared';
import { desc } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { auditLog } from '../../db/schema/index.ts';
import { calibrationReport, expiringStock, lowStockParts } from '../inventory/index.ts';
import * as issues from '../issues/service.ts';
import { auditEntries } from '../platform/audit.ts';
import { listPurchases } from '../purchasing/orders.ts';
import * as risks from '../risks/service.ts';

export interface OverviewOptions {
	/** Show one project only. Absent means every project. */
	projectId?: number;
}

export type OverviewSection<K extends OverviewSections> = (ctx: Ctx, opts: OverviewOptions) => Overview[K];

/**
 * Keep rows of one project. Rows from an area that has no project column yet pass through;
 * organization-wide sections (stock, purchasing) never call this.
 */
export function inProject<T>(rows: T[], projectId: number | undefined): T[] {
	if (projectId === undefined) return rows;
	return rows.filter((r) => {
		const p = (r as { projectId?: number | null }).projectId;
		return p === undefined || p === projectId;
	});
}

const registry = new Map<OverviewSections, OverviewSection<never>>();

/** Add or replace a section. The execution area calls this with `executions`. */
export function registerOverviewSection<K extends OverviewSections>(
	name: K,
	fn: OverviewSection<K>
): void {
	registry.set(name, fn as OverviewSection<never>);
}

const emptyCapped = { items: [], total: 0, flagged: 0 };
const EMPTY: Overview = {
	issues: { ...emptyCapped, counts: { open: 0, critical: 0, high: 0, medium: 0, low: 0, unassigned: 0, mine: 0 } },
	executions: emptyCapped,
	lowStock: emptyCapped,
	purchases: emptyCapped,
	stockAttention: emptyCapped,
	risks: emptyCapped,
	activity: []
};

export function buildOverview(ctx: Ctx, opts: OverviewOptions = {}): Overview {
	const out = { ...EMPTY } as Record<string, unknown>;
	for (const [name, fn] of registry) out[name] = (fn as OverviewSection<OverviewSections>)(ctx, opts);
	return out as unknown as Overview;
}

/** Every row of a paged service list. */
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

// ---------------------------------------------------------------- issues

const PRIORITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

registerOverviewSection('issues', (ctx, { projectId }) => {
	const me = actorUserId(ctx.actor);
	const open = inProject(
		allPages((cursor) => issues.list(ctx, { status: 'open', limit: 500, dir: 'desc', cursor })),
		projectId
	).sort((a, b) => b.id - a.id);
	const by = (p: string) => open.filter((i) => i.priority === p).length;
	const counts = {
		open: open.length,
		critical: by('critical'),
		high: by('high'),
		medium: by('medium'),
		low: by('low'),
		unassigned: open.filter((i) => i.assignedTo === null).length,
		mine: open.filter((i) => me !== null && i.assignedTo?.id === me).length
	};
	// Mine first, then urgency, then newest (the list is newest first and the sort is stable).
	const mine = (i: (typeof open)[number]) => me !== null && i.assignedTo?.id === me;
	open.sort((a, b) => Number(mine(b)) - Number(mine(a)) || PRIORITY_RANK[b.priority]! - PRIORITY_RANK[a.priority]!);
	return {
		items: open.slice(0, CAP).map((i) => ({
			issueNumber: i.issueNumber,
			title: i.title,
			priority: i.priority,
			issueType: i.issueType,
			holding: i.isBlocking,
			assignee: i.assignedTo?.name ?? null,
			mine: mine(i),
			href: `/issues/${i.id}`
		})),
		total: open.length,
		flagged: 0,
		counts
	};
});

// ---------------------------------------------------------------- low stock

registerOverviewSection('lowStock', (ctx) => {
	// Furthest below the reorder point first.
	const rows = lowStockParts(ctx)
		.map((p) => ({ p, gap: parseQty(p.onHand) - parseQty(p.reorderPoint) }))
		.sort((a, b) => a.gap - b.gap || a.p.partId - b.p.partId);
	return {
		items: rows.slice(0, CAP).map(({ p }) => ({
			partNumber: p.internalPn,
			name: p.name,
			onHand: p.onHand,
			reorderPoint: p.reorderPoint,
			uom: p.unitOfMeasure,
			href: `/parts/${p.partId}`
		})),
		total: rows.length,
		flagged: 0
	};
});

// ---------------------------------------------------------------- purchases

registerOverviewSection('purchases', (ctx) => {
	const rows = allPages((cursor) =>
		listPurchases(ctx, { awaiting: true, limit: 500, sort: 'targetDate', dir: 'asc', cursor })
	).sort(
		(a, b) =>
			Number(a.targetDate === null) - Number(b.targetDate === null) ||
			(a.targetDate ?? '').localeCompare(b.targetDate ?? '') ||
			a.id - b.id
	);
	return {
		items: rows.slice(0, CAP).map((p) => ({
			reference: p.reference,
			supplier: p.supplierName,
			status: p.status,
			targetDate: p.targetDate,
			overdue: p.isOverdue,
			linesOpen: p.totalLines - p.linesComplete,
			href: `/purchases/${p.id}`
		})),
		total: rows.length,
		flagged: rows.filter((p) => p.isOverdue).length
	};
});

// ---------------------------------------------------------------- calibration and expiry

registerOverviewSection('stockAttention', (ctx) => {
	const today = new Date().toISOString().slice(0, 10);
	const href = (r: { opalNumber: string }) => `/inventory/opal/${r.opalNumber}`;
	const row = (
		r: ReturnType<typeof expiringStock>[number],
		kind: 'calibration_overdue' | 'expired' | 'expiring',
		due: string
	) => ({
		opalNumber: r.opalNumber,
		partNumber: r.partInternalPn,
		partName: r.partName,
		kind,
		due,
		href: href(r)
	});
	const rows = [
		...calibrationReport(ctx).overdue.map((r) => row(r, 'calibration_overdue', r.calibrationDueAt!)),
		...expiringStock(ctx).map((r) =>
			row(r, r.expirationDate! < today ? 'expired' : 'expiring', r.expirationDate!)
		)
	];
	return {
		items: rows.slice(0, CAP),
		total: rows.length,
		flagged: rows.filter((r) => r.kind !== 'expiring').length
	};
});

// ---------------------------------------------------------------- risks

registerOverviewSection('risks', (ctx, { projectId }) => {
	// Live exposure above the "high" score, worst first.
	const all = inProject(
		allPages((cursor) =>
			risks.list(ctx, {
				active: true,
				minScore: OVERVIEW_HIGH_RISK_SCORE + 1,
				sort: 'score',
				dir: 'desc',
				limit: 500,
				cursor
			})
		),
		projectId
	);
	return {
		items: all.slice(0, CAP).map((r) => ({
			riskNumber: r.riskNumber,
			title: r.title,
			score: r.score,
			disposition: r.disposition,
			href: `/risks/${r.id}`
		})),
		total: all.length,
		flagged: 0
	};
});

// ---------------------------------------------------------------- activity

registerOverviewSection('activity', (ctx) =>
	auditEntries(ctx.db, ctx.db.select().from(auditLog).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(15).all())
);
