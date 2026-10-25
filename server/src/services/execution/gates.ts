/**
 * Gating: what refuses a commitment (complete, sign, skip). One fold behind both the refusal
 * the write operations give and the `canSign` / `blockers` the document shows, so a control is
 * inert exactly when the server would refuse.
 */
import { type ExecBlocker, specResult, specText, unitSymbol } from '@opal/shared';
import type { Db } from '../../db/client.ts';
import { type HoldState, blockersForBound, blockersForComplete } from './holds.ts';
import { type Model, type Row, isActive, isTerminal } from './model.ts';

export type Blocker = ExecBlocker;

const blocker = (kind: Blocker['kind'], message: string, issueId: number | null = null, issueNumber: string | null = null): Blocker => ({
	kind,
	message,
	issueId,
	issueNumber
});

/** Structural gates: open sub-steps, strict sequence, OP dependencies, open redlines. */
export function sequenceBlockers(m: Model, row: Row): Blocker[] {
	const out: Blocker[] = [];
	let gate: Row | null = null;
	if (row.level === 0) {
		gate = row;
		const open = (m.children.get(row.id) ?? []).filter((c) => !isTerminal(c.se.status));
		if (open.length) out.push(blocker('children', `Waiting on sub-steps ${open.map((c) => c.number).join(', ')}`));
	} else if (row.parentId !== null) {
		gate = m.byId.get(row.parentId) ?? null;
		if (gate?.strictSequence) {
			const unmet = (m.children.get(gate.id) ?? [])
				.filter((s) => s.adhoc === null && s.seq < row.seq && !isTerminal(s.se.status))
				.map((s) => s.number);
			if (unmet.length) out.push(blocker('sequence', `Waiting on ${unmet.join(', ')}`));
		}
	}
	if (gate) {
		const deps = gate.dependsOn.map((d) => m.byId.get(d)).filter((r): r is Row => !!r && !isTerminal(r.se.status));
		if (deps.length) out.push(blocker('dependency', `Waiting on OP ${deps.map((d) => d.number).join(', ')}`));
		const redlines = m.rows.filter((r) => r.level === 0 && r.redline?.hostId === gate!.id && !isTerminal(r.se.status));
		if (redlines.length) out.push(blocker('redline', `Waiting on redline op ${redlines.map((r) => r.number).join(', ')}`));
	}
	return out;
}

/** Undispositioned issues holding this row's scope. */
export function heldScopeBlockers(st: HoldState, row: Row): Blocker[] {
	const seen = new Set<number>();
	const out: Blocker[] = [];
	for (const i of [...blockersForComplete(st, row), ...blockersForBound(st, row)]) {
		if (seen.has(i.id)) continue;
		seen.add(i.id);
		out.push(blocker('nc', `Undispositioned ${i.issueNumber}`, i.id, i.issueNumber));
	}
	return out;
}

/** What explains an out-of-spec value: the values to judge and whether the step has a note or an NC. */
export interface CaptureCheck {
	data: Record<string, unknown> | null | undefined;
	hasNote: boolean;
	hasNc: boolean;
}

/**
 * A captured value outside its spec stops the step until someone explains it with a note on
 * the step or an NC raised from it. Notes carry no link to a value and a value has no capture
 * time of its own (it is saved with the signature), so any note on the step counts.
 */
export function outOfSpecBlockers(row: Row, cap: CaptureCheck | undefined): Blocker[] {
	if (!cap || cap.hasNote || cap.hasNc) return [];
	const out: Blocker[] = [];
	for (const f of row.dataSchema?.fields ?? []) {
		if (f.type !== 'number' || !f.spec) continue;
		const v = cap.data?.[f.name];
		if (specResult(f.spec, v) !== 'out_of_spec') continue;
		const sym = unitSymbol(f.unit);
		out.push(
			blocker(
				'out_of_spec',
				`${f.label ?? f.name} ${String(v).trim()}${sym ? ` ${sym}` : ''} is out of spec (${specText(f.spec, f.unit)}): add a note or raise an NC`
			)
		);
	}
	return out;
}

export const completeBlockers = (m: Model, st: HoldState, row: Row, cap?: CaptureCheck): Blocker[] => [
	...heldScopeBlockers(st, row),
	...sequenceBlockers(m, row),
	...outOfSpecBlockers(row, cap)
];

/**
 * Skip is terminal, so it inherits the held scope, open redlines and open sub-steps. It leaves
 * out strict sequence and OP dependencies: skipping need not wait for predecessors.
 */
export const skipBlockers = (m: Model, st: HoldState, row: Row): Blocker[] => [
	...heldScopeBlockers(st, row),
	...sequenceBlockers(m, row).filter((b) => b.kind === 'redline' || b.kind === 'children')
];

/** A claim is refused only by structural waits other than open sub-steps. */
export const claimBlockers = (m: Model, row: Row): Blocker[] => sequenceBlockers(m, row).filter((b) => b.kind !== 'children');

/**
 * (canSign, blockers) for one slot. Slot 0 is the commitment: the step is open and every
 * sequence, hold and sub-step gate is clear. Later slots need slot 0 and a clear held scope,
 * and may be signed in any order. With `holderRoles`, a slot that names a role the person lacks
 * gets a `role` blocker.
 */
export function slotGate(
	m: Model,
	st: HoldState,
	row: Row,
	slot: number,
	signed: ReadonlySet<number>,
	complete: Blocker[] | undefined,
	roleOk: boolean
): { canSign: boolean; blockers: Blocker[] } {
	if (!isActive(m.exec)) return { canSign: false, blockers: [] };
	const status = row.se.status;
	if (signed.has(slot) || isTerminal(status)) return { canSign: false, blockers: [] };
	let blockers: Blocker[];
	if (slot === 0) {
		blockers = status === 'pending' ? (complete ?? completeBlockers(m, st, row)) : heldScopeBlockers(st, row);
	} else if (!signed.has(0)) {
		blockers = [blocker('signoff', `Waiting on ${row.signoffs[0]!.label}`)];
	} else if (status !== 'awaiting_signoff') {
		return { canSign: false, blockers: [] };
	} else {
		blockers = heldScopeBlockers(st, row);
	}
	const role = row.signoffs[slot]?.role;
	if (role && !roleOk) blockers = [...blockers, blocker('role', `Requires ${role}`)];
	return { canSign: blockers.length === 0, blockers };
}

export function describeBlockers(verb: string, blockers: Blocker[]): string {
	return `Cannot ${verb}: ${blockers.map((b) => b.message).join('; ')}`;
}

export type { Db };
