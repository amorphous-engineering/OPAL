/**
 * Redlines: ad-hoc OPs inserted into a running execution to rework a non-conformance. A
 * redline OP gates the OP it was raised at; it lives in `adhoc_step` because it has no
 * snapshot entry. R-numbers count per host OP: `4R1`, `4R1.1`.
 */
import { OpalError, type ProcedureDataSchema, type Redline, conflict, notFound } from '@opal/shared';
import { eq, inArray, or } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	adhocStep,
	dataPoint,
	executionParticipant,
	issue,
	signoff,
	stepExecution,
	stepNote,
	stockMove,
	workInterval
} from '../../db/schema/index.ts';
import { insert, remove } from '../../write.ts';
import { detachAll } from '../platform/index.ts';
import { type Model, type Row, isActive, isTerminal, loadModel, opRowOf } from './model.ts';
import { stepState } from './present.ts';
import { checkDataFields } from '../procedures/steps.ts';

function present(db: Db, m: Model, op: Row): Redline {
	const issueRow = db.select().from(issue).where(eq(issue.id, op.adhoc!.issueId)).get();
	const kids = m.children.get(op.id) ?? [];
	return {
		id: op.id,
		executionId: m.exec.id,
		issueId: op.adhoc!.issueId,
		issueNumber: issueRow?.issueNumber ?? null,
		hostId: op.redline?.hostId ?? null,
		opStepId: op.id,
		number: op.number,
		title: op.title,
		status: op.se.status,
		createdAt: op.adhoc!.createdAt,
		steps: kids.map((k) => stepState(db, k))
	};
}

export function createRedline(
	ctx: Ctx,
	input: {
		id: number;
		issueId: number;
		title: string;
		steps: { title: string; instructions?: string | null; dataSchema?: ProcedureDataSchema | null; requiresSignoff: boolean }[];
	}
): Redline {
	const m = loadModel(ctx.db, input.id);
	if (!isActive(m.exec)) throw conflict('execution_closed', 'Redlines go into an active execution');
	const nc = ctx.db.select().from(issue).where(eq(issue.id, input.issueId)).get();
	if (!nc) throw notFound('Issue');
	if (nc.issueType !== 'non_conformance') throw new OpalError(409, 'not_nc', 'Redlines can only be attached to an NC');
	if (nc.raisedStepId === null) throw new OpalError(409, 'nc_no_step', 'NC is not attached to a step; cannot create redline');
	const raised = m.byId.get(nc.raisedStepId);
	if (!raised) throw new OpalError(409, 'nc_other_execution', 'NC does not belong to this execution');
	let host = opRowOf(m, raised);
	// A redline raised at a redline step reworks the OP that redline gates.
	if (host.redline) {
		const original = host.redline.hostId === null ? undefined : m.byId.get(host.redline.hostId);
		if (!original) throw new OpalError(409, 'nc_no_host', 'Host step has no parent op to attach the redline to');
		host = original;
	}
	const seq = m.rows.filter((r) => r.level === 0 && r.redline?.hostId === host.id).length + 1;
	const number = `${host.number}R${seq}`;
	const by = actorUserId(ctx.actor);
	const op = insert(ctx, adhocStep, {
		executionId: m.exec.id,
		issueId: nc.id,
		parentId: null,
		hostStepId: host.templateStepId,
		position: 0,
		number,
		title: input.title.trim(),
		createdById: by
	});
	insert(ctx, stepExecution, { executionId: m.exec.id, adhocStepId: op.id, status: 'pending' });
	input.steps.forEach((s, n) => {
		checkDataFields(s.dataSchema, null);
		const sub = insert(ctx, adhocStep, {
			executionId: m.exec.id,
			issueId: nc.id,
			parentId: op.id,
			hostStepId: host.templateStepId,
			position: n,
			number: `${number}.${n + 1}`,
			title: s.title.trim(),
			instructions: s.instructions ?? null,
			dataSchema: s.dataSchema?.fields?.length ? s.dataSchema : null,
			signoffs: s.requiresSignoff ? [{ role: null }, { role: null }] : null,
			createdById: by
		});
		insert(ctx, stepExecution, { executionId: m.exec.id, adhocStepId: sub.id, status: 'pending' });
	});
	const mm = loadModel(ctx.db, input.id);
	return present(ctx.db, mm, [...mm.rows].find((r) => r.adhoc?.id === op.id)!);
}

export function listRedlines(ctx: Pick<Ctx, 'db'>, executionId: number): Redline[] {
	const m = loadModel(ctx.db, executionId);
	return m.rows.filter((r) => r.level === 0 && r.adhoc).map((r) => present(ctx.db, m, r));
}

/** Delete a redline OP and its steps, only while nothing in it started. */
export function deleteRedline(ctx: Ctx, input: { id: number; redlineId: number }): { ok: true } {
	const m = loadModel(ctx.db, input.id);
	const op = m.rows.find((r) => r.level === 0 && r.adhoc && r.id === input.redlineId);
	if (!op) throw notFound('Redline op');
	const kids = m.children.get(op.id) ?? [];
	if (kids.some((k) => k.se.status !== 'pending')) {
		throw new OpalError(409, 'redline_started', 'Cannot delete redline op: one or more sub-steps already started');
	}
	if (op.se.status !== 'pending' || isTerminal(op.se.status)) {
		throw new OpalError(409, 'redline_started', 'Cannot delete redline op: op is no longer pending');
	}
	const stepIds = [op.id, ...kids.map((k) => k.id)];
	// Notes, labor, signatures, data and claims hang off a step that is still `pending`, and the
	// FK cascades would erase them with no audit row. Rule 7: a record that holds work is kept.
	const db = ctx.db;
	const worked =
		[op, ...kids].some((r) => r.se.firstFocusedAt !== null || r.se.dataCaptured != null || r.se.startedAt !== null || r.se.skipReason !== null) ||
		db.select({ id: stepNote.id }).from(stepNote).where(inArray(stepNote.stepExecutionId, stepIds)).get() ||
		db.select({ id: workInterval.id }).from(workInterval).where(inArray(workInterval.opStepId, stepIds)).get() ||
		db.select({ id: signoff.id }).from(signoff).where(inArray(signoff.stepExecutionId, stepIds)).get() ||
		db.select({ id: dataPoint.id }).from(dataPoint).where(inArray(dataPoint.stepExecutionId, stepIds)).get() ||
		db.select({ id: executionParticipant.id }).from(executionParticipant).where(inArray(executionParticipant.focusStepId, stepIds)).get() ||
		db.select({ id: stockMove.id }).from(stockMove).where(inArray(stockMove.stepExecutionId, stepIds)).get() ||
		db
			.select({ id: issue.id })
			.from(issue)
			.where(or(inArray(issue.raisedStepId, stepIds), inArray(issue.containmentStepId, stepIds)))
			.get();
	if (worked) throw new OpalError(409, 'redline_started', 'Cannot delete redline op: work is recorded on it');
	// Nothing records work now, so the rows below are empty drafts. Each goes through remove().
	for (const id of stepIds) detachAll(ctx, { type: 'step_execution', id });
	for (const id of stepIds) remove(ctx, stepExecution, id);
	for (const k of kids) remove(ctx, adhocStep, k.adhoc!.id);
	remove(ctx, adhocStep, op.adhoc!.id);
	return { ok: true };
}
