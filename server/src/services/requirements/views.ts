/**
 * Read models for the requirements screens: tree, dossier, queue, baseline events, summary.
 * Pure queries and shaping, no writes. The client never re-derives these facts.
 *
 * Part links point at a specific revision row. A revision chain shares one req_number, so every
 * view groups links by number: a requirement's parts survive a revise, and a link made against
 * an older revision is reported as such (`againstRevision`) instead of vanishing.
 */
import type {
	RequirementAllocation as Allocation,
	RequirementAllocationStatus,
	RequirementDossier,
	RequirementEventDetail,
	RequirementEventSummary,
	RequirementFinding,
	RequirementQueueItem,
	RequirementRedline,
	RequirementSummary,
	RequirementTree,
	RequirementVerificationStatus
} from '@opal/shared';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import {
	baselineEvent,
	baselineEventItem,
	part,
	partRequirement,
	requirement,
	user
} from '../../db/schema/index.ts';
import { projectRefs } from '../org/projects.ts'; // added by projects
import { EDITABLE, isMutable, type RequirementRow } from './lifecycle.ts';
import { lintRow } from './lint.ts';
import { readiness, readyRows } from './readiness.ts';
import { redlineSegments } from './redline.ts';

const LIVE = ['draft', 'preliminary', 'baselined'] as const;
const SATISFIED: RequirementAllocationStatus[] = ['verified', 'waived'];
const DAY = 86_400_000;

// ---- verification roll-up ----

export const isOutdated = (a: Pick<Allocation, 'status' | 'againstRevision'>, revision: number) =>
	SATISFIED.includes(a.status) && a.againstRevision < revision;

/**
 * Roll link statuses into one word for a revision. A verification closed against an older
 * revision does not verify this one.
 */
export function verificationStatus(
	allocations: Pick<Allocation, 'status' | 'againstRevision'>[],
	revision: number
): RequirementVerificationStatus {
	if (!allocations.length) return 'unallocated';
	const applicable = allocations.filter((a) => a.status !== 'not_applicable');
	if (!applicable.length) return 'not_applicable';
	const done = applicable.filter((a) => SATISFIED.includes(a.status) && !isOutdated(a, revision)).length;
	if (done === applicable.length) return 'verified';
	return done ? 'partial' : 'open';
}

/** Every link of a requirement, keyed by req_number. */
export function allocationsByNumber(ctx: Pick<Ctx, 'db'>): Map<string, Allocation[]> {
	const rows = ctx.db
		.select({ pr: partRequirement, part, req: requirement, verifier: user.name })
		.from(partRequirement)
		.innerJoin(part, eq(part.id, partRequirement.partId))
		.innerJoin(requirement, eq(requirement.id, partRequirement.requirementId))
		.leftJoin(user, eq(user.id, partRequirement.verifiedById))
		.orderBy(asc(part.name), asc(partRequirement.id))
		.all();
	const out = new Map<string, Allocation[]>();
	for (const { pr, part: p, req, verifier } of rows) {
		const list = out.get(req.reqNumber) ?? [];
		list.push({
			id: pr.id,
			partId: p.id,
			partName: p.name,
			internalPn: p.internalPn,
			status: pr.status,
			notes: pr.notes,
			verifiedAt: pr.verifiedAt,
			verifiedBy: verifier,
			againstRevision: req.revision,
			outdated: false
		});
		out.set(req.reqNumber, list);
	}
	return out;
}

function liveRows(ctx: Pick<Ctx, 'db'>, projectId?: number): RequirementRow[] {
	return ctx.db
		.select()
		.from(requirement)
		.where(
			and(
				ne(requirement.lifecycleState, 'superseded'),
				projectId !== undefined ? eq(requirement.projectId, projectId) : undefined // added by projects
			)
		)
		.orderBy(asc(requirement.reqNumber), asc(requirement.revision))
		.all();
}

const get = (ctx: Pick<Ctx, 'db'>, id: number) =>
	ctx.db.select().from(requirement).where(eq(requirement.id, id)).get();

// ---- tree ----

export function tree(ctx: Ctx, projectId?: number): RequirementTree {
	const rows = liveRows(ctx, projectId);
	const ids = new Set(rows.map((r) => r.id));
	const alloc = allocationsByNumber(ctx);
	const projects = projectRefs(ctx.db, rows.map((r) => r.projectId)); // added by projects
	const items = rows.map((r) => {
		const allocations = alloc.get(r.reqNumber) ?? [];
		return {
			id: r.id,
			reqNumber: r.reqNumber,
			projectId: r.projectId, // added by projects
			projectCode: projects.get(r.projectId)?.code ?? '', // added by projects
			revision: r.revision,
			lifecycleState: r.lifecycleState,
			title: r.title,
			statement: r.statement,
			rationale: r.rationale,
			level: r.level,
			category: r.category,
			verificationMethod: r.verificationMethod,
			tbd: r.tbd,
			tbr: r.tbr,
			stale: r.stale,
			parentId: r.parentId !== null && ids.has(r.parentId) ? r.parentId : null,
			orphan: r.parentId !== null && !ids.has(r.parentId),
			updatedAt: r.updatedAt,
			lint: isMutable(r) ? lintRow(r) : [],
			parts: allocations.map((a) => ({ partId: a.partId, name: a.partName, status: a.status })),
			verification: verificationStatus(allocations, r.revision)
		};
	});
	return { items, total: items.length, queueCount: readyRows(ctx, projectId).length };
}

// ---- dossier ----

export function dossier(ctx: Ctx, r: RequirementRow): RequirementDossier {
	const chain: RequirementRow[] = [];
	const seen = new Set([r.id]);
	let cursor = r.parentId !== null ? get(ctx, r.parentId) : undefined;
	while (cursor && !seen.has(cursor.id)) {
		chain.push(cursor);
		seen.add(cursor.id);
		cursor = cursor.parentId !== null ? get(ctx, cursor.parentId) : undefined;
	}
	const children = ctx.db
		.select()
		.from(requirement)
		.where(and(eq(requirement.parentId, r.id), ne(requirement.lifecycleState, 'superseded')))
		.orderBy(asc(requirement.reqNumber))
		.all();
	const revisions = ctx.db
		.select()
		.from(requirement)
		.where(eq(requirement.reqNumber, r.reqNumber))
		.orderBy(asc(requirement.revision))
		.all();
	const own = (allocationsByNumber(ctx).get(r.reqNumber) ?? []).map((a) => ({
		...a,
		outdated: isOutdated(a, r.revision)
	}));
	const userName = (id: number | null) =>
		id === null
			? null
			: (ctx.db.select({ name: user.name }).from(user).where(eq(user.id, id)).get()?.name ?? null);
	const predecessor = r.supersedesId !== null ? get(ctx, r.supersedesId) : undefined;
	const byRevision = new Map(revisions.map((x) => [x.id, x.revision]));
	const events = revisions.length
		? ctx.db
				.select({ item: baselineEventItem, event: baselineEvent })
				.from(baselineEventItem)
				.innerJoin(baselineEvent, eq(baselineEvent.id, baselineEventItem.eventId))
				.where(
					inArray(
						baselineEventItem.requirementId,
						revisions.map((x) => x.id)
					)
				)
				.orderBy(asc(baselineEventItem.id))
				.all()
		: [];
	const mutable = isMutable(r);
	const project = projectRefs(ctx.db, [r.projectId]).get(r.projectId); // added by projects
	return {
		id: r.id,
		reqNumber: r.reqNumber,
		projectId: r.projectId, // added by projects
		projectCode: project?.code ?? '', // added by projects
		projectName: project?.name ?? '', // added by projects
		revision: r.revision,
		lifecycleState: r.lifecycleState,
		title: r.title,
		statement: r.statement,
		rationale: r.rationale,
		category: r.category,
		level: r.level,
		parentId: r.parentId,
		verificationMethod: r.verificationMethod,
		tbd: r.tbd,
		tbr: r.tbr,
		tbrOwnerId: r.tbrOwnerId,
		tbrOwner: userName(r.tbrOwnerId),
		tbrDue: r.tbrDue,
		stale: r.stale,
		baselinedAt: r.baselinedAt,
		baselinedBy: userName(r.baselinedById),
		supersedesId: r.supersedesId,
		predecessorRevision: predecessor?.revision ?? null,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		parentChain: chain.reverse().map((p) => ({ id: p.id, reqNumber: p.reqNumber, title: p.title })),
		children: children.map((c) => ({
			id: c.id,
			reqNumber: c.reqNumber,
			title: c.title,
			lifecycleState: c.lifecycleState,
			level: c.level,
			stale: c.stale
		})),
		allocations: own,
		verification: verificationStatus(own, r.revision),
		revisions: revisions.map((x) => ({
			id: x.id,
			revision: x.revision,
			lifecycleState: x.lifecycleState,
			statement: x.statement,
			baselinedAt: x.baselinedAt
		})),
		baselineEvents: events.map(({ item, event }) => ({
			eventId: event.id,
			label: event.label,
			createdAt: event.createdAt,
			revision: byRevision.get(item.requirementId) ?? r.revision
		})),
		readiness: mutable ? readiness(ctx, r) : null,
		lint: mutable ? lintRow(r) : [],
		canDelete: mutable && !children.length && !own.length
	};
}

// ---- redline ----

export function redline(old: RequirementRow, next: RequirementRow): RequirementRedline {
	return {
		revA: old.revision,
		revB: next.revision,
		title: redlineSegments(old.title, next.title),
		statement: redlineSegments(old.statement, next.statement),
		rationale: redlineSegments(old.rationale ?? '', next.rationale ?? '')
	};
}

// ---- queue ----

/** The ready set with the context a reviewer needs on one screen. */
export function queueItems(ctx: Ctx, projectId?: number): RequirementQueueItem[] {
	const rows = readyRows(ctx, projectId);
	if (!rows.length) return [];
	const all = ctx.db.select().from(requirement).all();
	const byId = new Map(all.map((r) => [r.id, r]));
	const alloc = allocationsByNumber(ctx);
	const chainOf = (r: RequirementRow) => {
		const out: RequirementQueueItem['chain'] = [];
		const seen = new Set([r.id]);
		let cursor = r.parentId !== null ? byId.get(r.parentId) : undefined;
		while (cursor && !seen.has(cursor.id)) {
			out.push({
				id: cursor.id,
				reqNumber: cursor.reqNumber,
				title: cursor.title,
				lifecycleState: cursor.lifecycleState
			});
			seen.add(cursor.id);
			cursor = cursor.parentId !== null ? byId.get(cursor.parentId) : undefined;
		}
		return out.reverse();
	};
	return rows.map((r) => {
		const predecessor = r.supersedesId !== null ? byId.get(r.supersedesId) : undefined;
		return {
			id: r.id,
			projectId: r.projectId, // added by projects
			reqNumber: r.reqNumber,
			revision: r.revision,
			title: r.title,
			statement: r.statement,
			rationale: r.rationale,
			level: r.level,
			verificationMethod: r.verificationMethod,
			stale: r.stale,
			childrenCount: all.filter((c) => c.parentId === r.id).length,
			parts: (alloc.get(r.reqNumber) ?? []).map((a) => a.partName),
			chain: chainOf(r),
			warnings: readiness(ctx, r)
				.checks.filter((c) => c.severity === 'warning' && !c.passed && c.detail)
				.map((c) => c.detail!),
			change: predecessor ? redline(predecessor, r) : null
		};
	});
}

// ---- baseline events ----

export function eventSummaries(ctx: Ctx, eventId?: number, projectId?: number): RequirementEventSummary[] {
	const events = ctx.db
		.select({ e: baselineEvent, signer: user.name })
		.from(baselineEvent)
		.leftJoin(user, eq(user.id, baselineEvent.signedById))
		.where(
			and(
				eventId === undefined ? undefined : eq(baselineEvent.id, eventId),
				projectId === undefined ? undefined : eq(baselineEvent.projectId, projectId) // added by projects
			)
		)
		.orderBy(desc(baselineEvent.createdAt), desc(baselineEvent.id))
		.all();
	if (!events.length) return [];
	const items = ctx.db
		.select({ eventId: baselineEventItem.eventId, supersedesId: requirement.supersedesId })
		.from(baselineEventItem)
		.innerJoin(requirement, eq(requirement.id, baselineEventItem.requirementId))
		.where(inArray(baselineEventItem.eventId, events.map((x) => x.e.id)))
		.all();
	const projects = projectRefs(ctx.db, events.map((x) => x.e.projectId)); // added by projects
	return events.map(({ e, signer }) => {
		const mine = items.filter((i) => i.eventId === e.id);
		return {
			id: e.id,
			projectId: e.projectId, // added by projects
			projectCode: projects.get(e.projectId)?.code ?? '', // added by projects
			projectName: projects.get(e.projectId)?.name ?? '', // added by projects
			label: e.label,
			note: e.note,
			signedBy: signer,
			createdAt: e.createdAt,
			locked: mine.length,
			revised: mine.filter((i) => i.supersedesId !== null).length
		};
	});
}

/** The locked set, each item with what it changed against its predecessor. */
export function eventDetail(ctx: Ctx, summary: RequirementEventSummary): RequirementEventDetail {
	const rows = ctx.db
		.select({ r: requirement })
		.from(baselineEventItem)
		.innerJoin(requirement, eq(requirement.id, baselineEventItem.requirementId))
		.where(eq(baselineEventItem.eventId, summary.id))
		.orderBy(asc(requirement.reqNumber))
		.all();
	const items = rows.map(({ r }) => {
		const prev = r.supersedesId !== null ? get(ctx, r.supersedesId) : undefined;
		const changed: string[] = [];
		if (prev) {
			for (const f of ['title', 'statement', 'rationale', 'category', 'level'] as const) {
				if ((prev[f] ?? '') !== (r[f] ?? '')) changed.push(f);
			}
			if (prev.verificationMethod !== r.verificationMethod) changed.push('verification_method');
			if (prev.parentId !== r.parentId) changed.push('parent');
		}
		return {
			id: r.id,
			reqNumber: r.reqNumber,
			revision: r.revision,
			title: r.title,
			statement: r.statement,
			lifecycleState: r.lifecycleState,
			previousRevision: prev?.revision ?? null,
			changed,
			diff: prev ? redline(prev, r) : null
		};
	});
	return { ...summary, items };
}

// ---- dashboard ----

const withOwner = (ctx: Pick<Ctx, 'db'>, id: number | null) =>
	id === null
		? '(no owner)'
		: (ctx.db.select({ name: user.name }).from(user).where(eq(user.id, id)).get()?.name ?? '(no owner)');

/** Live requirements whose TBR closure date has passed. */
export function overdueTbrs(ctx: Pick<Ctx, 'db'>, at = Date.now(), projectId?: number) {
	return ctx.db
		.select()
		.from(requirement)
		.where(
			and(
				inArray(requirement.lifecycleState, [...LIVE]),
				eq(requirement.tbr, true),
				projectId !== undefined ? eq(requirement.projectId, projectId) : undefined // added by projects
			)
		)
		.orderBy(asc(requirement.tbrDue))
		.all()
		.filter((r) => r.tbrDue !== null && new Date(r.tbrDue).getTime() < at)
		.map((r) => ({
			req: r,
			owner: withOwner(ctx, r.tbrOwnerId),
			daysOver: Math.floor((at - new Date(r.tbrDue!).getTime()) / DAY)
		}));
}

export function staleRequirements(ctx: Pick<Ctx, 'db'>, projectId?: number): RequirementRow[] {
	return ctx.db
		.select()
		.from(requirement)
		.where(
			and(
				inArray(requirement.lifecycleState, [...LIVE]),
				eq(requirement.stale, true),
				projectId !== undefined ? eq(requirement.projectId, projectId) : undefined // added by projects
			)
		)
		.orderBy(asc(requirement.reqNumber))
		.all();
}

/** Drafts older than the window that still carry block-severity lint. */
export function oldBlockLintDrafts(ctx: Pick<Ctx, 'db'>, olderThanDays = 7, at = Date.now(), projectId?: number) {
	const cutoff = at - olderThanDays * DAY;
	return ctx.db
		.select()
		.from(requirement)
		.where(
			and(
				inArray(requirement.lifecycleState, [...EDITABLE]),
				projectId !== undefined ? eq(requirement.projectId, projectId) : undefined // added by projects
			)
		)
		.orderBy(asc(requirement.reqNumber))
		.all()
		.filter(
			(r) =>
				new Date(r.createdAt).getTime() <= cutoff &&
				lintRow(r).some((f: RequirementFinding) => f.severity === 'block_baseline')
		);
}

/** Coverage, verification, staleness, and what is red. */
export function summary(ctx: Ctx, projectId?: number): RequirementSummary {
	const all = liveRows(ctx, projectId);
	const rows = all.filter((r) => (LIVE as readonly string[]).includes(r.lifecycleState));
	const alloc = allocationsByNumber(ctx);
	const byState: Record<string, number> = {};
	for (const r of all) byState[r.lifecycleState] = (byState[r.lifecycleState] ?? 0) + 1;

	const parents = new Set(rows.map((r) => r.parentId).filter((x): x is number => x !== null));
	const verification: Record<RequirementVerificationStatus, number> = {
		verified: 0,
		partial: 0,
		open: 0,
		unallocated: 0,
		not_applicable: 0
	};
	for (const r of rows) verification[verificationStatus(alloc.get(r.reqNumber) ?? [], r.revision)]++;

	const ref = (r: RequirementRow) => ({ id: r.id, reqNumber: r.reqNumber, title: r.title });
	const leaves = rows.filter((r) => !parents.has(r.id));
	return {
		total: rows.length,
		byState,
		coverage: {
			leaves: leaves.length,
			leavesAllocated: leaves.filter((r) => (alloc.get(r.reqNumber) ?? []).length).length,
			withVerificationMethod: rows.filter((r) => r.verificationMethod).length
		},
		verification,
		readyToBaseline: readyRows(ctx, projectId).length,
		stale: staleRequirements(ctx, projectId).map(ref),
		overdueTbrs: overdueTbrs(ctx, Date.now(), projectId).map((o) => ({
			...ref(o.req),
			owner: o.owner,
			daysOver: o.daysOver,
			tbrDue: o.req.tbrDue!
		})),
		stuckDrafts: oldBlockLintDrafts(ctx, 7, Date.now(), projectId).map(ref),
		asOf: new Date().toISOString()
	};
}
