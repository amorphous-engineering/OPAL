/** Derived issue state: one definition each, as a function on a row and as its SQL twin. */
import { takesDisposition, type DispState, type TicketState } from '@opal/shared';
import { and, eq, isNotNull, isNull, ne, not, or, type SQL } from 'drizzle-orm';
import { issue } from '../../db/schema/index.ts';

export type IssueRow = typeof issue.$inferSelect;

/** Holds work: containment above advisory. Disposition state (`dispState`) exists only here. */
export const containmentBearing = (r: Pick<IssueRow, 'containment'>) => r.containment !== 'advisory';

export { takesDisposition };

/** Type and signature both set. */
export const isDispositioned = (r: Pick<IssueRow, 'dispositionType' | 'dispositionedAt'>) =>
	r.dispositionType !== null && r.dispositionedAt !== null;

/** Open, containment-bearing and undispositioned: the issue holds work. */
export function isBlocking(r: IssueRow): boolean {
	return r.status === 'open' && containmentBearing(r) && !isDispositioned(r);
}

export function dispState(r: IssueRow): DispState {
	if (r.status !== 'open') return r.status;
	if (!containmentBearing(r)) return 'open';
	return isDispositioned(r) ? 'dispositioned' : 'undispositioned';
}

/**
 * pending | in_work | in_review | done, independent of the hold. An issue that takes a
 * disposition enters work when it is signed. An advisory issue someone started before
 * non-conformances took a disposition stays in work; it still needs one to close.
 */
export function ticketState(r: IssueRow): TicketState {
	if (r.status !== 'open') return 'done';
	if (r.reviewRequestedAt !== null) return 'in_review';
	const started =
		(!containmentBearing(r) && r.workStartedAt !== null) || (takesDisposition(r) && isDispositioned(r));
	return started ? 'in_work' : 'pending';
}

/** Signer is the raiser. Visible, not forbidden. */
export const selfDispositioned = (r: IssueRow) =>
	r.raisedById !== null && r.dispositionedById !== null && r.raisedById === r.dispositionedById;

// ---- SQL twins ----

export const signedSql = and(isNotNull(issue.dispositionType), isNotNull(issue.dispositionedAt))!;
const bearingSql = ne(issue.containment, 'advisory');
/** SQL twin of takesDisposition. */
const takesDispositionSql = or(bearingSql, eq(issue.issueType, 'non_conformance'))!;
const openSql = eq(issue.status, 'open');
/** SQL twin of isBlocking. */
export const blockingSql: SQL = and(openSql, bearingSql, not(signedSql))!;

export function ticketStateSql(state: TicketState): SQL {
	const quiet = and(openSql, isNull(issue.reviewRequestedAt))!;
	const started = or(
		and(eq(issue.containment, 'advisory'), isNotNull(issue.workStartedAt)),
		and(takesDispositionSql, signedSql)
	)!;
	switch (state) {
		case 'done':
			return ne(issue.status, 'open');
		case 'in_review':
			return and(openSql, isNotNull(issue.reviewRequestedAt))!;
		case 'in_work':
			return and(quiet, started)!;
		case 'pending':
			return and(quiet, not(started))!;
	}
}

export function dispStateSql(state: DispState): SQL {
	switch (state) {
		case 'closed':
		case 'void':
			return eq(issue.status, state);
		case 'open':
			return and(openSql, eq(issue.containment, 'advisory'))!;
		case 'dispositioned':
			return and(openSql, bearingSql, signedSql)!;
		case 'undispositioned':
			return blockingSql;
	}
}
