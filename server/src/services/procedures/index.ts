/** Master procedures (templates): list, create, change, delete, clone, build, draft. */
import {
	type Procedure,
	type ProcedureDraft,
	type ProcedureType,
	type zProcedure,
	conflict,
	notFound,
	parseQty
} from '@opal/shared';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	kitItem,
	part,
	project,
	procedure,
	procedureOutput,
	procedureStep,
	procedureVersion,
	stepDependency,
	stepImage
} from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { nextDesignator } from '../designators.ts';
import { detachAll } from '../platform/attachments.ts';
import { type ProcedureRow, presentDraft, procedureRow, stepRows } from './draft.ts';
import { buildSnapshot, snapshotsEquivalent } from './snapshot.ts';
import { checkWorkcenter, copyAttachment, copyStepContent, invalid, normalizeCallouts, removeStepDeep } from './steps.ts';
import { writeSignoffs } from './signoffs.ts';

export type ProcedureOut = z.output<typeof zProcedure>;

// ------------------------------------------------------------------- hooks

/** The execution area registers how many executions each procedure has. */
export type ExecutionCounter = (db: Db, procedureIds: number[]) => Map<number, number>;
let executionCounter: ExecutionCounter = () => new Map();
export const setExecutionCounter = (fn: ExecutionCounter) => void (executionCounter = fn);

// ------------------------------------------------------------------- present

interface Counts {
	steps: Map<number, number>;
	ops: Map<number, number>;
	versions: Map<number, number>;
	executions: Map<number, number>;
	projects: Map<number, { code: string; name: string }>;
}

function counts(db: Db, rows: ProcedureRow[]): Counts {
	const ids = rows.map((r) => r.id);
	const out: Counts = { steps: new Map(), ops: new Map(), versions: new Map(), executions: executionCounter(db, ids), projects: new Map() };
	if (!ids.length) return out;
	for (const pr of db.select().from(project).all()) out.projects.set(pr.id, { code: pr.code, name: pr.name });
	for (const r of db
		.select({
			pid: procedureStep.procedureId,
			n: sql<number>`count(*)`,
			ops: sql<number>`sum(CASE WHEN ${procedureStep.parentStepId} IS NULL THEN 1 ELSE 0 END)`
		})
		.from(procedureStep)
		.where(inArray(procedureStep.procedureId, ids))
		.groupBy(procedureStep.procedureId)
		.all()) {
		out.steps.set(r.pid, r.n);
		out.ops.set(r.pid, r.ops);
	}
	const versionIds = rows.map((r) => r.currentVersionId).filter((x): x is number => x !== null);
	if (versionIds.length) {
		for (const v of db
			.select({ id: procedureVersion.id, n: procedureVersion.versionNumber })
			.from(procedureVersion)
			.where(inArray(procedureVersion.id, versionIds))
			.all()) {
			out.versions.set(v.id, v.n);
		}
	}
	return out;
}

function toProcedure(r: ProcedureRow, c: Counts, unpublishedChanges: boolean | null): ProcedureOut {
	const proj = c.projects.get(r.projectId);
	return {
		id: r.id,
		templateNumber: r.templateNumber,
		projectId: r.projectId,
		projectCode: proj?.code ?? '',
		projectName: proj?.name ?? '',
		name: r.name,
		description: r.description,
		procedureType: r.procedureType,
		status: r.status,
		currentVersionId: r.currentVersionId,
		currentVersionNumber: r.currentVersionId === null ? null : (c.versions.get(r.currentVersionId) ?? null),
		opCount: c.ops.get(r.id) ?? 0,
		stepCount: c.steps.get(r.id) ?? 0,
		executionCount: c.executions.get(r.id) ?? 0,
		unpublishedChanges,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	};
}

/** Does the draft differ from the current version? Null when nothing is published. */
export function hasUnpublishedChanges(ctx: Pick<Ctx, 'db'>, r: ProcedureRow): boolean | null {
	if (r.currentVersionId === null) return null;
	const current = ctx.db.select().from(procedureVersion).where(eq(procedureVersion.id, r.currentVersionId)).get();
	if (!current) return null;
	return !snapshotsEquivalent(buildSnapshot(ctx, r.id), current.content);
}

export function presentProcedure(ctx: Pick<Ctx, 'db'>, r: ProcedureRow): ProcedureOut {
	return toProcedure(r, counts(ctx.db, [r]), hasUnpublishedChanges(ctx, r));
}

// ------------------------------------------------------------------- list

const SORT = {
	number: (a: ProcedureOut, b: ProcedureOut) => a.templateNumber.localeCompare(b.templateNumber),
	name: (a: ProcedureOut, b: ProcedureOut) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	status: (a: ProcedureOut, b: ProcedureOut) => a.status.localeCompare(b.status),
	type: (a: ProcedureOut, b: ProcedureOut) => a.procedureType.localeCompare(b.procedureType),
	version: (a: ProcedureOut, b: ProcedureOut) => (a.currentVersionNumber ?? 0) - (b.currentVersionNumber ?? 0),
	steps: (a: ProcedureOut, b: ProcedureOut) => a.stepCount - b.stepCount,
	executions: (a: ProcedureOut, b: ProcedureOut) => a.executionCount - b.executionCount,
	createdAt: (a: ProcedureOut, b: ProcedureOut) => a.createdAt.localeCompare(b.createdAt),
	updatedAt: (a: ProcedureOut, b: ProcedureOut) => a.updatedAt.localeCompare(b.updatedAt)
} as const;

export function list(
	ctx: Ctx,
	input: {
		cursor?: string;
		limit: number;
		q?: string;
		projectId?: number;
		status?: ProcedureRow['status'];
		procedureType?: ProcedureType;
		sort: keyof typeof SORT;
		dir: 'asc' | 'desc';
	}
) {
	const term = input.q?.trim();
	const like_ = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
	const rows = ctx.db
		.select()
		.from(procedure)
		.where(
			and(
				input.status ? eq(procedure.status, input.status) : undefined,
				input.projectId ? eq(procedure.projectId, input.projectId) : undefined,
				input.procedureType ? eq(procedure.procedureType, input.procedureType) : undefined,
				like_
					? or(
							sql`${procedure.templateNumber} LIKE ${like_} ESCAPE '\\'`,
							sql`${procedure.name} LIKE ${like_} ESCAPE '\\'`,
							sql`${procedure.description} LIKE ${like_} ESCAPE '\\'`
						)
					: undefined
			)
		)
		.all();
	const c = counts(ctx.db, rows);
	const dir = input.dir === 'asc' ? 1 : -1;
	// The list is small (templates, not records), so it sorts here: every key, including the
	// execution count the execution area supplies, sorts the same way.
	const items = rows
		.map((r) => toProcedure(r, c, null))
		.sort((a, b) => dir * SORT[input.sort](a, b) || b.id - a.id);
	const offset = Math.max(0, Number(input.cursor) || 0);
	return {
		items: items.slice(offset, offset + input.limit),
		next: items.length > offset + input.limit ? String(offset + input.limit) : null,
		total: items.length
	};
}

// ------------------------------------------------------------------- write

/** The project must exist and accept new work: an archived project is terminal. */
export function requireOpenProject(db: Db, id: number) {
	const p = db.select().from(project).where(eq(project.id, id)).get();
	if (!p) throw notFound('Project');
	if (p.state !== 'active') throw conflict('project_archived', `Project ${p.code} is archived`);
	return p;
}

export function create(
	ctx: Ctx,
	input: { projectId: number; name: string; description?: string | null; procedureType: ProcedureType }
): Procedure {
	requireOpenProject(ctx.db, input.projectId);
	const row = insert(ctx, procedure, {
		templateNumber: nextDesignator(ctx, 'T'),
		projectId: input.projectId,
		name: input.name,
		description: input.description ?? null,
		procedureType: input.procedureType,
		status: 'draft'
	});
	return presentProcedure(ctx, row);
}

export function get(ctx: Ctx, id: number): Procedure {
	return presentProcedure(ctx, procedureRow(ctx.db, id));
}

export function updateProcedure(
	ctx: Ctx,
	input: {
		id: number;
		projectId?: number;
		name?: string;
		description?: string | null;
		status?: ProcedureRow['status'];
		procedureType?: ProcedureType;
	}
): Procedure {
	const row = procedureRow(ctx.db, input.id);
	const patch: Partial<typeof procedure.$inferInsert> = {};
	if (input.projectId !== undefined && input.projectId !== row.projectId) {
		requireOpenProject(ctx.db, input.projectId);
		patch.projectId = input.projectId;
	}
	if (input.name !== undefined) patch.name = input.name;
	if (input.description !== undefined) patch.description = input.description;
	if (input.procedureType !== undefined) patch.procedureType = input.procedureType;
	if (input.status !== undefined) {
		if (input.status === 'released' && row.currentVersionId === null) {
			throw conflict('not_published', 'Publish a version before releasing this template');
		}
		patch.status = input.status;
	}
	return presentProcedure(ctx, Object.keys(patch).length ? update(ctx, procedure, row.id, patch) : row);
}

/** A procedure that was never published has nothing that references it: it goes. */
export function deleteProcedure(ctx: Ctx, id: number): void {
	const row = procedureRow(ctx.db, id);
	const published = ctx.db.select({ id: procedureVersion.id }).from(procedureVersion).where(eq(procedureVersion.procedureId, id)).get();
	if (published) {
		throw conflict('has_versions', `${row.templateNumber} was published. Mark it obsolete instead of deleting it`);
	}
	const all = stepRows(ctx.db, id);
	for (const s of all.filter((x) => x.parentStepId === null)) removeStepDeep(ctx, s, all);
	for (const k of ctx.db.select().from(kitItem).where(eq(kitItem.procedureId, id)).all()) remove(ctx, kitItem, k.id);
	for (const o of ctx.db.select().from(procedureOutput).where(eq(procedureOutput.procedureId, id)).all()) {
		remove(ctx, procedureOutput, o.id);
	}
	detachAll(ctx, { type: 'procedure', id });
	remove(ctx, procedure, id);
}

export function draft(ctx: Ctx, id: number): ProcedureDraft {
	procedureRow(ctx.db, id);
	return { procedureId: id, steps: presentDraft(ctx, id) };
}

// ------------------------------------------------------------------- clone

export function clone(
	ctx: Ctx,
	input: { id: number; newName?: string; copyKit: boolean; copyOutputs: boolean }
): Procedure {
	const source = procedureRow(ctx.db, input.id);
	const copy = insert(ctx, procedure, {
		templateNumber: nextDesignator(ctx, 'T'),
		projectId: source.projectId,
		name: input.newName ?? `Copy of ${source.name}`,
		description: source.description,
		procedureType: source.procedureType,
		status: 'draft',
		currentVersionId: null
	});
	const rows = stepRows(ctx.db, source.id);
	const map = new Map<number, number>();
	// OPs first so a sub-step always finds its parent.
	for (const s of [...rows].sort((a, b) => Number(a.parentStepId !== null) - Number(b.parentStepId !== null) || a.id - b.id)) {
		const dup = insert(ctx, procedureStep, {
			procedureId: copy.id,
			parentStepId: s.parentStepId === null ? null : map.get(s.parentStepId)!,
			isContingency: s.isContingency,
			position: s.position,
			title: s.title,
			instructions: s.instructions,
			dataSchema: s.dataSchema ? structuredClone(s.dataSchema) : null,
			signoffs: s.signoffs ? structuredClone(s.signoffs) : null,
			estimatedDurationMinutes: s.estimatedDurationMinutes,
			callouts: structuredClone(s.callouts ?? []),
			strictSequence: s.strictSequence,
			workcenterId: s.workcenterId
		});
		map.set(s.id, dup.id);
		if (input.copyKit) {
			// Images always come along; step kit lines follow the kit flag.
			copyStepContent(ctx, s.id, dup.id);
		}
	}
	if (!input.copyKit) {
		for (const [from, to] of map) copyImagesOnly(ctx, from, to);
	}
	for (const d of ctx.db.select().from(stepDependency).all()) {
		if (map.has(d.stepId) && map.has(d.dependsOnStepId)) {
			insert(ctx, stepDependency, { stepId: map.get(d.stepId)!, dependsOnStepId: map.get(d.dependsOnStepId)! });
		}
	}
	if (input.copyKit) {
		for (const k of ctx.db.select().from(kitItem).where(eq(kitItem.procedureId, source.id)).orderBy(kitItem.id).all()) {
			insert(ctx, kitItem, { procedureId: copy.id, stepId: null, partId: k.partId, quantity: k.quantity, usage: k.usage, notes: k.notes });
		}
	}
	if (input.copyOutputs) {
		for (const o of ctx.db.select().from(procedureOutput).where(eq(procedureOutput.procedureId, source.id)).orderBy(procedureOutput.id).all()) {
			insert(ctx, procedureOutput, { procedureId: copy.id, partId: o.partId, quantity: o.quantity });
		}
	}
	return presentProcedure(ctx, procedureRow(ctx.db, copy.id));
}

function copyImagesOnly(ctx: Ctx, from: number, to: number) {
	for (const img of ctx.db.select().from(stepImage).where(eq(stepImage.stepId, from)).orderBy(stepImage.position, stepImage.id).all()) {
		insert(ctx, stepImage, { stepId: to, attachmentId: copyAttachment(ctx, img.attachmentId, to), caption: img.caption, position: img.position });
	}
}

// ------------------------------------------------------------------- build

interface BuildInput {
	projectId: number;
	name: string;
	description?: string | null;
	procedureType: ProcedureType;
	steps: {
		title: string;
		instructions?: string | null;
		requiredRole?: string | null;
		requiresSignoff?: boolean;
		signoffs?: { label?: string; role?: string | null }[] | null;
		callouts?: { kind: 'caution' | 'info'; text: string }[] | null;
		strictSequence?: boolean;
		estimatedDurationMinutes?: number | null;
		workcenterId?: number | null;
		kit?: { partId: number; quantity: string; usage: 'consume' | 'tooling'; notes?: string | null }[];
	}[];
	kit: { partId: number; quantity: string }[];
	outputs: { partId: number; quantity: string }[];
}

/** A whole procedure in one call. Everything referenced is checked before anything is written. */
export function build(ctx: Ctx, input: BuildInput) {
	const partIds = new Set<number>([
		...input.kit.map((k) => k.partId),
		...input.outputs.map((o) => o.partId),
		...input.steps.flatMap((s) => (s.kit ?? []).map((k) => k.partId))
	]);
	if (partIds.size) {
		const found = new Set(ctx.db.select({ id: part.id }).from(part).where(inArray(part.id, [...partIds])).all().map((p) => p.id));
		for (const id of partIds) if (!found.has(id)) throw notFound(`Part ${id}`);
	}
	for (const s of input.steps) checkWorkcenter(ctx.db, s.workcenterId);
	const seenKit = new Set<number>();
	for (const k of input.kit) {
		if (seenKit.has(k.partId)) throw conflict('duplicate', `Part ${k.partId} twice in the kit`);
		seenKit.add(k.partId);
		if (parseQty(k.quantity) <= 0) throw invalid('invalid_input', 'Quantity must be above zero');
	}
	requireOpenProject(ctx.db, input.projectId);
	const row = insert(ctx, procedure, {
		templateNumber: nextDesignator(ctx, 'T'),
		projectId: input.projectId,
		name: input.name,
		description: input.description ?? null,
		procedureType: input.procedureType,
		status: 'draft'
	});
	let stepKitCount = 0;
	input.steps.forEach((s, position) => {
		const step = insert(ctx, procedureStep, {
			procedureId: row.id,
			parentStepId: null,
			isContingency: false,
			position,
			title: s.title,
			instructions: s.instructions ?? null,
			signoffs: writeSignoffs(ctx.db, null, false, s) ?? null,
			estimatedDurationMinutes: s.estimatedDurationMinutes ?? null,
			callouts: normalizeCallouts(s.callouts),
			strictSequence: s.strictSequence ?? false,
			workcenterId: s.workcenterId ?? null
		});
		const seen = new Set<number>();
		for (const k of s.kit ?? []) {
			if (seen.has(k.partId)) throw conflict('duplicate', `Part ${k.partId} twice in step ${position + 1}`);
			seen.add(k.partId);
			if (parseQty(k.quantity) <= 0) throw invalid('invalid_input', 'Quantity must be above zero');
			insert(ctx, kitItem, { stepId: step.id, partId: k.partId, quantity: parseQty(k.quantity), usage: k.usage, notes: k.notes ?? null });
			stepKitCount++;
		}
	});
	for (const k of input.kit) {
		insert(ctx, kitItem, { procedureId: row.id, stepId: null, partId: k.partId, quantity: parseQty(k.quantity), usage: 'consume', notes: null });
	}
	for (const o of input.outputs) {
		if (parseQty(o.quantity) <= 0) throw invalid('invalid_input', 'Quantity must be above zero');
		insert(ctx, procedureOutput, { procedureId: row.id, partId: o.partId, quantity: parseQty(o.quantity) });
	}
	return {
		procedure: presentProcedure(ctx, procedureRow(ctx.db, row.id)),
		stepCount: input.steps.length,
		stepKitCount,
		kitCount: input.kit.length,
		outputCount: input.outputs.length
	};
}
