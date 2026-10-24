/** Where a data point came from: the execution and step of the step execution that produced it. */
import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { stepExecution } from '../../db/schema/index.ts';
import { loadModel } from './model.ts';

export interface StepSource {
	executionId: number;
	woNumber: string;
	stepId: number;
	stepNumber: string;
	stepTitle: string;
}

export function stepSources(db: Db, stepIds: number[]): Map<number, StepSource> {
	const out = new Map<number, StepSource>();
	const ids = [...new Set(stepIds)];
	if (!ids.length) return out;
	const rows = db.select().from(stepExecution).where(inArray(stepExecution.id, ids)).all();
	const models = new Map<number, ReturnType<typeof loadModel>>();
	for (const r of rows) {
		if (!models.has(r.executionId)) models.set(r.executionId, loadModel(db, r.executionId));
		const m = models.get(r.executionId)!;
		const row = m.byId.get(r.id);
		out.set(r.id, {
			executionId: r.executionId,
			woNumber: m.exec.woNumber,
			stepId: r.id,
			stepNumber: row?.number ?? '',
			stepTitle: row?.title ?? ''
		});
	}
	return out;
}

export const stepExists = (db: Db, id: number) =>
	db.select({ id: stepExecution.id }).from(stepExecution).where(inArray(stepExecution.id, [id])).get() !== undefined;

