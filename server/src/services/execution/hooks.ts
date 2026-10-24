/**
 * What the execution area registers with other areas, once at module load: part references,
 * entity names, search, workcenter work, the overview section, report rows, the execution
 * counter of procedures, undo, and the issue seams (`issueHooks`).
 */
import type { ExecutionRef, RedlineOp, StepOption } from '@opal/shared';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { actorUserId } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	adhocStep,
	execution,
	executionOutput,
	executionParticipant,
	procedure,
	signoff,
	stepExecution,
	stepNote,
	stockRecord
} from '../../db/schema/index.ts';
import { type HoldChange, issueHooks } from '../issues/hooks.ts';
import { blockedExecutionIds } from './blocked.ts';
import { registerWorkcenterWork } from '../org/workcenters.ts';
import { registerPartReference } from '../parts/references.ts';
import { notify, registerEntity, registerReversible, registerSearchable, revertRows } from '../platform/index.ts';
import { setExecutionCounter } from '../procedures/index.ts';
import { registerOverviewSection } from '../reports/overview.ts';
import { registerExecutionReport } from '../reports/exports.ts';
import { checkCompletion } from './steps.ts';
import { PRIORITY_RANK } from './executions.ts';
import { loadModel, opRowOf } from './model.ts';

// ---------------------------------------------------------------- parts, entities, search, undo

registerPartReference({
	name: 'execution_outputs',
	count: (ctx, partId) =>
		ctx.db
			.select({ n: sql<number>`count(*)` })
			.from(executionOutput)
			.innerJoin(stockRecord, eq(stockRecord.id, executionOutput.stockId))
			.where(eq(stockRecord.partId, partId))
			.get()?.n ?? 0
});

registerEntity(execution, { label: 'Execution', ref: (r) => ({ label: r.woNumber, href: `/executions/${r.id}` }) });
registerEntity(stepExecution, { label: 'Execution step', parent: { table: execution, fk: 'executionId' } });
registerEntity(adhocStep, { label: 'Redline step', parent: { table: execution, fk: 'executionId' } });
registerEntity(signoff, { label: 'Sign-off', parent: { table: stepExecution, fk: 'stepExecutionId' } });
registerEntity(stepNote, { label: 'Step note', parent: { table: stepExecution, fk: 'stepExecutionId' } });
registerEntity(executionParticipant, { label: 'Execution participant', parent: { table: execution, fk: 'executionId' } });
registerEntity(executionOutput, { label: 'Execution output', parent: { table: execution, fk: 'executionId' } });

registerSearchable({
	type: 'execution',
	table: execution,
	columns: [execution.woNumber],
	identifier: execution.woNumber,
	hit: (r) => ({ label: r.woNumber, sublabel: r.status.replace('_', ' '), href: `/executions/${r.id}`, status: r.status })
});

registerReversible('execution.update', { revert: (ctx, rows) => revertRows(ctx, rows, { execution }) });
registerReversible('execution.cancel', { revert: (ctx, rows) => revertRows(ctx, rows, { execution }) });
registerReversible('execution.createRedline', {
	revert: (ctx, rows) => revertRows(ctx, rows, { adhoc_step: adhocStep, step_execution: stepExecution })
});

setExecutionCounter((db, ids) => {
	if (!ids.length) return new Map();
	return new Map(
		db
			.select({ id: execution.procedureId, n: count() })
			.from(execution)
			.where(inArray(execution.procedureId, ids))
			.groupBy(execution.procedureId)
			.all()
			.map((r) => [r.id, r.n])
	);
});

// ---------------------------------------------------------------- workcenters

interface Queued {
	workcenterId: number;
	exec: typeof execution.$inferSelect;
	procedureName: string;
	number: string;
	title: string;
	status: string;
}

function queuedSteps(db: Db, only?: number): Queued[] {
	const active = db.select().from(execution).where(inArray(execution.status, ['cut', 'in_work'])).all();
	const names = new Map(db.select({ id: procedure.id, name: procedure.name }).from(procedure).all().map((p) => [p.id, p.name]));
	const out: Queued[] = [];
	for (const e of active) {
		const m = loadModel(db, e.id);
		for (const r of m.rows) {
			if (r.se.status === 'completed' || r.se.status === 'skipped') continue;
			const wc = r.se.workcenterId ?? r.workcenterId;
			if (wc === null || (only !== undefined && wc !== only)) continue;
			out.push({ workcenterId: wc, exec: e, procedureName: names.get(e.procedureId) ?? '', number: r.number, title: r.title, status: r.se.status });
		}
	}
	const natural = (n: string) => n.split('.').map((p) => (/^\d+$/.test(p) ? p.padStart(6, '0') : `~${p}`)).join('.');
	return out.sort(
		(a, b) =>
			PRIORITY_RANK[b.exec.priority] - PRIORITY_RANK[a.exec.priority] ||
			Number(a.exec.targetCompletionAt === null) - Number(b.exec.targetCompletionAt === null) ||
			(a.exec.targetCompletionAt ?? '').localeCompare(b.exec.targetCompletionAt ?? '') ||
			a.exec.woNumber.localeCompare(b.exec.woNumber) ||
			natural(a.number).localeCompare(natural(b.number))
	);
}

registerWorkcenterWork({
	defaultStepCounts: () => new Map(),
	queuedCounts: (db) => {
		const out = new Map<number, number>();
		for (const q of queuedSteps(db)) out.set(q.workcenterId, (out.get(q.workcenterId) ?? 0) + 1);
		return out;
	},
	work: (db, workcenterId) => ({
		queue: queuedSteps(db, workcenterId).map((q) => ({
			instanceId: q.exec.id,
			workOrderNumber: q.exec.woNumber,
			procedureId: q.exec.procedureId,
			procedureName: q.procedureName,
			instanceStatus: q.exec.status,
			priority: PRIORITY_RANK[q.exec.priority],
			targetCompletionAt: q.exec.targetCompletionAt,
			stepNumberStr: q.number,
			stepTitle: q.title,
			stepStatus: q.status
		}))
	})
});

// ---------------------------------------------------------------- overview and reports

registerOverviewSection('executions', (ctx, { projectId }) => {
	const me = actorUserId(ctx.actor);
	const active = ctx.db
		.select()
		.from(execution)
		.where(and(inArray(execution.status, ['cut', 'in_work']), projectId ? eq(execution.projectId, projectId) : undefined))
		.all();
	const blocked = blockedExecutionIds(ctx.db, active.map((e) => e.id));
	const names = new Map(ctx.db.select({ id: procedure.id, name: procedure.name }).from(procedure).all().map((p) => [p.id, p.name]));
	const nowIso = new Date().toISOString();
	const rows = active.map((e) => {
		const m = loadModel(ctx.db, e.id);
		const total = m.rows.length;
		const done = m.rows.filter((r) => r.se.status === 'completed' || r.se.status === 'skipped').length;
		const joined =
			me !== null &&
			ctx.db
				.select({ id: executionParticipant.id })
				.from(executionParticipant)
				.where(and(eq(executionParticipant.executionId, e.id), eq(executionParticipant.userId, me)))
				.get() !== undefined;
		return {
			label: e.woNumber,
			procedure: names.get(e.procedureId) ?? null,
			status: e.status,
			stepsDone: done,
			stepsTotal: total,
			blocked: blocked.has(e.id),
			overdue: e.targetCompletionAt !== null && e.targetCompletionAt < nowIso,
			targetCompletionAt: e.targetCompletionAt,
			mine: me !== null && (e.createdById === me || joined),
			href: `/executions/${e.id}`
		};
	});
	// Needs attention first: blocked, then overdue, then mine, then in work before cut.
	const key = (r: (typeof rows)[number]) => [!r.blocked, !r.overdue, !r.mine, r.status !== 'in_work'].map(Number);
	rows.sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
		return 0;
	});
	return { items: rows.slice(0, 8), total: rows.length, flagged: rows.filter((r) => r.blocked || r.overdue).length };
});

registerExecutionReport((ctx, f) => {
	const rows = ctx.db
		.select()
		.from(execution)
		.where(
			and(
				f.status ? eq(execution.status, f.status as never) : undefined,
				f.procedureId ? eq(execution.procedureId, f.procedureId) : undefined,
				f.projectId ? eq(execution.projectId, f.projectId) : undefined
			)
		)
		.all();
	const names = new Map(ctx.db.select({ id: procedure.id, name: procedure.name }).from(procedure).all().map((p) => [p.id, p.name]));
	return rows.map((e) => {
		const m = loadModel(ctx.db, e.id);
		const done = m.rows.filter((r) => r.se.status === 'completed' || r.se.status === 'skipped').length;
		return {
			id: e.id,
			projectId: e.projectId,
			procedure: names.get(e.procedureId) ?? null,
			version: m.version.versionNumber,
			workOrder: e.woNumber,
			status: e.status,
			priority: e.priority,
			createdAt: e.createdAt,
			startedAt: e.startedAt,
			completedAt: e.completedAt,
			stepsCompleted: done,
			stepsTotal: m.rows.length
		};
	});
});

// ---------------------------------------------------------------- issue seams

const stepRow = (ctx: Pick<Ctx, 'db'>, id: number) => ctx.db.select().from(stepExecution).where(eq(stepExecution.id, id)).get();

issueHooks.resolveStep = (ctx, stepId) => {
	const r = stepRow(ctx, stepId);
	return r ? { executionId: r.executionId } : null;
};
issueHooks.executionExists = (ctx, id) =>
	ctx.db.select({ id: execution.id }).from(execution).where(eq(execution.id, id)).get() !== undefined;

issueHooks.describe = (ctx, q) => {
	const executions = new Map<number, ExecutionRef>();
	const steps = new Map<number, string>();
	const execIds = new Set(q.executionIds);
	const byExec = new Map<number, number[]>();
	for (const sid of q.stepIds) {
		const r = stepRow(ctx, sid);
		if (!r) continue;
		execIds.add(r.executionId);
		byExec.set(r.executionId, [...(byExec.get(r.executionId) ?? []), sid]);
	}
	for (const id of execIds) {
		const e = ctx.db.select().from(execution).where(eq(execution.id, id)).get();
		if (!e) continue;
		const p = ctx.db.select({ name: procedure.name }).from(procedure).where(eq(procedure.id, e.procedureId)).get();
		executions.set(id, { id, label: e.woNumber, procedureId: e.procedureId, procedureName: p?.name ?? null });
		if (byExec.has(id)) {
			const m = loadModel(ctx.db, id);
			for (const sid of byExec.get(id)!) {
				const row = m.byId.get(sid);
				if (row) steps.set(sid, row.number);
			}
		}
	}
	return { executions, steps };
};

issueHooks.stepOptions = (ctx, executionId): StepOption[] =>
	loadModel(ctx.db, executionId).rows.map((r) => ({ id: r.id, label: r.number, title: r.title }));

issueHooks.detailExtras = (ctx, i) => {
	if (i.executionId === null) return { raisedOpOrder: null, risks: [], redlineOps: [] };
	const m = loadModel(ctx.db, i.executionId);
	const raised = i.raisedStepId === null ? undefined : m.byId.get(i.raisedStepId);
	const redlineOps: RedlineOp[] = m.rows
		.filter((r) => r.level === 0 && r.redline?.issueId === i.id)
		.map((r) => ({ stepNumber: r.id, label: r.number, title: r.title, status: r.se.status }));
	return { raisedOpOrder: raised ? opRowOf(m, raised).id : null, risks: [], redlineOps };
};

/** Everyone who worked the execution: who cut it and who completed or signed any step. */
export function operators(db: Db, executionId: number): number[] {
	const ids = new Set<number>();
	const e = db.select().from(execution).where(eq(execution.id, executionId)).get();
	if (e?.createdById != null) ids.add(e.createdById);
	for (const r of db.select({ c: stepExecution.completedById }).from(stepExecution).where(eq(stepExecution.executionId, executionId)).all()) {
		if (r.c !== null) ids.add(r.c);
	}
	for (const r of db
		.select({ s: signoff.signedById })
		.from(signoff)
		.innerJoin(stepExecution, eq(stepExecution.id, signoff.stepExecutionId))
		.where(eq(stepExecution.executionId, executionId))
		.all()) {
		if (r.s !== null) ids.add(r.s);
	}
	return [...ids];
}

/**
 * A hold changed. Holds are derived, so only a real transition is reported: a second blocking
 * issue on a blocked run is silent, and the run is unblocked when the last blocker clears.
 * Releasing may be the last thing between the run and completion, so completion is rechecked.
 */
function onHoldChanged(ctx: Ctx, ch: HoldChange) {
	const e = ctx.db.select().from(execution).where(eq(execution.id, ch.executionId)).get();
	if (!e) return;
	if (!ch.isBlocking) checkCompletion(ctx, ch.executionId);
	if (ch.wasBlocking === ch.isBlocking) return;
	const recipients = operators(ctx.db, ch.executionId);
	const href = `/executions/${e.id}`;
	if (ch.isBlocking) {
		notify(ctx, {
			recipients,
			kind: 'execution_blocked',
			title: `${e.woNumber} is blocked`,
			body: `${ch.issue.issueNumber} — ${ch.issue.title}`,
			href,
			subjectType: 'execution',
			subjectId: e.id,
			priority: 'high'
		});
	} else {
		notify(ctx, {
			recipients,
			kind: 'execution_unblocked',
			title: `${e.woNumber} is unblocked`,
			body: 'Every blocking issue is dispositioned or closed.',
			href,
			subjectType: 'execution',
			subjectId: e.id,
			priority: 'high'
		});
	}
}
issueHooks.holdChanged.push(onHoldChanged);

