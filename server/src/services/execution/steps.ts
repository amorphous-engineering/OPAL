/**
 * Step execution: sign (complete), skip, notes, and the completion rules that follow a
 * commitment. All gating is in gates.ts and holds.ts.
 */
import { OpalError, type SignResult, forbidden, now } from '@opal/shared';
import { actorUserId, type Ctx } from '../../context.ts';
import { execution, signoff, stepNote, stepExecution } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';
import { holdsSlotRole, roleNamesOf } from '../org/roles.ts';
import { publish } from '../platform/index.ts';
import { type Blocker, completeBlockers, describeBlockers, skipBlockers, slotGate } from './gates.ts';
import { holdState, rowHeld } from './holds.ts';
import { type Model, type Row, getRow, isActive, isTerminal, loadModel } from './model.ts';
import { personRefs, signedSlots, stepState } from './present.ts';

const refuse = (message: string, status = 409) => new OpalError(status, 'step_blocked', message);

// ---------------------------------------------------------------- data capture

/** Problems with captured values, by field name: required, number range. */
export function captureProblems(row: Row, data: Record<string, unknown> | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const values = data ?? {};
	for (const f of row.dataSchema?.fields ?? []) {
		const label = f.label ?? f.name;
		const v = values[f.name];
		if (f.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) {
			out[f.name] = `${label} is required`;
			continue;
		}
		if (f.type === 'number' && v !== undefined && v !== null && v !== '') {
			const n = typeof v === 'number' ? v : Number(v);
			if (!Number.isFinite(n)) out[f.name] = `${label}: invalid number`;
			else if (f.min !== undefined && n < f.min) out[f.name] = `${label}: ${n} below minimum ${f.min}`;
			else if (f.max !== undefined && n > f.max) out[f.name] = `${label}: ${n} above maximum ${f.max}`;
		}
	}
	return out;
}

// ---------------------------------------------------------------- execution lifecycle

/** The first completed or skipped work moves the execution out of `cut`. */
export function markInWork(ctx: Ctx, m: Model): boolean {
	if (m.exec.status !== 'cut') return false;
	update(ctx, execution, m.exec.id, { status: 'in_work', startedAt: now() });
	publish({ type: 'instance_started', data: { executionId: m.exec.id } });
	return true;
}

/**
 * Auto-complete OPs whose sub-steps are done (unless a hold stands in their scope), then close
 * the execution when nothing is left and nothing holds it. Returns whether it completed.
 * Contingency work is optional until touched.
 */
export function checkCompletion(ctx: Ctx, executionId: number): boolean {
	let m = loadModel(ctx.db, executionId);
	if (!isActive(m.exec)) return false;
	let st = holdState(ctx.db, m);
	for (const op of m.rows.filter((r) => r.level === 0 && r.hasChildren && r.se.status === 'pending')) {
		const kids = m.children.get(op.id) ?? [];
		if (!kids.every((k) => isTerminal(k.se.status))) continue;
		if (rowHeld(st, op) || kids.some((k) => rowHeld(st, k))) continue;
		const last = kids
			.filter((k) => k.se.completedAt)
			.sort((a, b) => (a.se.completedAt! < b.se.completedAt! ? 1 : -1))[0];
		update(ctx, stepExecution, op.id, {
			status: op.signoffs.length ? 'awaiting_signoff' : 'completed',
			completedAt: now(),
			completedById: last?.se.completedById ?? null
		});
	}
	m = loadModel(ctx.db, executionId);
	st = holdState(ctx.db, m);
	for (const r of m.rows) {
		if (!r.isContingency && !isTerminal(r.se.status)) return false;
		// A touched contingency step blocks completion; an untouched one does not.
		if (r.isContingency && r.se.status === 'awaiting_signoff') return false;
	}
	if (st.all.length) return false;
	update(ctx, execution, executionId, { status: 'completed', completedAt: now() });
	publish({ type: 'instance_completed', data: { executionId } });
	return true;
}

function requireActive(m: Model) {
	if (!isActive(m.exec)) throw refuse('Execution is not active', 409);
}

// ---------------------------------------------------------------- sign

export function signStep(
	ctx: Ctx,
	input: { id: number; stepId: number; slot: number; dataCaptured?: Record<string, unknown> | null; notes?: string | null }
): SignResult {
	const userId = actorUserId(ctx.actor);
	let m = loadModel(ctx.db, input.id);
	requireActive(m);
	const row = getRow(m, input.stepId);
	const defs = row.signoffs;
	let st = holdState(ctx.db, m);
	if (defs.length === 0) {
		// An OP without sign-offs completes by itself when its sub-steps do.
		const waiting = completeBlockers(m, st, row);
		if (waiting.length) throw refuse(describeBlockers('complete', waiting));
		throw refuse('This OP has no sign-offs; it completes when its sub-steps do');
	}
	if (input.slot < 0 || input.slot >= defs.length) throw new OpalError(404, 'not_found', `No sign-off ${input.slot} on this step`);

	const signed = signedSlots(ctx.db, row.id);
	const status = row.se.status;
	if (signed.has(input.slot)) {
		if (input.slot === 0 && status === 'awaiting_signoff') throw refuse('Step is complete and awaiting sign-off');
		if (input.slot === 0) throw refuse('Step already completed');
		throw refuse(`${defs[input.slot]!.label} already signed`);
	}
	if (status === 'skipped') throw refuse('Cannot sign a skipped step');
	if (status === 'completed') throw refuse(input.slot === 0 ? 'Step already completed' : 'Step already signed off');

	const role = defs[input.slot]!.role;
	const holder = userId === null ? new Set<string>(['admin']) : roleNamesOf(ctx.db, userId);
	if (role && !holdsSlotRole(holder, role)) throw forbidden(`Requires role ${role}`);

	const gate = slotGate(m, st, row, input.slot, new Set(signed.keys()), undefined, true);
	if (!gate.canSign) {
		throw refuse(describeBlockers(input.slot === 0 ? 'complete' : 'sign off', gate.blockers));
	}

	let started = false;
	if (input.slot === 0) {
		const problems = captureProblems(row, input.dataCaptured);
		const first = Object.values(problems)[0];
		if (first) throw new OpalError(422, 'invalid_input', first, problems);
		started = markInWork(ctx, m);
	}

	const at = now();
	insert(ctx, signoff, {
		stepExecutionId: row.id,
		slot: input.slot,
		label: defs[input.slot]!.label,
		role: defs[input.slot]!.role,
		signedById: userId,
		signedAt: at
	});
	const last = signed.size + 1 >= defs.length;
	const patch: Partial<typeof stepExecution.$inferInsert> = { status: last ? 'completed' : 'awaiting_signoff' };
	if (input.slot === 0) {
		if (status === 'pending') {
			patch.completedAt = at;
			patch.completedById = userId;
			if (row.se.startedAt === null) patch.startedAt = at;
		}
		if (input.dataCaptured && Object.keys(input.dataCaptured).length) patch.dataCaptured = input.dataCaptured;
	}
	update(ctx, stepExecution, row.id, patch);
	if (input.slot === 0 && input.notes?.trim()) addNote(ctx, { id: input.id, stepId: row.id, body: input.notes });

	const completed = checkCompletion(ctx, input.id);
	m = loadModel(ctx.db, input.id);
	publish({ type: 'step_completed', data: { executionId: input.id, stepId: row.id } });
	return signResult(ctx, m, row.id, input.slot, last, started, completed);
}

function signResult(ctx: Ctx, m: Model, stepId: number, slot: number, stepCompleted: boolean, started: boolean, completed: boolean): SignResult {
	const row = getRow(m, stepId);
	const signed = signedSlots(ctx.db, stepId);
	const people = personRefs(ctx.db, [...signed.values()].map((s) => s.signedById).filter((x): x is number => x !== null));
	return {
		step: stepState(ctx.db, row),
		slot,
		stepCompleted,
		executionStarted: started,
		executionCompleted: completed,
		signoffs: row.signoffs.map((d, n) => {
			const rec = signed.get(n);
			return {
				slot: n,
				label: rec?.label ?? d.label,
				role: rec ? rec.role : d.role,
				signedBy: rec?.signedById != null ? (people.get(rec.signedById) ?? null) : null,
				signedAt: rec?.signedAt ?? null
			};
		})
	};
}

/** The next unsigned slot after slot 0, for a step that awaits sign-off. */
export function signNext(ctx: Ctx, input: { id: number; stepId: number }): SignResult {
	const m = loadModel(ctx.db, input.id);
	const row = getRow(m, input.stepId);
	const status = row.se.status;
	if (status === 'completed') throw refuse('Step already signed off');
	if (status === 'pending') {
		throw refuse(row.level === 0 ? 'Step has sub-steps that are not yet complete' : 'Step must be completed before it can be signed off');
	}
	const signed = signedSlots(ctx.db, row.id);
	let next: number | null = null;
	for (let n = signed.has(0) ? 1 : 0; n < row.signoffs.length; n++) {
		if (!signed.has(n)) {
			next = n;
			break;
		}
	}
	if (next === null) throw refuse(`Cannot sign off step in ${status} status`);
	return signStep(ctx, { id: input.id, stepId: input.stepId, slot: next });
}

// ---------------------------------------------------------------- skip

export function skipStep(ctx: Ctx, input: { id: number; stepId: number; reason?: string | null }): SignResult {
	const userId = actorUserId(ctx.actor);
	let m = loadModel(ctx.db, input.id);
	requireActive(m);
	const row = getRow(m, input.stepId);
	if (isTerminal(row.se.status)) throw refuse(row.se.status === 'skipped' ? 'Step already skipped' : 'Cannot skip completed step');
	const st = holdState(ctx.db, m);
	const holds: Blocker[] = skipBlockers(m, st, row);
	if (holds.length) throw refuse(describeBlockers('skip', holds));
	const started = markInWork(ctx, m);
	const at = now();
	update(ctx, stepExecution, row.id, {
		status: 'skipped',
		completedAt: at,
		completedById: userId,
		skipReason: input.reason?.trim() || null
	});
	const completed = checkCompletion(ctx, input.id);
	m = loadModel(ctx.db, input.id);
	publish({ type: 'step_completed', data: { executionId: input.id, stepId: row.id } });
	return signResult(ctx, m, row.id, 0, true, started, completed);
}

// ---------------------------------------------------------------- notes

/** Append a note. A record, not a control: any step state, any execution state. */
export function addNote(ctx: Ctx, input: { id: number; stepId: number; body: string }) {
	const text = input.body.trim();
	if (!text) throw new OpalError(422, 'invalid_input', 'Note body is empty', { body: 'Note body is empty' });
	const m = loadModel(ctx.db, input.id);
	const row = getRow(m, input.stepId);
	const n = insert(ctx, stepNote, { stepExecutionId: row.id, authorId: actorUserId(ctx.actor), body: text });
	const author = n.authorId === null ? null : (personRefs(ctx.db, [n.authorId]).get(n.authorId) ?? null);
	return { id: n.id, stepId: row.id, author, createdAt: n.createdAt, body: n.body };
}

