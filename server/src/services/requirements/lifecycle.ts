/**
 * Baseline lifecycle for requirements. One module, so the API and MCP cannot drift.
 *
 *   draft -> preliminary -> baselined -> superseded | cancelled
 *
 * A baselined row is immutable. Editing one means `revise`, which returns a NEW draft row
 * (revision + 1, supersedes set). The old row stays the baseline in force until the new
 * revision itself baselines. Then it flips to superseded and the new revision takes over its part
 * allocations and its children. Rules that a machine can decide (lint blockers) are enforced here.
 * Nothing else blocks.
 */
import { type RequirementLifecycleState, conflict, now } from '@opal/shared';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { partRequirement, requirement } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';
import { baselineLintBlockers } from './lint.ts';

export type RequirementRow = typeof requirement.$inferSelect;

export const EDITABLE: readonly RequirementLifecycleState[] = ['draft', 'preliminary'];
/** Not finished paper. A draft of the next revision and the baseline in force are both live. */
export const LIVE = ['draft', 'preliminary', 'baselined'] as const;
export const isMutable = (r: Pick<RequirementRow, 'lifecycleState'>) =>
	EDITABLE.includes(r.lifecycleState);

const refuse = (message: string) => conflict('requirement_state', message);

export function ensureMutable(r: RequirementRow): void {
	if (!isMutable(r)) {
		throw refuse(
			`${r.reqNumber} rev ${r.revision} is ${r.lifecycleState} and immutable: use revise to create a new revision`
		);
	}
}

/** Reasons this row cannot baseline yet. Every block_baseline lint finding blocks. */
export const baselineBlockers = baselineLintBlockers;

/**
 * The new revision takes over from the one it supersedes. The old row's links stay as they stand:
 * they are the evidence for what was verified against that text. The text changed, so each part
 * starts open on the new row and a person verifies it again. A link marked not applicable stays
 * behind, because that is how a person retires a link that can no longer be removed.
 */
function carryAllocations(ctx: Ctx, predecessor: RequirementRow, next: RequirementRow): void {
	const links = (requirementId: number) =>
		ctx.db.select().from(partRequirement).where(eq(partRequirement.requirementId, requirementId)).all();
	const held = new Set(links(next.id).map((l) => l.partId));
	for (const link of links(predecessor.id)) {
		if (link.status === 'not_applicable' || held.has(link.partId)) continue;
		insert(ctx, partRequirement, { partId: link.partId, requirementId: next.id, notes: link.notes });
	}
}

/**
 * Live children follow the number to the new revision and go stale until a person looks at them.
 * Finished children keep the parent they were written against.
 */
function carryChildren(ctx: Ctx, predecessor: RequirementRow, next: RequirementRow): void {
	const children = ctx.db
		.select()
		.from(requirement)
		.where(
			and(
				eq(requirement.parentId, predecessor.id),
				inArray(requirement.lifecycleState, [...LIVE]),
				ne(requirement.reqNumber, predecessor.reqNumber)
			)
		)
		.all();
	for (const child of children) update(ctx, requirement, child.id, { parentId: next.id, stale: true });
}

/** Baseline a draft or preliminary row; supersede its predecessor if one is in force. */
export function baselineRow(ctx: Ctx, r: RequirementRow): RequirementRow {
	if (!isMutable(r)) {
		throw refuse(
			`cannot baseline from state '${r.lifecycleState}' (only draft or preliminary can baseline)`
		);
	}
	const blockers = baselineBlockers(r);
	if (blockers.length) throw conflict('not_baselineable', blockers.join('; '));

	const done = update(ctx, requirement, r.id, {
		lifecycleState: 'baselined',
		baselinedAt: now(),
		baselinedById: actorUserId(ctx.actor)
	});
	if (r.supersedesId !== null) {
		const prev = ctx.db.select().from(requirement).where(eq(requirement.id, r.supersedesId)).get();
		if (prev && prev.lifecycleState === 'baselined') {
			update(ctx, requirement, prev.id, { lifecycleState: 'superseded' });
			carryAllocations(ctx, prev, done);
			carryChildren(ctx, prev, done);
		}
	}
	return done;
}

/** The next revision of a baselined row, as a new draft. */
export function reviseRow(ctx: Ctx, r: RequirementRow): RequirementRow {
	if (r.lifecycleState !== 'baselined') {
		throw refuse(
			`cannot revise from state '${r.lifecycleState}' (only baselined rows can be revised; drafts are edited in place)`
		);
	}
	const next = ctx.db
		.select({ id: requirement.id })
		.from(requirement)
		.where(eq(requirement.supersedesId, r.id))
		.get();
	if (next) throw refuse(`${r.reqNumber} already has a newer revision`);
	return insert(ctx, requirement, {
		reqNumber: r.reqNumber,
		projectId: r.projectId, // added by projects
		revision: r.revision + 1,
		lifecycleState: 'draft',
		title: r.title,
		statement: r.statement,
		rationale: r.rationale,
		category: r.category,
		parentId: r.parentId,
		level: r.level,
		verificationMethod: r.verificationMethod,
		tbd: r.tbd,
		tbr: r.tbr,
		tbrOwnerId: r.tbrOwnerId,
		tbrDue: r.tbrDue,
		// A new revision is by definition a fresh look.
		stale: false,
		supersedesId: r.id
	});
}

/** Strike a requirement that is not terminal. The reason, who and when stay on the row. */
export function cancelRow(ctx: Ctx, r: RequirementRow, reason: string): RequirementRow {
	if (r.lifecycleState === 'superseded' || r.lifecycleState === 'cancelled') {
		throw refuse(`cannot cancel from terminal state '${r.lifecycleState}'`);
	}
	return update(ctx, requirement, r.id, {
		lifecycleState: 'cancelled',
		cancelledAt: now(),
		cancelledById: actorUserId(ctx.actor),
		cancelReason: reason.trim()
	});
}
