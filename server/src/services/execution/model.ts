/**
 * The in-memory model of one execution: its rows (snapshot steps and redline steps joined with
 * their state) in document order. Every rule of the area works on this model, so the rules read
 * the same for a snapshot step and a redline step.
 */
import {
	EXEC_TERMINAL_STATUSES,
	type ProcedureSnapshot,
	type SnapshotStep,
	notFound
} from '@opal/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { adhocStep, execution, procedure, procedureVersion, stepExecution } from '../../db/schema/index.ts';
import { effectiveSignoffs } from '../procedures/signoffs.ts';

export type ExecutionRow = typeof execution.$inferSelect;
export type StepExecRow = typeof stepExecution.$inferSelect;
export type AdhocRow = typeof adhocStep.$inferSelect;
export type VersionRow = typeof procedureVersion.$inferSelect;

export const isTerminal = (status: string) => EXEC_TERMINAL_STATUSES.includes(status);
export const ACTIVE = ['cut', 'in_work'] as const;
export const isActive = (e: Pick<ExecutionRow, 'status'>) => (ACTIVE as readonly string[]).includes(e.status);

export interface Row {
	/** Step execution id: the key of the step in every execution path. */
	id: number;
	se: StepExecRow;
	templateStepId: number | null;
	adhoc: AdhocRow | null;
	number: string;
	/** 0 = OP, 1 = sub-step. */
	level: number;
	/** Step execution id of the OP, for a sub-step. */
	parentId: number | null;
	title: string;
	instructions: string | null;
	dataSchema: SnapshotStep['dataSchema'];
	signoffs: { label: string; role: string | null }[];
	isContingency: boolean;
	strictSequence: boolean;
	/** Step execution ids of the OPs this OP waits on. */
	dependsOn: number[];
	estimatedDurationMinutes: number | null;
	workcenterId: number | null;
	callouts: SnapshotStep['callouts'];
	images: SnapshotStep['images'];
	kit: SnapshotStep['kit'];
	hasChildren: boolean;
	/** A redline OP: the issue it answers and the OP it gates. */
	redline: { issueId: number; hostId: number | null } | null;
	/** Index in document order. */
	seq: number;
}

export interface Model {
	exec: ExecutionRow;
	version: VersionRow;
	snapshot: ProcedureSnapshot;
	rows: Row[];
	byId: Map<number, Row>;
	children: Map<number, Row[]>;
	/** Snapshot step id to step execution id. */
	seOfTemplate: Map<number, number>;
}

export function executionRow(db: Db, id: number): ExecutionRow {
	const r = db.select().from(execution).where(eq(execution.id, id)).get();
	if (!r) throw notFound('Execution');
	return r;
}

export function loadModel(db: Db, executionId: number): Model {
	const exec = executionRow(db, executionId);
	const version = db.select().from(procedureVersion).where(eq(procedureVersion.id, exec.versionId)).get();
	if (!version) throw notFound('Version');
	const snapshot = version.content;
	const states = db.select().from(stepExecution).where(eq(stepExecution.executionId, executionId)).orderBy(asc(stepExecution.id)).all();
	const adhocs = db.select().from(adhocStep).where(eq(adhocStep.executionId, executionId)).orderBy(asc(adhocStep.id)).all();

	const seOfTemplate = new Map<number, number>();
	const seOfAdhoc = new Map<number, number>();
	for (const s of states) {
		if (s.stepId !== null) seOfTemplate.set(s.stepId, s.id);
		if (s.adhocStepId !== null) seOfAdhoc.set(s.adhocStepId, s.id);
	}
	const stateById = new Map(states.map((s) => [s.id, s]));
	const snapHasChildren = new Set(snapshot.steps.map((s) => s.parentId).filter((x): x is number => x !== null));
	const adhocHasChildren = new Set(adhocs.map((a) => a.parentId).filter((x): x is number => x !== null));

	const fromSnapshot = (s: SnapshotStep): Row | null => {
		const seId = seOfTemplate.get(s.id);
		if (seId === undefined) return null;
		return {
			id: seId,
			se: stateById.get(seId)!,
			templateStepId: s.id,
			adhoc: null,
			number: s.number,
			level: s.level,
			parentId: s.parentId === null ? null : (seOfTemplate.get(s.parentId) ?? null),
			title: s.title,
			instructions: s.instructions,
			dataSchema: s.dataSchema,
			signoffs: s.signoffs.map((x) => ({ label: x.label, role: x.role })),
			isContingency: s.isContingency,
			strictSequence: s.strictSequence,
			dependsOn: s.dependsOn.map((d) => seOfTemplate.get(d)).filter((x): x is number => x !== undefined),
			estimatedDurationMinutes: s.estimatedDurationMinutes,
			workcenterId: s.workcenterId,
			callouts: s.callouts,
			images: s.images,
			kit: s.kit,
			hasChildren: snapHasChildren.has(s.id),
			redline: null,
			seq: 0
		};
	};
	const fromAdhoc = (a: AdhocRow): Row | null => {
		const seId = seOfAdhoc.get(a.id);
		if (seId === undefined) return null;
		const hasKids = adhocHasChildren.has(a.id);
		return {
			id: seId,
			se: stateById.get(seId)!,
			templateStepId: null,
			adhoc: a,
			number: a.number,
			level: a.parentId === null ? 0 : 1,
			parentId: a.parentId === null ? null : (seOfAdhoc.get(a.parentId) ?? null),
			title: a.title,
			instructions: a.instructions,
			dataSchema: a.dataSchema ?? null,
			signoffs: effectiveSignoffs(a.signoffs ?? null, hasKids).map((x) => ({ label: x.label, role: x.role })),
			isContingency: false,
			strictSequence: false,
			dependsOn: [],
			estimatedDurationMinutes: null,
			workcenterId: null,
			callouts: [],
			images: [],
			kit: [],
			hasChildren: hasKids,
			redline: a.parentId === null ? { issueId: a.issueId, hostId: a.hostStepId === null ? null : (seOfTemplate.get(a.hostStepId) ?? null) } : null,
			seq: 0
		};
	};

	const snapRows = snapshot.steps.map(fromSnapshot).filter((r): r is Row => r !== null);
	const redlineOps = adhocs
		.filter((a) => a.parentId === null)
		.map(fromAdhoc)
		.filter((r): r is Row => r !== null);
	const adhocKids = (opAdhocId: number) =>
		adhocs
			.filter((a) => a.parentId === opAdhocId)
			.sort((a, b) => a.position - b.position || a.id - b.id)
			.map(fromAdhoc)
			.filter((r): r is Row => r !== null);

	// Document order: each OP is preceded by the redline OPs that gate it.
	const rows: Row[] = [];
	const placed = new Set<number>();
	const emitRedline = (r: Row) => {
		rows.push(r, ...adhocKids(r.adhoc!.id));
		placed.add(r.id);
	};
	let i = 0;
	while (i < snapRows.length) {
		const op = snapRows[i]!;
		const group = [op];
		let j = i + 1;
		while (j < snapRows.length && snapRows[j]!.level > 0) group.push(snapRows[j++]!);
		for (const r of redlineOps.filter((x) => x.redline?.hostId === op.id).sort((a, b) => a.id - b.id)) emitRedline(r);
		rows.push(...group);
		i = j;
	}
	for (const r of redlineOps.filter((x) => !placed.has(x.id)).sort((a, b) => a.id - b.id)) emitRedline(r);

	rows.forEach((r, n) => (r.seq = n));
	const byId = new Map(rows.map((r) => [r.id, r]));
	const children = new Map<number, Row[]>();
	for (const r of rows) {
		if (r.parentId !== null) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
	}
	return { exec, version, snapshot, rows, byId, children, seOfTemplate };
}

export const opRowOf = (m: Model, row: Row): Row => (row.level === 0 || row.parentId === null ? row : (m.byId.get(row.parentId) ?? row));

/** Leaf rows that count toward progress: contingency work is optional. */
export function progress(m: Model): { done: number; total: number } {
	const counted = m.rows.filter((r) => !r.hasChildren && !r.isContingency);
	return { done: counted.filter((r) => isTerminal(r.se.status)).length, total: counted.length };
}

export function getRow(m: Model, stepId: number): Row {
	const r = m.byId.get(stepId);
	if (!r) throw notFound('Step');
	return r;
}

export function stepRowById(db: Db, stepId: number): StepExecRow | undefined {
	return db.select().from(stepExecution).where(eq(stepExecution.id, stepId)).get();
}

export function procedureOf(db: Db, id: number) {
	return db.select().from(procedure).where(eq(procedure.id, id)).get()!;
}

/** Display number of a redline step or snapshot step. */
export const labelOf = (r: Row) => r.number;

export function stepByExecAndId(db: Db, executionId: number, stepId: number): StepExecRow | undefined {
	return db
		.select()
		.from(stepExecution)
		.where(and(eq(stepExecution.executionId, executionId), eq(stepExecution.id, stepId)))
		.get();
}
