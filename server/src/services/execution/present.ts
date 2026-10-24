/** Small presenters shared by the write results and the document. */
import type { ExecStepStatus, PersonRef } from '@opal/shared';
import { eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { zExecStepState } from '@opal/shared';
import type { Db } from '../../db/client.ts';
import { signoff, user } from '../../db/schema/index.ts';
import { personRefs } from '../org/people.ts';
import type { Model, Row } from './model.ts';

export function userNames(db: Db, ids: Iterable<number | null | undefined>): Map<number, string> {
	const list = [...new Set([...ids].filter((x): x is number => x != null))];
	if (!list.length) return new Map();
	return new Map(
		db
			.select({ id: user.id, name: user.name })
			.from(user)
			.where(inArray(user.id, list))
			.all()
			.map((u) => [u.id, u.name])
	);
}

export function initials(name: string | null | undefined): string {
	const parts = (name ?? '').split(/\s+/).filter(Boolean);
	if (!parts.length) return '?';
	if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
	return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export type StepStateOut = z.output<typeof zExecStepState>;

export function stepState(db: Db, row: Row): StepStateOut {
	const names = userNames(db, [row.se.completedById]);
	return {
		id: row.id,
		number: row.number,
		title: row.title,
		level: row.level,
		parentId: row.parentId,
		status: row.se.status as ExecStepStatus,
		dataCaptured: row.se.dataCaptured ?? null,
		skipReason: row.se.skipReason,
		startedAt: row.se.startedAt,
		completedAt: row.se.completedAt,
		completedBy: row.se.completedById === null ? null : (names.get(row.se.completedById) ?? null),
		isAdHoc: row.adhoc !== null
	};
}

export function stepStates(db: Db, m: Model): StepStateOut[] {
	const names = userNames(db, m.rows.map((r) => r.se.completedById));
	return m.rows.map((row) => ({
		id: row.id,
		number: row.number,
		title: row.title,
		level: row.level,
		parentId: row.parentId,
		status: row.se.status as ExecStepStatus,
		dataCaptured: row.se.dataCaptured ?? null,
		skipReason: row.se.skipReason,
		startedAt: row.se.startedAt,
		completedAt: row.se.completedAt,
		completedBy: row.se.completedById === null ? null : (names.get(row.se.completedById) ?? null),
		isAdHoc: row.adhoc !== null
	}));
}

export function signoffRecords(db: Db, stepIds: number[]) {
	if (!stepIds.length) return new Map<number, (typeof signoff.$inferSelect)[]>();
	const out = new Map<number, (typeof signoff.$inferSelect)[]>();
	for (const s of db.select().from(signoff).where(inArray(signoff.stepExecutionId, stepIds)).orderBy(signoff.slot).all()) {
		out.set(s.stepExecutionId, [...(out.get(s.stepExecutionId) ?? []), s]);
	}
	return out;
}

export function signedSlots(db: Db, stepId: number): Map<number, typeof signoff.$inferSelect> {
	return new Map(
		db.select().from(signoff).where(eq(signoff.stepExecutionId, stepId)).all().map((s) => [s.slot, s])
	);
}

export type { PersonRef };
export { personRefs };
