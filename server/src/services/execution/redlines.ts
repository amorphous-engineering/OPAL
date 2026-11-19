/**
 * Redlines: ad-hoc OPs inserted into a running execution to rework a non-conformance. A
 * redline OP gates the OP it was raised at; it lives in `adhoc_step` because it has no
 * snapshot entry. R-numbers count per host OP: `4R1`, `4R1.1`.
 *
 * A redline starts as a draft: pencil, visible on the floor and not workable. Signing the
 * issue's disposition releases its drafts with it, so the hold passes straight to the redline
 * gate. Released, a redline is pen. Its steps may consume parts, and it may replace lines of the
 * planned kit, which read struck from then on; the published version itself never changes.
 */
import {
	OpalError,
	type ProcedureDataSchema,
	type Redline,
	type RedlineKitLine,
	type RedlineStrike,
	conflict,
	notFound,
	now,
	parseQty
} from '@opal/shared';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	adhocStep,
	dataPoint,
	executionParticipant,
	issue,
	part,
	signoff,
	stepExecution,
	stepNote,
	stockMove,
	workInterval
} from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { ensurePartsActive } from '../parts/lifecycle.ts';

const invalid = (field: string, message: string) => new OpalError(422, 'invalid_input', message, { [field]: message });
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
		releasedAt: op.adhoc!.releasedAt,
		strikes: op.adhoc!.strikes ?? [],
		steps: kids.map((k) => stepState(db, k))
	};
}

type StepInput = {
	title: string;
	instructions?: string | null;
	dataSchema?: ProcedureDataSchema | null;
	requiresSignoff: boolean;
	kit?: RedlineKitLine[];
};

const findOp = (m: Model, redlineId: number): Row => {
	const op = m.rows.find((r) => r.level === 0 && r.adhoc && r.id === redlineId);
	if (!op) throw notFound('Redline op');
	return op;
};

/** The NC a redline answers: open, raised at a step of this execution. */
function authorisingNc(ctx: Ctx, m: Model, issueId: number) {
	const nc = ctx.db.select().from(issue).where(eq(issue.id, issueId)).get();
	if (!nc) throw notFound('Issue');
	if (nc.issueType !== 'non_conformance') throw new OpalError(409, 'not_nc', 'Redlines can only be attached to an NC');
	if (nc.status !== 'open') throw new OpalError(409, 'nc_closed', `${nc.issueNumber} is ${nc.status}; a redline answers an open NC`);
	if (nc.raisedStepId === null) throw new OpalError(409, 'nc_no_step', 'NC is not attached to a step; cannot create redline');
	if (!m.byId.get(nc.raisedStepId)) throw new OpalError(409, 'nc_other_execution', 'NC does not belong to this execution');
	return nc;
}

/**
 * The planned kit lines a redline may replace: a line of a snapshot step's kit, or of the
 * procedure kit, not already replaced by another released redline.
 */
function checkStrikes(m: Model, strikes: RedlineStrike[], self: number | null): RedlineStrike[] {
	const seen = new Set<string>();
	const taken = new Map<string, string>();
	for (const r of m.rows) {
		if (r.level !== 0 || !r.adhoc || r.draft || r.id === self) continue;
		for (const x of r.adhoc.strikes ?? []) taken.set(`${x.stepId}:${x.partId}`, r.number);
	}
	for (const x of strikes) {
		const k = `${x.stepId}:${x.partId}`;
		if (seen.has(k)) throw invalid('strikes', 'A kit line is replaced once');
		seen.add(k);
		if (taken.has(k)) throw invalid('strikes', `That kit line is already replaced by ${taken.get(k)}`);
		if (x.stepId === null) {
			if (!m.snapshot.kit.some((l) => l.partId === x.partId)) throw invalid('strikes', 'That part is not in the procedure kit');
			continue;
		}
		const row = m.byId.get(x.stepId);
		if (!row || row.adhoc) throw invalid('strikes', 'A redline replaces lines of the planned kit only');
		if (!row.kit.some((l) => l.partId === x.partId)) throw invalid('strikes', `That part is not in the kit of ${row.number}`);
	}
	return strikes;
}

function checkKits(ctx: Ctx, steps: StepInput[]) {
	const parts = steps.flatMap((s) => s.kit ?? []);
	for (const k of parts) if (parseQty(k.quantity) <= 0) throw invalid('steps', 'A kit quantity is more than zero');
	const ids = [...new Set(parts.map((k) => k.partId))];
	if (ids.length) {
		const found = ctx.db.select({ id: part.id }).from(part).where(inArray(part.id, ids)).all().length;
		if (found !== ids.length) throw notFound('Part');
	}
	ensurePartsActive(ctx, ids, 'redline kit');
}

function writeSteps(ctx: Ctx, m: Model, op: typeof adhocStep.$inferSelect, steps: StepInput[]) {
	const by = actorUserId(ctx.actor);
	steps.forEach((s, n) => {
		checkDataFields(s.dataSchema, null);
		const sub = insert(ctx, adhocStep, {
			executionId: m.exec.id,
			issueId: op.issueId,
			parentId: op.id,
			hostStepId: op.hostStepId,
			position: n,
			number: `${op.number}.${n + 1}`,
			title: s.title.trim(),
			instructions: s.instructions ?? null,
			dataSchema: s.dataSchema?.fields?.length ? s.dataSchema : null,
			signoffs: s.requiresSignoff ? [{ role: null }, { role: null }] : null,
			kit: s.kit?.length ? s.kit : null,
			createdById: by
		});
		insert(ctx, stepExecution, { executionId: m.exec.id, adhocStepId: sub.id, status: 'pending' });
	});
}

/** Draft a redline. The floor cannot work it until it is released. */
export function createRedline(
	ctx: Ctx,
	input: { id: number; issueId: number; title: string; steps: StepInput[]; strikes?: RedlineStrike[] }
): Redline {
	const m = loadModel(ctx.db, input.id);
	if (!isActive(m.exec)) throw conflict('execution_closed', 'Redlines go into an active execution');
	const nc = authorisingNc(ctx, m, input.issueId);
	let host = opRowOf(m, m.byId.get(nc.raisedStepId!)!);
	// A redline raised at a redline step reworks the OP that redline gates.
	if (host.redline) {
		const original = host.redline.hostId === null ? undefined : m.byId.get(host.redline.hostId);
		if (!original) throw new OpalError(409, 'nc_no_host', 'Host step has no parent op to attach the redline to');
		host = original;
	}
	checkKits(ctx, input.steps);
	const strikes = checkStrikes(m, input.strikes ?? [], null);
	const seq = m.rows.filter((r) => r.level === 0 && r.redline?.hostId === host.id).length + 1;
	const op = insert(ctx, adhocStep, {
		executionId: m.exec.id,
		issueId: nc.id,
		parentId: null,
		hostStepId: host.templateStepId,
		position: 0,
		number: `${host.number}R${seq}`,
		title: input.title.trim(),
		strikes: strikes.length ? strikes : null,
		createdById: actorUserId(ctx.actor)
	});
	insert(ctx, stepExecution, { executionId: m.exec.id, adhocStepId: op.id, status: 'pending' });
	writeSteps(ctx, m, op, input.steps);
	const mm = loadModel(ctx.db, input.id);
	return present(ctx.db, mm, [...mm.rows].find((r) => r.adhoc?.id === op.id)!);
}

const releasedRefusal = (op: Row) => new OpalError(409, 'redline_released', `${op.number} is released; a released redline is pen`);

/** Rewrite a draft: its title, its steps and the kit lines it replaces. Nothing in a draft is worked. */
export function updateRedline(
	ctx: Ctx,
	input: { id: number; redlineId: number; title: string; steps: StepInput[]; strikes?: RedlineStrike[] }
): Redline {
	const m = loadModel(ctx.db, input.id);
	if (!isActive(m.exec)) throw conflict('execution_closed', 'Redlines change only in an active execution');
	const op = findOp(m, input.redlineId);
	if (!op.draft) throw releasedRefusal(op);
	checkKits(ctx, input.steps);
	const strikes = checkStrikes(m, input.strikes ?? [], op.id);
	const kids = m.children.get(op.id) ?? [];
	for (const k of kids) remove(ctx, stepExecution, k.id);
	for (const k of kids) remove(ctx, adhocStep, k.adhoc!.id);
	const row = update(ctx, adhocStep, op.adhoc!.id, { title: input.title.trim(), strikes: strikes.length ? strikes : null });
	writeSteps(ctx, m, row, input.steps);
	const mm = loadModel(ctx.db, input.id);
	return present(ctx.db, mm, findOp(mm, op.id));
}

/** Release one draft written after its issue's disposition was signed. */
export function releaseRedline(ctx: Ctx, input: { id: number; redlineId: number }): Redline {
	const m = loadModel(ctx.db, input.id);
	if (!isActive(m.exec)) throw conflict('execution_closed', 'Redlines are released only in an active execution');
	const op = findOp(m, input.redlineId);
	if (!op.draft) throw releasedRefusal(op);
	const nc = ctx.db.select().from(issue).where(eq(issue.id, op.adhoc!.issueId)).get()!;
	if (nc.status !== 'open') throw new OpalError(409, 'nc_closed', `${nc.issueNumber} is ${nc.status}`);
	if (nc.dispositionedAt === null) {
		throw new OpalError(409, 'not_dispositioned', `${nc.issueNumber} has no signed disposition; signing it releases ${op.number}`);
	}
	checkStrikes(m, op.adhoc!.strikes ?? [], op.id);
	update(ctx, adhocStep, op.adhoc!.id, { releasedAt: now(), releasedById: actorUserId(ctx.actor) });
	const mm = loadModel(ctx.db, input.id);
	return present(ctx.db, mm, findOp(mm, op.id));
}

/** Release every draft redline of an issue: called as its disposition is signed. */
export function releaseDrafts(ctx: Ctx, issueId: number): string[] {
	const drafts = ctx.db
		.select()
		.from(adhocStep)
		.where(and(eq(adhocStep.issueId, issueId), isNull(adhocStep.parentId), isNull(adhocStep.releasedAt)))
		.all();
	const at = now();
	for (const d of drafts) {
		const m = loadModel(ctx.db, d.executionId);
		const op = m.rows.find((r) => r.adhoc?.id === d.id);
		if (op) checkStrikes(m, d.strikes ?? [], op.id);
		update(ctx, adhocStep, d.id, { releasedAt: at, releasedById: actorUserId(ctx.actor) });
	}
	return drafts.map((d) => d.number);
}

/** Redline OPs of an issue that are drafts or not finished, by number. */
export function openRedlines(db: Db, issueId: number): string[] {
	const ops = db
		.select({ number: adhocStep.number, status: stepExecution.status })
		.from(adhocStep)
		.innerJoin(stepExecution, eq(stepExecution.adhocStepId, adhocStep.id))
		.where(and(eq(adhocStep.issueId, issueId), isNull(adhocStep.parentId)))
		.all();
	return ops.filter((o) => !isTerminal(o.status)).map((o) => o.number);
}

export function listRedlines(ctx: Pick<Ctx, 'db'>, executionId: number): Redline[] {
	const m = loadModel(ctx.db, executionId);
	return m.rows.filter((r) => r.level === 0 && r.adhoc).map((r) => present(ctx.db, m, r));
}

/** Delete a draft redline OP and its steps. A released redline is pen. */
export function deleteRedline(ctx: Ctx, input: { id: number; redlineId: number }): { ok: true } {
	const m = loadModel(ctx.db, input.id);
	const op = findOp(m, input.redlineId);
	if (!op.draft) throw releasedRefusal(op);
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
