/** Links from a risk to issues (mitigation, research, realized) and its references. */
import {
	OpalError,
	type Risk,
	type RiskIssueRole,
	conflict,
	notFound
} from '@opal/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { issue, issueLink, risk, riskReference } from '../../db/schema/index.ts';
import { insert, remove, update as writeUpdate } from '../../write.ts';
import { create as createIssue } from '../issues/service.ts';
import { load, one } from './service.ts';

function loadIssue(ctx: Ctx, id: number) {
	const row = ctx.db.select().from(issue).where(eq(issue.id, id)).get();
	if (!row) throw notFound('Issue');
	return row;
}

export function linkIssue(ctx: Ctx, riskId: number, issueId: number, role: RiskIssueRole): Risk {
	load(ctx, riskId);
	const target = loadIssue(ctx, issueId);
	const dup = ctx.db
		.select({ id: issueLink.id })
		.from(issueLink)
		.where(and(eq(issueLink.issueId, issueId), eq(issueLink.riskId, riskId)))
		.get();
	if (dup) throw conflict('duplicate', `${target.issueNumber} is already linked`);
	insert(ctx, issueLink, { issueId, riskId, riskRole: role });
	return one(ctx, riskId);
}

/** Create an issue and attach it: a mitigation or research link, or the realized pointer. */
export function spawnIssue(
	ctx: Ctx,
	riskId: number,
	input: { role: RiskIssueRole | 'realized'; title: string; description?: string | null }
): Risk {
	const r = load(ctx, riskId);
	if (input.role === 'realized' && r.realizedIssueId !== null) {
		const existing = loadIssue(ctx, r.realizedIssueId);
		throw conflict(
			'already_realized',
			`already realized as ${existing.issueNumber}: spawning again would orphan it`
		);
	}
	const created = createIssue(ctx, {
		projectId: r.projectId, // added by projects
		title: input.title,
		description: input.description,
		issueType: input.role === 'realized' ? 'non_conformance' : 'task',
		priority: 'medium',
		containment: 'advisory',
		links: []
	});
	if (input.role === 'realized') {
		writeUpdate(ctx, risk, riskId, { realizedIssueId: created.id });
	} else {
		insert(ctx, issueLink, { issueId: created.id, riskId, riskRole: input.role });
	}
	return one(ctx, riskId);
}

export function unlinkIssue(ctx: Ctx, riskId: number, issueId: number): Risk {
	load(ctx, riskId);
	const link = ctx.db
		.select({ id: issueLink.id })
		.from(issueLink)
		.where(and(eq(issueLink.riskId, riskId), eq(issueLink.issueId, issueId)))
		.get();
	if (!link) throw notFound('Link');
	remove(ctx, issueLink, link.id);
	return one(ctx, riskId);
}

// ---- references ----

const FORMAT = { opal: /^OPAL-\d+$/, work_order: /^WO-\d+$/ } as const;

export function addReference(
	ctx: Ctx,
	riskId: number,
	input: { type: 'opal' | 'work_order'; value: string; notes?: string | null }
): Risk {
	load(ctx, riskId);
	const value = input.value.trim().toUpperCase();
	if (!FORMAT[input.type].test(value)) {
		const msg = input.type === 'opal' ? 'Expected OPAL-00042' : 'Expected WO-00015';
		throw new OpalError(422, 'invalid_input', msg, { value: msg });
	}
	const dup = ctx.db
		.select({ id: riskReference.id })
		.from(riskReference)
		.where(
			and(
				eq(riskReference.riskId, riskId),
				eq(riskReference.referenceType, input.type),
				eq(riskReference.referenceValue, value)
			)
		)
		.get();
	if (dup) throw conflict('duplicate', `${value} is already referenced`);
	insert(ctx, riskReference, {
		riskId,
		referenceType: input.type,
		referenceValue: value,
		notes: input.notes?.trim() || null
	});
	return one(ctx, riskId);
}

export function removeReference(ctx: Ctx, riskId: number, referenceId: number): Risk {
	load(ctx, riskId);
	const row = ctx.db
		.select({ id: riskReference.id })
		.from(riskReference)
		.where(and(eq(riskReference.id, referenceId), eq(riskReference.riskId, riskId)))
		.get();
	if (!row) throw notFound('Reference');
	remove(ctx, riskReference, referenceId);
	return one(ctx, riskId);
}

/** For the issue page: the risks an issue responds to or realizes. */
export function risksOfIssue(ctx: Ctx, issueId: number) {
	const linked = ctx.db
		.select({ id: risk.id, riskNumber: risk.riskNumber, title: risk.title, role: issueLink.riskRole })
		.from(issueLink)
		.innerJoin(risk, eq(risk.id, issueLink.riskId))
		.where(and(eq(issueLink.issueId, issueId), isNotNull(issueLink.riskId)))
		.all()
		.map((r) => ({
			riskId: r.id,
			riskNumber: r.riskNumber,
			title: r.title,
			relation: r.role!
		}));
	const realized = ctx.db
		.select({ id: risk.id, riskNumber: risk.riskNumber, title: risk.title })
		.from(risk)
		.where(eq(risk.realizedIssueId, issueId))
		.all()
		.map((r) => ({ riskId: r.id, riskNumber: r.riskNumber, title: r.title, relation: 'realized' as const }));
	return [...linked, ...realized];
}
