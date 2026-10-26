/**
 * Time worked. A claim (presence.ts) opens a work interval; clocking out, claiming another OP,
 * or the OP or the execution finishing closes it. An interval left open on a finished OP ends
 * at that finish time, so a forgotten clock-out never counts past the work.
 */
import type { LaborRow } from '@opal/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { workInterval } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';
import { personRefs } from '../org/people.ts';
import { type Model, isActive, isTerminal } from './model.ts';

type Interval = typeof workInterval.$inferSelect;

/** When an open interval must end at the latest: the finish of its OP or of the execution. */
function cap(m: Model, opStepId: number): string | null {
	const op = m.byId.get(opStepId);
	const ends: string[] = [];
	if (op && isTerminal(op.se.status)) ends.push(op.se.completedAt ?? op.se.updatedAt);
	if (!isActive(m.exec)) ends.push(m.exec.completedAt ?? m.exec.updatedAt);
	return ends.length ? ends.sort()[0]! : null;
}

const seconds = (from: string, to: string) => Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));

const openOf = (db: Db, executionId: number, userId: number) =>
	db
		.select()
		.from(workInterval)
		.where(and(eq(workInterval.executionId, executionId), eq(workInterval.userId, userId), isNull(workInterval.endedAt)))
		.get();

function close(ctx: Ctx, m: Model, row: Interval, at: string) {
	const limit = cap(m, row.opStepId);
	update(ctx, workInterval, row.id, { endedAt: limit && limit < at ? limit : at });
}

/** Clock in on an OP. A second claim of the same OP keeps the open interval. */
export function clockIn(ctx: Ctx, m: Model, userId: number, opStepId: number, at: string) {
	const open = openOf(ctx.db, m.exec.id, userId);
	if (open?.opStepId === opStepId && !cap(m, opStepId)) return;
	if (open) close(ctx, m, open, at);
	insert(ctx, workInterval, { executionId: m.exec.id, opStepId, userId, startedAt: at, endedAt: null });
}

export function clockOut(ctx: Ctx, m: Model, userId: number, at: string) {
	const open = openOf(ctx.db, m.exec.id, userId);
	if (open) close(ctx, m, open, at);
}

/** Time per person per OP, in document order of first clock-in. */
export function laborRows(db: Db, m: Model): LaborRow[] {
	const rows = db.select().from(workInterval).where(eq(workInterval.executionId, m.exec.id)).orderBy(workInterval.startedAt).all();
	const people = personRefs(db, rows.map((r) => r.userId));
	const out = new Map<string, LaborRow>();
	for (const r of rows) {
		const key = `${r.opStepId}:${r.userId}`;
		const p = people.get(r.userId);
		const row = out.get(key) ?? { opId: r.opStepId, userId: r.userId, name: p?.name ?? null, avatarUrl: p?.avatarUrl ?? null, seconds: 0, since: null };
		const end = r.endedAt ?? cap(m, r.opStepId);
		if (end) row.seconds += seconds(r.startedAt, end);
		else row.since = r.startedAt;
		out.set(key, row);
	}
	return [...out.values()];
}
