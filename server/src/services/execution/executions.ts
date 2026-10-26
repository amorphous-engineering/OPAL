/** Executions (work orders): list, cut preview, cut, read, edit, abort. */
import {
	type CutPreview,
	type Execution,
	type ExecutionRow as ExecutionRowOut,
	type ExecutionStatus,
	OpalError,
	type Qty,
	conflict,
	formatQty,
	now,
	parseQty
} from '@opal/shared';
import { and, asc, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import { personRefs } from '../org/people.ts';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	designatorSequence,
	execution,
	executionOutput,
	executionParticipant,
	issue,
	part,
	procedure,
	procedureVersion,
	signoff,
	stepExecution
} from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';
import { nextDesignator, nextSerial } from '../designators.ts';
import { createStockRecord, onHandByPart } from '../inventory/index.ts';
import { blockingSql } from '../issues/state.ts';
import { projectRefs, requireActiveProject } from '../org/projects.ts';
import { ensurePartsActive } from '../parts/lifecycle.ts';
import { publish } from '../platform/index.ts';
import { procedureRow } from '../procedures/draft.ts';
import { versionForExecution } from '../procedures/versions.ts';
import { holdState } from './holds.ts';
import { claimsFor } from './presence.ts';
import { type ExecutionRow, type Model, executionRow, isActive, loadModel, progress } from './model.ts';
import { stepStates, userNames } from './present.ts';

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

export const PRIORITY_RANK = { normal: 0, high: 1, urgent: 2 } as const;

// ---------------------------------------------------------------- present

function presentRows(db: Db, rows: ExecutionRow[]): ExecutionRowOut[] {
	if (!rows.length) return [];
	const projects = projectRefs(db, rows.map((r) => r.projectId));
	const procs = new Map(
		db
			.select()
			.from(procedure)
			.where(inArray(procedure.id, [...new Set(rows.map((r) => r.procedureId))]))
			.all()
			.map((p) => [p.id, p])
	);
	const versions = new Map(
		db
			.select({ id: procedureVersion.id, n: procedureVersion.versionNumber })
			.from(procedureVersion)
			.where(inArray(procedureVersion.id, [...new Set(rows.map((r) => r.versionId))]))
			.all()
			.map((v) => [v.id, v.n])
	);
	const names = userNames(db, rows.map((r) => r.createdById));
	return rows.map((e) => {
		const m = loadModel(db, e.id);
		const prog = progress(m);
		const held = isActive(e) ? holdState(db, m).all.map((i) => i.issueNumber) : [];
		const claimNames = personRefs(db, claimsFor(db, m).map((c) => c.userId));
		return {
			id: e.id,
			woNumber: e.woNumber,
			projectId: e.projectId,
			projectCode: projects.get(e.projectId)?.code ?? '',
			procedureId: e.procedureId,
			procedureNumber: procs.get(e.procedureId)!.templateNumber,
			procedureName: procs.get(e.procedureId)!.name,
			versionId: e.versionId,
			versionNumber: versions.get(e.versionId) ?? 0,
			status: e.status,
			priority: e.priority,
			createdAt: e.createdAt,
			startedAt: e.startedAt,
			completedAt: e.completedAt,
			scheduledStartAt: e.scheduledStartAt,
			targetCompletionAt: e.targetCompletionAt,
			createdBy: e.createdById === null ? null : (names.get(e.createdById) ?? null),
			progressDone: prog.done,
			progressTotal: prog.total,
			heldBy: held,
			working: claimsFor(db, m).map((c) => ({
				userId: c.userId,
				name: claimNames.get(c.userId)?.name ?? null,
				avatarUrl: claimNames.get(c.userId)?.avatarUrl ?? null,
				stepNumber: m.byId.get(c.stepId)?.number ?? null
			}))
		};
	});
}

const durationSeconds = (e: ExecutionRow) =>
	e.startedAt && e.completedAt ? Math.round((Date.parse(e.completedAt) - Date.parse(e.startedAt)) / 1000) : null;

export function presentExecution(db: Db, m: Model): Execution {
	const base = presentRows(db, [m.exec])[0]!;
	return {
		...base,
		procedureType: m.snapshot.procedure.procedureType,
		versionCreatedAt: m.version.createdAt,
		durationSeconds: durationSeconds(m.exec),
		active: isActive(m.exec),
		steps: stepStates(db, m)
	};
}

export function getExecution(ctx: Pick<Ctx, 'db'>, id: number): Execution {
	return presentExecution(ctx.db, loadModel(ctx.db, id));
}

// ---------------------------------------------------------------- list

const SORTS = {
	workOrder: execution.woNumber,
	procedure: sql`(SELECT name FROM procedure WHERE procedure.id = ${execution.procedureId})`,
	status: execution.status,
	created: execution.id,
	target: execution.targetCompletionAt,
	priority: sql`CASE ${execution.priority} WHEN 'urgent' THEN 2 WHEN 'high' THEN 1 ELSE 0 END`
} as const;

export function listExecutions(
	ctx: Ctx,
	input: {
		cursor?: string;
		limit: number;
		status?: string;
		procedureId?: number;
		projectId?: number;
		q?: string;
		mine?: 'true' | 'false';
		held?: 'true' | 'false';
		sort?: keyof typeof SORTS;
		dir: 'asc' | 'desc';
	}
) {
	const me = actorUserId(ctx.actor);
	const term = input.q ? `%${input.q}%` : null;
	const common = (): (SQL | undefined)[] => [
		input.procedureId ? eq(execution.procedureId, input.procedureId) : undefined,
		input.projectId ? eq(execution.projectId, input.projectId) : undefined,
		term
			? or(
					like(execution.woNumber, term),
					inArray(
						execution.procedureId,
						ctx.db
							.select({ id: procedure.id })
							.from(procedure)
							.where(or(like(procedure.name, term), like(procedure.templateNumber, term)))
					)
				)
			: undefined,
		input.mine === 'true' && me !== null
			? or(
					eq(execution.createdById, me),
					inArray(execution.id, ctx.db.select({ id: executionParticipant.executionId }).from(executionParticipant).where(eq(executionParticipant.userId, me))),
					inArray(
						execution.id,
						ctx.db.select({ id: stepExecution.executionId }).from(stepExecution).where(eq(stepExecution.completedById, me))
					),
					inArray(
						execution.id,
						ctx.db
							.select({ id: stepExecution.executionId })
							.from(signoff)
							.innerJoin(stepExecution, eq(stepExecution.id, signoff.stepExecutionId))
							.where(eq(signoff.signedById, me))
					)
				)
			: undefined,
		input.held === 'true'
			? inArray(
					execution.id,
					ctx.db.select({ id: issue.executionId }).from(issue).where(and(blockingSql, sql`${issue.executionId} IS NOT NULL`)) as never
				)
			: undefined
	];
	const wanted = input.status ? input.status.split(',').map((s) => s.trim()).filter(Boolean) : [];
	const where = and(...common(), wanted.length ? inArray(execution.status, wanted as ExecutionStatus[]) : undefined);
	const total = ctx.db.select({ n: sql<number>`count(*)` }).from(execution).where(where).get()!.n;
	const counts: Record<string, number> = { cut: 0, in_work: 0, completed: 0, aborted: 0 };
	for (const r of ctx.db
		.select({ s: execution.status, n: sql<number>`count(*)` })
		.from(execution)
		.where(and(...common()))
		.groupBy(execution.status)
		.all()) {
		counts[r.s] = r.n;
	}
	const col = SORTS[input.sort ?? 'created'];
	const offset = Math.max(0, Number(input.cursor) || 0);
	const rows = ctx.db
		.select()
		.from(execution)
		.where(where)
		.orderBy((input.dir === 'asc' ? asc : desc)(col), desc(execution.id))
		.limit(input.limit + 1)
		.offset(offset)
		.all();
	return {
		items: presentRows(ctx.db, rows.slice(0, input.limit)),
		next: rows.length > input.limit ? String(offset + input.limit) : null,
		total,
		counts
	};
}

// ---------------------------------------------------------------- cut preview

/** The serials the next cut would take, without taking them. */
function peekSerials(db: Db, partNumber: string, n: number): string[] {
	const last = db.select().from(designatorSequence).where(eq(designatorSequence.prefix, `SN-${partNumber}`)).get()?.lastValue ?? 0;
	return Array.from({ length: n }, (_, i) => String(last + i + 1).padStart(3, '0'));
}

export function previewCut(
	ctx: Pick<Ctx, 'db'>,
	input: { procedureId: number; versionId?: number; quantity: number }
): CutPreview {
	const proc = procedureRow(ctx.db, input.procedureId);
	const version = versionForExecution(ctx, input.procedureId, input.versionId);
	const snap = version.content;
	const versions = ctx.db
		.select()
		.from(procedureVersion)
		.where(eq(procedureVersion.procedureId, proc.id))
		.orderBy(desc(procedureVersion.versionNumber))
		.all();
	const partIds = [...new Set([...snap.kit.map((k) => k.partId), ...snap.steps.flatMap((s) => s.kit.map((k) => k.partId)), ...snap.outputs.map((o) => o.partId)])];
	const parts = new Map(
		partIds.length ? ctx.db.select().from(part).where(inArray(part.id, partIds)).all().map((p) => [p.id, p]) : []
	);
	const onHand = onHandByPart(ctx, partIds);
	const have = (id: number) => (onHand.get(id) ?? 0) as Qty;
	const line = (partId: number, perWo: Qty, required: Qty, usage: 'consume' | 'tooling' | null) => {
		const p = parts.get(partId)!;
		return {
			partId,
			partNumber: p.internalPn,
			partName: p.name,
			uom: p.unitOfMeasure,
			perWorkOrder: formatQty(perWo),
			required: formatQty(required),
			available: formatQty(have(partId)),
			isAvailable: have(partId) >= required,
			usage
		};
	};
	const kit = snap.kit.map((k) => {
		const per = parseQty(k.quantity);
		return line(k.partId, per, (per * input.quantity) as Qty, null);
	});
	// Step kits aggregate by part and usage. Tooling is used and returned: one set, not one per work order.
	const agg = new Map<string, { partId: number; usage: 'consume' | 'tooling'; per: number }>();
	for (const s of snap.steps) {
		for (const k of s.kit) {
			const key = `${k.partId}:${k.usage}`;
			const cur = agg.get(key) ?? { partId: k.partId, usage: k.usage, per: 0 };
			cur.per += parseQty(k.quantity);
			agg.set(key, cur);
		}
	}
	const stepKit = [...agg.values()]
		.sort((a, b) => a.partId - b.partId || a.usage.localeCompare(b.usage))
		.map((a) => line(a.partId, a.per as Qty, (a.usage === 'consume' ? a.per * input.quantity : a.per) as Qty, a.usage));
	const outputs =
		snap.procedure.procedureType === 'build'
			? snap.outputs.map((o) => ({
					partId: o.partId,
					partNumber: parts.get(o.partId)!.internalPn,
					partName: parts.get(o.partId)!.name,
					quantityEach: o.quantity,
					serials: peekSerials(ctx.db, parts.get(o.partId)!.internalPn, input.quantity)
				}))
			: [];
	return {
		procedureId: proc.id,
		procedureNumber: proc.templateNumber,
		procedureName: proc.name,
		procedureType: snap.procedure.procedureType,
		projectId: proc.projectId,
		versions: versions.map((v) => ({ id: v.id, number: v.versionNumber, createdAt: v.createdAt, isCurrent: v.id === proc.currentVersionId })),
		versionId: version.id,
		versionNumber: version.versionNumber,
		stepCount: snap.steps.length,
		opCount: snap.steps.filter((s) => s.level === 0).length,
		quantity: input.quantity,
		outputs,
		kit,
		stepKit,
		allAvailable: [...kit, ...stepKit].every((p) => p.isAvailable)
	};
}

// ---------------------------------------------------------------- cut

export function createExecutions(
	ctx: Ctx,
	input: {
		procedureId: number;
		versionId?: number;
		projectId?: number;
		quantity: number;
		priority: 'normal' | 'high' | 'urgent';
		scheduledStartAt?: string | null;
		targetCompletionAt?: string | null;
	}
): Execution & { cutIds: number[] } {
	const proc = procedureRow(ctx.db, input.procedureId);
	const version = versionForExecution(ctx, input.procedureId, input.versionId);
	const snap = version.content;
	const project = requireActiveProject(ctx.db, input.projectId ?? proc.projectId);
	// An as-built allocation is a physical reference: draft output parts block the whole cut.
	const outputs = snap.procedure.procedureType === 'build' ? snap.outputs : [];
	ensurePartsActive(ctx, outputs.map((o) => o.partId), `${proc.name} as-built allocation`);

	const ids: number[] = [];
	for (let n = 0; n < input.quantity; n++) {
		const woNumber = nextDesignator(ctx, 'WO');
		const e = insert(ctx, execution, {
			woNumber,
			projectId: project.id,
			procedureId: proc.id,
			versionId: version.id,
			status: 'cut',
			priority: input.priority,
			scheduledStartAt: iso(input.scheduledStartAt),
			targetCompletionAt: iso(input.targetCompletionAt),
			createdById: actorUserId(ctx.actor)
		});
		for (const s of snap.steps) {
			insert(ctx, stepExecution, { executionId: e.id, stepId: s.id, status: 'pending' });
		}
		for (const o of outputs) {
			const p = ctx.db.select().from(part).where(eq(part.id, o.partId)).get();
			if (!p) continue;
			const stock = createStockRecord(ctx, {
				partId: p.id,
				location: '',
				lotNumber: woNumber,
				serialNumber: nextSerial(ctx, p.internalPn),
				sourceType: 'production'
			});
			insert(ctx, executionOutput, { executionId: e.id, stockId: stock.id, quantity: parseQty(o.quantity) });
		}
		ids.push(e.id);
	}
	publish({ type: 'execution_created', data: { ids } });
	return { ...getExecution(ctx, ids[0]!), cutIds: ids };
}

// ---------------------------------------------------------------- edit, abort

export function updateExecution(
	ctx: Ctx,
	input: {
		id: number;
		projectId?: number;
		priority?: 'normal' | 'high' | 'urgent';
		scheduledStartAt?: string | null;
		targetCompletionAt?: string | null;
	}
): Execution {
	const cur = executionRow(ctx.db, input.id);
	const patch: Partial<typeof execution.$inferInsert> = {};
	if (input.projectId !== undefined && input.projectId !== cur.projectId) {
		if (!isActive(cur)) throw conflict('execution_closed', 'The project of a finished work order does not change');
		const linked = ctx.db.select({ id: issue.id }).from(issue).where(eq(issue.executionId, cur.id)).get();
		if (linked) throw conflict('has_issues', 'Issues of this work order belong to its project; move them first');
		patch.projectId = requireActiveProject(ctx.db, input.projectId).id;
	}
	if (input.priority !== undefined) patch.priority = input.priority;
	if (input.scheduledStartAt !== undefined) patch.scheduledStartAt = iso(input.scheduledStartAt);
	if (input.targetCompletionAt !== undefined) patch.targetCompletionAt = iso(input.targetCompletionAt);
	if (Object.keys(patch).length) update(ctx, execution, cur.id, patch);
	return getExecution(ctx, cur.id);
}

/** Status is derived from the work done; the only settable transition is the abort. */
export function cancelExecution(ctx: Ctx, input: { id: number; reason?: string | null }): Execution {
	const cur = executionRow(ctx.db, input.id);
	if (!isActive(cur)) {
		throw conflict('execution_closed', `Cannot abort a work order that is ${cur.status.replace('_', ' ')}; only an active work order can be aborted`);
	}
	update(ctx, execution, cur.id, { status: 'aborted', completedAt: now(), abortReason: input.reason?.trim() || null });
	return getExecution(ctx, cur.id);
}

