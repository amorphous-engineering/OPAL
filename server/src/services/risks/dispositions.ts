/**
 * Disposition state machine and acceptance (legacy opal/risks/dispositions.py and readiness.py).
 *
 * Dispositions change freely except:
 * - accepted -> anything needs a note (un-accepting a signature is auditable)
 * - accepted is reachable only through `accept`, the signature moment
 * - realized is terminal: the risk lives on as its issue
 */
import { RISK_DISPOSITIONS, type Risk, type RiskReadiness, conflict, notFound, now } from '@opal/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { issue, issueLink, risk } from '../../db/schema/index.ts';
import { update as writeUpdate } from '../../write.ts';
import { acceptLintBlockers } from './lint.ts';
import { type RiskRow, blank } from './scenario.ts';
import { load, one } from './service.ts';

/** Count of linked issues of one role that are still open work. */
export function openLinks(ctx: Ctx, riskId: number, role: 'mitigation' | 'research'): number {
	return ctx.db
		.select({ id: issueLink.id })
		.from(issueLink)
		.innerJoin(issue, eq(issue.id, issueLink.issueId))
		.where(
			and(
				eq(issueLink.riskId, riskId),
				isNotNull(issueLink.riskId),
				eq(issueLink.riskRole, role),
				eq(issue.status, 'open')
			)
		)
		.all().length;
}

/** Reasons a transition is refused. Each names its requirement. */
export function dispositionBlockers(
	ctx: Ctx,
	r: RiskRow,
	target: string,
	note?: string | null
): string[] {
	if (!(RISK_DISPOSITIONS as readonly string[]).includes(target))
		return [`unknown disposition '${target}'`];
	if (r.disposition === 'realized')
		return ['realized is terminal: the risk lives on as its linked issue'];
	if (target === r.disposition) return [`risk is already ${target}`];
	if (target === 'accepted')
		return ['acceptance requires the accept action: a signature, not a status change'];

	const out: string[] = [];
	if (r.disposition === 'accepted' && blank(note)) out.push('un-accepting a signed risk requires a note');
	switch (target) {
		case 'mitigate':
			if (!openLinks(ctx, r.id, 'mitigation'))
				out.push(
					'mitigate requires at least one open linked issue (role: mitigation): a mitigation is real when it has an issue with an owner'
				);
			if (r.residualProbability === null || r.residualImpact === null)
				out.push('mitigate requires a residual score: the post-response target');
			break;
		case 'watch':
			if (blank(r.watchObservable)) out.push('watch requires an observable: what is being monitored');
			if (blank(r.watchThreshold)) out.push('watch requires a threshold: when the watch trips');
			break;
		case 'research':
			if (!openLinks(ctx, r.id, 'research') && blank(r.description))
				out.push('research requires a linked issue (role: research) or a narrative note');
			break;
		case 'closed':
			if (blank(note)) out.push('closing requires a one-line close note');
			break;
		case 'realized':
			if (r.realizedIssueId === null)
				out.push(
					'realized requires a linked issue: the departure happened; its afterlife is a problem record'
				);
			break;
	}
	return out;
}

export function dispositionCheck(ctx: Ctx, id: number, target: string) {
	const r = load(ctx, id);
	return {
		target,
		// The form collects the note and the change enforces it, so assume it is given.
		blockers: dispositionBlockers(ctx, r, target, 'pending'),
		openMitigations: openLinks(ctx, id, 'mitigation'),
		openResearch: openLinks(ctx, id, 'research'),
		needsNote: target === 'closed' || r.disposition === 'accepted'
	};
}

export function setDisposition(
	ctx: Ctx,
	id: number,
	input: { disposition: string; note?: string | null; realizedIssueId?: number | null }
): Risk {
	const r = load(ctx, id);
	const realizedIssueId = input.realizedIssueId ?? null;
	if (realizedIssueId !== null) {
		if (!ctx.db.select({ id: issue.id }).from(issue).where(eq(issue.id, realizedIssueId)).get())
			throw notFound('Realized issue');
	}
	const virtual = { ...r, realizedIssueId: realizedIssueId ?? r.realizedIssueId };
	const blockers = dispositionBlockers(ctx, virtual, input.disposition, input.note);
	if (blockers.length) throw conflict('disposition_blocked', blockers.join('; '));
	writeUpdate(ctx, risk, id, {
		disposition: input.disposition as RiskRow['disposition'],
		dispositionNote: blank(input.note) ? null : input.note!.trim(),
		...(realizedIssueId !== null ? { realizedIssueId } : {})
	});
	return one(ctx, id);
}

// ---- readiness ----

function scenarioDetail(r: RiskRow): string | null {
	const missing = (
		[
			['condition', r.condition],
			['departure', r.departure],
			['consequence', r.consequence]
		] as const
	)
		.filter(([, v]) => blank(v))
		.map(([label]) => label);
	const hasPart = r.assetPartId !== null;
	const hasText = !blank(r.assetText);
	if (!hasPart && !hasText) missing.push('asset' as never);
	if (!missing.length && hasPart && hasText)
		return 'both asset part and asset text set: exactly one names the asset';
	return missing.length ? `missing: ${missing.join(', ')}` : null;
}

const UNACCEPTABLE = ['accepted', 'realized'];

export function readinessOf(r: RiskRow): RiskReadiness {
	const detail = scenarioDetail(r);
	const lint = acceptLintBlockers(r);
	const checks = [
		{
			key: 'scenario_complete',
			label: 'scenario complete (condition · departure · asset · consequence)',
			passed: detail === null,
			severity: 'hard' as const,
			detail
		},
		{
			key: 'owner_assigned',
			label: 'owner assigned',
			passed: r.ownerId !== null,
			severity: 'hard' as const,
			detail: r.ownerId !== null ? null : 'a risk has exactly one owner'
		},
		{
			key: 'scored',
			label: 'scored (probability × impact)',
			passed: r.probability >= 1 && r.probability <= 5 && r.impact >= 1 && r.impact <= 5,
			severity: 'hard' as const,
			detail: null
		},
		{
			key: 'rationale_recorded',
			label: 'acceptance rationale recorded',
			passed: !blank(r.acceptanceRationale),
			severity: 'hard' as const,
			detail: null
		},
		{
			key: 'lint_clean',
			label: 'scenario lint clean',
			passed: lint.length === 0,
			severity: 'hard' as const,
			detail: lint.length ? lint[0] + (lint.length > 1 ? ` (+${lint.length - 1} more)` : '') : null
		}
	];
	return { ready: !UNACCEPTABLE.includes(r.disposition) && checks.every((c) => c.passed), checks };
}

export const readiness = (ctx: Ctx, id: number) => readinessOf(load(ctx, id));

/** What `accept` reports on refusal: one message per failing check. */
export function acceptanceBlockers(r: RiskRow): string[] {
	const out: string[] = [];
	if (UNACCEPTABLE.includes(r.disposition)) out.push(`cannot accept from disposition '${r.disposition}'`);
	for (const c of readinessOf(r).checks)
		if (!c.passed) out.push(c.detail ?? `${c.label.split(' (')[0]} required`);
	return out;
}

/** The signature moment. Needs a user and a ready risk. */
export function accept(ctx: Ctx, id: number, rationale?: string | null): Risk {
	const r = load(ctx, id);
	const userId = actorUserId(ctx.actor);
	if (userId === null) throw conflict('signature', 'acceptance is a signature: it requires a user');
	const rationaleNext = blank(rationale) ? r.acceptanceRationale : rationale!.trim();
	const blockers = acceptanceBlockers({ ...r, acceptanceRationale: rationaleNext });
	if (blockers.length) throw conflict('not_ready', blockers.join('; '));
	writeUpdate(ctx, risk, id, {
		disposition: 'accepted',
		dispositionNote: null,
		acceptanceRationale: rationaleNext,
		acceptedById: userId,
		acceptedAt: now()
	});
	return one(ctx, id);
}
