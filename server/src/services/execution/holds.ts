/**
 * Holds on an execution, derived from issues (`holdingIssues`) and the step each issue is
 * anchored at. Nothing here is stored. Containment says what an undispositioned issue holds:
 *
 *   step      the raised step cannot complete, nor its OP; a bound step ("resolve by")
 *             cannot complete either, while work goes on up to it
 *   op        every step may run, but the OP cannot complete
 *   wo        the execution cannot complete
 *   advisory  nothing (never listed: holdingIssues skips it)
 */
import type { Db } from '../../db/client.ts';
import { type HoldingIssue, holdingIssues } from '../issues/holds.ts';
import { type Model, type Row, opRowOf } from './model.ts';

export interface HoldState {
	/** step execution id -> issues holding that step's complete */
	completeBlocked: Map<number, HoldingIssue[]>;
	/** step execution id -> issues bound to a later step ("resolve by") */
	startBlocked: Map<number, HoldingIssue[]>;
	/** OP row id -> issues holding the OP's complete */
	opCompleteBlocked: Map<number, HoldingIssue[]>;
	/** issues holding the whole execution */
	woBlocked: HoldingIssue[];
	all: HoldingIssue[];
}

const push = (m: Map<number, HoldingIssue[]>, k: number, i: HoldingIssue) => m.set(k, [...(m.get(k) ?? []), i]);

export function holdState(db: Db, model: Model): HoldState {
	const all = holdingIssues(db, model.exec.id);
	const st: HoldState = {
		completeBlocked: new Map(),
		startBlocked: new Map(),
		opCompleteBlocked: new Map(),
		woBlocked: [],
		all
	};
	for (const issue of all) {
		const anchor =
			(issue.containmentStepId !== null ? model.byId.get(issue.containmentStepId) : undefined) ??
			(issue.raisedStepId !== null ? model.byId.get(issue.raisedStepId) : undefined);
		if (issue.containment === 'wo' || !anchor) {
			// No resolvable step in this execution holds the execution itself.
			st.woBlocked.push(issue);
			continue;
		}
		const op = opRowOf(model, anchor);
		if (issue.containment === 'op') {
			push(st.opCompleteBlocked, op.id, issue);
			continue;
		}
		const boundElsewhere =
			issue.containmentStepId !== null && issue.raisedStepId !== null && issue.containmentStepId !== issue.raisedStepId;
		if (boundElsewhere) {
			push(st.startBlocked, anchor.id, issue);
		} else {
			push(st.completeBlocked, anchor.id, issue);
			if (op.id !== anchor.id) push(st.opCompleteBlocked, op.id, issue);
		}
	}
	return st;
}

const dedupe = (list: HoldingIssue[]) => [...new Map(list.map((i) => [i.id, i])).values()];

/** Issues that refuse this row's complete (or skip). */
export function blockersForComplete(st: HoldState, row: Row): HoldingIssue[] {
	const own = st.completeBlocked.get(row.id) ?? [];
	return row.level === 0 ? dedupe([...own, ...(st.opCompleteBlocked.get(row.id) ?? [])]) : own;
}

/** Boundary holds bound to this row: they gate its complete too. */
export const blockersForBound = (st: HoldState, row: Row): HoldingIssue[] => st.startBlocked.get(row.id) ?? [];

/** Whether anything holds the row's complete, bound or raised. */
export const rowHeld = (st: HoldState, row: Row): boolean =>
	blockersForComplete(st, row).length > 0 || blockersForBound(st, row).length > 0;
