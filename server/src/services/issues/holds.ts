/**
 * Holds are never stored. An open, containment-bearing, undispositioned issue anchored on an
 * execution holds it. The execution area (wave 3) builds its gates and blockers from these.
 */
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { issue } from '../../db/schema/index.ts';
import { blockingSql, ticketState } from './state.ts';
import type { Containment, TicketState } from '@opal/shared';

export interface HoldingIssue {
	id: number;
	issueNumber: string;
	title: string;
	priority: string;
	containment: Containment;
	ticketState: TicketState;
	executionId: number;
	raisedStepId: number | null;
	containmentStepId: number | null;
}

/**
 * The open issues holding an execution, in issue order, with containment and anchors.
 *
 * Without `anchorStepIds` it lists every blocking issue of the execution.
 * With it, it lists the issues that hold those steps: issues anchored on one of the ids, plus
 * issues that hold the whole work order or have no anchor (an anchorless step or op issue holds
 * the work order, as in legacy). To ask about one step, pass [stepId]. To ask about an op, pass
 * the ids of the op row and every step in it.
 */
export function holdingIssues(
	db: Db,
	executionId: number,
	opts: { anchorStepIds?: number[] } = {}
): HoldingIssue[] {
	const ids = opts.anchorStepIds;
	const scope =
		ids === undefined
			? undefined
			: or(
					eq(issue.containment, 'wo'),
					and(isNull(issue.containmentStepId), isNull(issue.raisedStepId)),
					inArray(issue.containmentStepId, ids.length ? ids : [-1]),
					inArray(issue.raisedStepId, ids.length ? ids : [-1])
				);
	return db
		.select()
		.from(issue)
		.where(and(eq(issue.executionId, executionId), blockingSql, scope))
		.orderBy(asc(issue.id))
		.all()
		.map((r) => ({
			id: r.id,
			issueNumber: r.issueNumber,
			title: r.title,
			priority: r.priority,
			containment: r.containment,
			ticketState: ticketState(r),
			executionId,
			raisedStepId: r.raisedStepId,
			containmentStepId: r.containmentStepId
		}));
}

/** Whether any issue holds the execution. */
export function hasBlocker(db: Db, executionId: number | null): boolean {
	if (executionId === null) return false;
	return (
		db
			.select({ id: issue.id })
			.from(issue)
			.where(and(eq(issue.executionId, executionId), blockingSql))
			.limit(1)
			.get() !== undefined
	);
}
