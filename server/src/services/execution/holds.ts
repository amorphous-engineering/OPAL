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
import { type Model, type Row, isTerminal, opRowOf } from './model.ts';

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

export type HoldScope = Pick<HoldingIssue, 'containment' | 'containmentStepId' | 'raisedStepId'>;

type Reach =
	| { kind: 'wo' }
	| { kind: 'op'; op: Row }
	| { kind: 'bound'; at: Row; op: Row }
	| { kind: 'raised'; at: Row; op: Row };

/** Where a hold lands in this execution. No resolvable step holds the execution itself. */
function reachOf(model: Model, scope: HoldScope): Reach {
	const at =
		(scope.containmentStepId !== null ? model.byId.get(scope.containmentStepId) : undefined) ??
		(scope.raisedStepId !== null ? model.byId.get(scope.raisedStepId) : undefined);
	if (scope.containment === 'wo' || !at) return { kind: 'wo' };
	const op = opRowOf(model, at);
	if (scope.containment === 'op') return { kind: 'op', op };
	const boundElsewhere =
		scope.containmentStepId !== null && scope.raisedStepId !== null && scope.containmentStepId !== scope.raisedStepId;
	return { kind: boundElsewhere ? 'bound' : 'raised', at, op };
}

/**
 * The rows this scope stops from completing. A bound step also stops its OP, through the open
 * sub-step, until it is finished.
 */
export function rowsHeldBy(model: Model, scope: HoldScope): Row[] {
	const reach = reachOf(model, scope);
	if (reach.kind === 'wo') return [];
	if (reach.kind === 'op') return [reach.op];
	if (reach.kind === 'bound' && isTerminal(reach.at.se.status)) return [];
	return [reach.at, reach.op];
}

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
		const reach = reachOf(model, issue);
		if (reach.kind === 'wo') {
			st.woBlocked.push(issue);
		} else if (reach.kind === 'op') {
			push(st.opCompleteBlocked, reach.op.id, issue);
		} else if (reach.kind === 'bound') {
			push(st.startBlocked, reach.at.id, issue);
		} else {
			push(st.completeBlocked, reach.at.id, issue);
			if (reach.op.id !== reach.at.id) push(st.opCompleteBlocked, reach.op.id, issue);
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
