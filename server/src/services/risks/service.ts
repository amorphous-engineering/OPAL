/** Risk records: hydration, create, update, delete, list, matrix, history, review stamp. */
import {
	OpalError,
	RISK_IMPACT_LABELS,
	RISK_LIVE_DISPOSITIONS,
	RISK_PROBABILITY_LABELS,
	RISK_SIGNATURE_FIELDS,
	type Risk,
	type RiskFilters,
	type RiskHistoryRow,
	type RiskMatrix,
	conflict,
	notFound,
	now,
	type zRiskCreate,
	type zRiskUpdate
} from '@opal/shared';
import { type SQL, and, asc, count, desc, eq, gte, inArray, like, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { actorUserId, type Ctx } from '../../context.ts';
import {
	auditLog,
	issue,
	issueLink,
	part,
	risk,
	riskReference,
	user
} from '../../db/schema/index.ts';
import { insert, remove, update as writeUpdate } from '../../write.ts';
import { nextDesignator } from '../designators.ts';
import { projectRefs, requireActiveProject } from '../org/projects.ts'; // added by projects
import {
	type RiskRow,
	blank,
	residualScore,
	score,
	severity,
	statement
} from './scenario.ts';

const invalid = (field: string, message: string) =>
	new OpalError(422, 'invalid_input', message, { [field]: message });

// ---- loading ----

export function load(ctx: Ctx, id: number): RiskRow {
	const row = ctx.db.select().from(risk).where(eq(risk.id, id)).get();
	if (!row) throw notFound('Risk');
	return row;
}

/** The API shape of risks, with names, links and references resolved in a few queries. */
export function hydrate(ctx: Ctx, rows: RiskRow[], invalidated = new Set<number>()): Risk[] {
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const userIds = new Set<number>();
	const partIds = new Set<number>();
	const issueIds = new Set<number>();
	for (const r of rows) {
		for (const u of [r.ownerId, r.acceptedById, r.lastReviewedById]) if (u !== null) userIds.add(u);
		if (r.assetPartId !== null) partIds.add(r.assetPartId);
		if (r.realizedIssueId !== null) issueIds.add(r.realizedIssueId);
	}
	const users = new Map(
		userIds.size
			? ctx.db
					.select({ id: user.id, name: user.name })
					.from(user)
					.where(inArray(user.id, [...userIds]))
					.all()
					.map((u) => [u.id, u.name] as const)
			: []
	);
	const parts = new Map(
		partIds.size
			? ctx.db
					.select({ id: part.id, pn: part.internalPn, name: part.name })
					.from(part)
					.where(inArray(part.id, [...partIds]))
					.all()
					.map((p) => [p.id, p] as const)
			: []
	);
	const links = ctx.db
		.select({ link: issueLink, issue })
		.from(issueLink)
		.innerJoin(issue, eq(issue.id, issueLink.issueId))
		.where(inArray(issueLink.riskId, ids))
		.orderBy(asc(issueLink.id))
		.all();
	for (const l of links) issueIds.add(l.issue.id);
	const realized = new Map(
		issueIds.size
			? ctx.db
					.select({ id: issue.id, number: issue.issueNumber })
					.from(issue)
					.where(inArray(issue.id, [...issueIds]))
					.all()
					.map((i) => [i.id, i.number] as const)
			: []
	);
	const projects = projectRefs(ctx.db, rows.map((r) => r.projectId)); // added by projects
	const refs = ctx.db
		.select()
		.from(riskReference)
		.where(inArray(riskReference.riskId, ids))
		.orderBy(asc(riskReference.id))
		.all();

	return rows.map((r) => {
		const p = r.assetPartId === null ? null : (parts.get(r.assetPartId) ?? null);
		const assetDisplay = p ? (p.pn ? `${p.name} (${p.pn})` : p.name) : r.assetText;
		const s = score(r);
		const rs = residualScore(r);
		return {
			id: r.id,
			riskNumber: r.riskNumber,
			projectId: r.projectId, // added by projects
			projectCode: projects.get(r.projectId)?.code ?? '', // added by projects
			projectName: projects.get(r.projectId)?.name ?? '', // added by projects
			title: r.title,
			description: r.description,
			condition: r.condition,
			departure: r.departure,
			assetPartId: r.assetPartId,
			assetText: r.assetText,
			consequence: r.consequence,
			assetDisplay,
			assetPartNumber: p?.pn ?? null,
			assetPartName: p?.name ?? null,
			statement: statement(r, assetDisplay),
			disposition: r.disposition,
			ownerId: r.ownerId,
			ownerName: r.ownerId === null ? null : (users.get(r.ownerId) ?? null),
			probability: r.probability,
			impact: r.impact,
			score: s,
			severity: severity(s),
			residualProbability: r.residualProbability,
			residualImpact: r.residualImpact,
			residualScore: rs,
			residualSeverity: rs === null ? null : severity(rs),
			acceptedById: r.acceptedById,
			acceptedByName: r.acceptedById === null ? null : (users.get(r.acceptedById) ?? null),
			acceptedAt: r.acceptedAt,
			acceptanceRationale: r.acceptanceRationale,
			watchObservable: r.watchObservable,
			watchThreshold: r.watchThreshold,
			watchContingency: r.watchContingency,
			lastReviewedAt: r.lastReviewedAt,
			lastReviewedById: r.lastReviewedById,
			lastReviewedByName:
				r.lastReviewedById === null ? null : (users.get(r.lastReviewedById) ?? null),
			realizedIssueId: r.realizedIssueId,
			realizedIssueNumber: r.realizedIssueId === null ? null : (realized.get(r.realizedIssueId) ?? null),
			linkedIssues: links
				.filter((l) => l.link.riskId === r.id)
				.map((l) => ({
					linkId: l.link.id,
					issueId: l.issue.id,
					issueNumber: l.issue.issueNumber,
					title: l.issue.title,
					status: l.issue.status,
					role: l.link.riskRole!
				})),
			references: refs
				.filter((x) => x.riskId === r.id)
				.map((x) => ({
					id: x.id,
					type: x.referenceType,
					value: x.referenceValue,
					notes: x.notes
				})),
			acceptanceInvalidated: invalidated.has(r.id),
			createdAt: r.createdAt,
			updatedAt: r.updatedAt
		};
	});
}

export const one = (ctx: Ctx, id: number, invalidated = new Set<number>()): Risk =>
	hydrate(ctx, [load(ctx, id)], invalidated)[0]!;

export const get = (ctx: Ctx, id: number): Risk => one(ctx, id);

// ---- validation ----

function checkRefs(ctx: Ctx, v: { ownerId?: number | null; assetPartId?: number | null }) {
	if (v.ownerId != null && !ctx.db.select({ id: user.id }).from(user).where(eq(user.id, v.ownerId)).get())
		throw notFound('Owner');
	if (v.assetPartId != null && !ctx.db.select({ id: part.id }).from(part).where(eq(part.id, v.assetPartId)).get())
		throw notFound('Asset part');
}

const EXCLUSIVE = 'assetPartId and assetText are exclusive: exactly one names the asset';

// ---- create ----

/** Blank text is "not set", never an empty string. */
const norm = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v);

export function create(ctx: Ctx, input: z.output<typeof zRiskCreate>): Risk {
	const assetText = norm(input.assetText);
	const assetPartId = input.assetPartId ?? null;
	if (assetPartId !== null && assetText !== null) throw invalid('assetText', EXCLUSIVE);
	checkRefs(ctx, { ownerId: input.ownerId, assetPartId });
	requireActiveProject(ctx.db, input.projectId); // added by projects
	const row = insert(ctx, risk, {
		riskNumber: nextDesignator(ctx, 'RISK'),
		projectId: input.projectId, // added by projects
		title: input.title,
		description: norm(input.description),
		condition: norm(input.condition),
		departure: norm(input.departure),
		assetPartId,
		assetText,
		consequence: norm(input.consequence),
		disposition: 'open',
		ownerId: input.ownerId ?? null,
		probability: input.probability,
		impact: input.impact,
		residualProbability: input.residualProbability ?? null,
		residualImpact: input.residualImpact ?? null,
		watchObservable: norm(input.watchObservable),
		watchThreshold: norm(input.watchThreshold),
		watchContingency: norm(input.watchContingency)
	});
	return one(ctx, row.id);
}

// ---- update ----

const TEXT_FIELDS = [
	'description',
	'condition',
	'departure',
	'assetText',
	'consequence',
	'acceptanceRationale',
	'watchObservable',
	'watchThreshold',
	'watchContingency'
] as const;
const PLAIN_FIELDS = [
	'ownerId',
	'assetPartId',
	'probability',
	'impact',
	'residualProbability',
	'residualImpact'
] as const;

export function updateRisk(ctx: Ctx, input: z.output<typeof zRiskUpdate>): Risk {
	const row = load(ctx, input.id);
	const patch: Partial<typeof risk.$inferInsert> = {};
	if (input.title !== undefined) patch.title = input.title;
	if (input.projectId !== undefined && input.projectId !== row.projectId) { // added by projects
		requireActiveProject(ctx.db, input.projectId);
		patch.projectId = input.projectId;
	}
	for (const k of TEXT_FIELDS) if (input[k] !== undefined) patch[k] = norm(input[k]);
	for (const k of PLAIN_FIELDS) if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];

	if (
		'acceptanceRationale' in patch &&
		row.disposition === 'accepted' &&
		patch.acceptanceRationale !== row.acceptanceRationale
	) {
		throw conflict(
			'rationale_signed',
			'The rationale is part of the signature. Un-accept the risk, with a note, to rewrite it'
		);
	}
	checkRefs(ctx, patch);
	// Setting one asset form clears the other: exactly one names the asset.
	if (patch.assetPartId != null && !('assetText' in patch)) patch.assetText = null;
	if (patch.assetText != null && !('assetPartId' in patch)) patch.assetPartId = null;
	const merged = { ...row, ...patch };
	if (merged.assetPartId !== null && merged.assetText !== null) throw invalid('assetText', EXCLUSIVE);

	// The signature covers the risk as scored: a change to it withdraws the acceptance.
	let invalidated = false;
	if (row.disposition === 'accepted') {
		const changed = RISK_SIGNATURE_FIELDS.filter((f) => row[f] !== merged[f]);
		if (changed.length) {
			patch.disposition = 'open';
			patch.dispositionNote = `Re-dispositioned: scenario changed after acceptance (${changed.join(', ')})`;
			invalidated = true;
		}
	}
	if (Object.keys(patch).length) writeUpdate(ctx, risk, row.id, patch);
	return one(ctx, row.id, new Set(invalidated ? [row.id] : []));
}

// ---- delete ----

export function deleteRisk(ctx: Ctx, id: number): { ok: true } {
	const row = load(ctx, id);
	if (row.acceptedAt !== null || row.disposition === 'realized' || row.realizedIssueId !== null) {
		throw conflict(
			'risk_state',
			'A risk that was accepted or realized stays in the register. Close it instead'
		);
	}
	remove(ctx, risk, id);
	return { ok: true };
}

// ---- list ----

const scoreSql = sql`(${risk.probability} * ${risk.impact})`;
const residualSql = sql`(CASE WHEN ${risk.residualProbability} IS NOT NULL AND ${risk.residualImpact} IS NOT NULL THEN ${risk.residualProbability} * ${risk.residualImpact} END)`;

export function where(f: RiskFilters): SQL | undefined {
	const q = f.q?.trim();
	return and(
		q ? or(like(risk.title, `%${q}%`), like(risk.riskNumber, `%${q}%`)) : undefined,
		f.projectId !== undefined ? eq(risk.projectId, f.projectId) : undefined, // added by projects
		f.disposition ? eq(risk.disposition, f.disposition) : undefined,
		f.severity === 'low' ? lte(scoreSql, 5) : undefined,
		f.severity === 'medium' ? and(gte(scoreSql, 6), lte(scoreSql, 12)) : undefined,
		f.severity === 'high' ? gte(scoreSql, 13) : undefined,
		f.minScore ? gte(scoreSql, f.minScore) : undefined,
		f.ownerId !== undefined ? eq(risk.ownerId, f.ownerId) : undefined,
		f.probability !== undefined ? eq(risk.probability, f.probability) : undefined,
		f.impact !== undefined ? eq(risk.impact, f.impact) : undefined,
		f.residualProbability !== undefined
			? eq(risk.residualProbability, f.residualProbability)
			: undefined,
		f.residualImpact !== undefined ? eq(risk.residualImpact, f.residualImpact) : undefined,
		// The same set the matrix counts: live exposure only.
		f.active ? inArray(risk.disposition, [...RISK_LIVE_DISPOSITIONS]) : undefined
	);
}

const SORTS = {
	riskNumber: sql`${risk.riskNumber}`,
	title: sql`lower(${risk.title})`,
	disposition: sql`${risk.disposition}`,
	score: scoreSql,
	residualScore: residualSql,
	reviewed: sql`${risk.lastReviewedAt}`,
	created: sql`${risk.createdAt}`
};

export function list(
	ctx: Ctx,
	input: RiskFilters & {
		sort: keyof typeof SORTS;
		dir: 'asc' | 'desc';
		cursor?: string;
		limit: number;
	}
) {
	const w = where(input);
	const total = ctx.db.select({ n: count() }).from(risk).where(w).get()?.n ?? 0;
	const offset = Math.max(0, Number(input.cursor) || 0);
	const rows = ctx.db
		.select()
		.from(risk)
		.where(w)
		.orderBy(sql`${SORTS[input.sort]} ${sql.raw(input.dir)} NULLS LAST`, desc(risk.id))
		.limit(input.limit)
		.offset(offset)
		.all();
	const end = offset + rows.length;
	return {
		items: hydrate(ctx, rows),
		next: end < total ? String(end) : null,
		total
	};
}

// ---- matrix ----

export function matrix(ctx: Ctx): RiskMatrix {
	const rows = ctx.db
		.select()
		.from(risk)
		.where(inArray(risk.disposition, [...RISK_LIVE_DISPOSITIONS]))
		.all();
	const grid = () => Array.from({ length: 5 }, () => Array<number>(5).fill(0));
	const current = grid();
	const residual = grid();
	for (const r of rows) {
		current[r.probability - 1]![r.impact - 1]!++;
		if (r.residualProbability !== null && r.residualImpact !== null)
			residual[r.residualProbability - 1]![r.residualImpact - 1]!++;
	}
	return {
		matrix: current,
		residualMatrix: residual,
		labels: { probability: [...RISK_PROBABILITY_LABELS], impact: [...RISK_IMPACT_LABELS] },
		totalRisks: rows.length
	};
}

// ---- history ----

const HISTORY_FIELDS = [
	'probability',
	'impact',
	'residualProbability',
	'residualImpact',
	'disposition',
	'ownerId'
] as const;

/** Score, residual, disposition and owner changes from the audit log, newest first. */
export function history(ctx: Ctx, id: number): RiskHistoryRow[] {
	load(ctx, id);
	const entries = ctx.db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.entity, 'risk'), eq(auditLog.entityId, id)))
		.orderBy(desc(auditLog.at), desc(auditLog.id))
		.all();
	const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
	const userIds = new Set<number>();
	for (const e of entries) {
		if (e.actorUserId) userIds.add(e.actorUserId);
		for (const b of [obj(e.before), obj(e.after)])
			if (typeof b.ownerId === 'number') userIds.add(b.ownerId);
	}
	const names = new Map(
		userIds.size
			? ctx.db
					.select({ id: user.id, name: user.name })
					.from(user)
					.where(inArray(user.id, [...userIds]))
					.all()
					.map((u) => [u.id, u.name] as const)
			: []
	);
	const out: RiskHistoryRow[] = [];
	for (const e of entries) {
		if (e.action === 'delete') continue;
		const before = obj(e.before);
		const after = obj(e.after);
		const changes: RiskHistoryRow['changes'] = [];
		for (const f of HISTORY_FIELDS) {
			const from = e.action === 'create' ? null : (before[f] ?? null);
			const to = after[f] ?? null;
			if (from === to) continue;
			const named = (v: unknown) => (f === 'ownerId' ? (names.get(v as number) ?? null) : v);
			changes.push({
				field: f === 'ownerId' ? 'owner' : f,
				from: (from === null ? null : named(from)) as string | number | null,
				to: (to === null ? null : named(to)) as string | number | null
			});
		}
		if (!changes.length) continue;
		const moved = changes.some((c) => c.field === 'disposition');
		out.push({
			at: e.at,
			by: e.actorUserId ? (names.get(e.actorUserId) ?? null) : null,
			action: e.action as 'create' | 'update',
			changes,
			note: moved ? ((after.dispositionNote as string | null) ?? null) : null
		});
	}
	return out;
}

// ---- review stamp ----

/** The entire review ceremony: "reviewed now, by me" on every risk in the set. */
export function reviewStamp(ctx: Ctx, input: RiskFilters & { riskIds?: number[] }) {
	const rows = input.riskIds
		? ctx.db.select().from(risk).where(inArray(risk.id, input.riskIds)).all()
		: ctx.db.select().from(risk).where(where(input)).all();
	if (!rows.length) throw notFound('Matching risks');
	const reviewedAt = now();
	const by = actorUserId(ctx.actor);
	for (const r of rows) writeUpdate(ctx, risk, r.id, { lastReviewedAt: reviewedAt, lastReviewedById: by });
	return { stamped: rows.length, reviewedAt };
}

export { blank };
