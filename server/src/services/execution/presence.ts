/**
 * Presence: who joined an execution and which OP each person works on. A claim is per OP (one
 * operator works an OP) and is presence, not history: moving it writes no audit row. The claim
 * outlives leaving the page; releasing it clears it. Claims also clock time (labor.ts).
 */
import { type ExecCursor, type ExecRosterEntry, OpalError, now } from '@opal/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { executionParticipant, stepExecution, user } from '../../db/schema/index.ts';
import { publish } from '../platform/index.ts';
import { personRefs } from '../org/people.ts';
import { claimBlockers } from './gates.ts';
import { clockIn, clockOut } from './labor.ts';
import { type Model, getRow, isTerminal, loadModel, opRowOf } from './model.ts';
import { initials } from './present.ts';

/** Roster chips go gray when a heartbeat is older than this. */
export const PRESENCE_STALE_MS = 4 * 60 * 60_000;
const TOUCH_MS = 30_000;

function me(ctx: Ctx): number {
	const id = actorUserId(ctx.actor);
	if (id === null) throw new OpalError(401, 'unauthenticated', 'Sign in as a person');
	return id;
}

const find = (db: Db, executionId: number, userId: number) =>
	db
		.select()
		.from(executionParticipant)
		.where(and(eq(executionParticipant.executionId, executionId), eq(executionParticipant.userId, userId)))
		.get();

/** Bookkeeping writes, not business data: no audit rows. */
function save(db: Db, executionId: number, userId: number, patch: Partial<typeof executionParticipant.$inferInsert>) {
	const cur = find(db, executionId, userId);
	const ts = now();
	if (!cur) {
		db.insert(executionParticipant)
			.values({ executionId, userId, joinedAt: null, focusStepId: null, focusedAt: null, lastActiveAt: ts, ...patch })
			.run();
		return;
	}
	const next = { ...cur, ...patch };
	if (next.joinedAt === null && next.focusStepId === null) {
		db.delete(executionParticipant).where(eq(executionParticipant.id, cur.id)).run();
		return;
	}
	db.update(executionParticipant).set(patch).where(eq(executionParticipant.id, cur.id)).run();
}

/** The poll doubles as the heartbeat; writes are throttled. */
export function touch(db: Db, executionId: number, userId: number | null) {
	if (userId === null) return;
	const cur = find(db, executionId, userId);
	if (!cur) return;
	if (Date.now() - Date.parse(cur.lastActiveAt) > TOUCH_MS) {
		db.update(executionParticipant).set({ lastActiveAt: now() }).where(eq(executionParticipant.id, cur.id)).run();
	}
}

export function join(ctx: Ctx, executionId: number) {
	const userId = me(ctx);
	loadModel(ctx.db, executionId);
	const cur = find(ctx.db, executionId, userId);
	const was = cur?.joinedAt != null;
	save(ctx.db, executionId, userId, { joinedAt: cur?.joinedAt ?? now(), lastActiveAt: now() });
	if (!was) publish({ type: 'user_joined', data: { executionId, userId } });
	return participants(ctx, executionId);
}

export function leave(ctx: Ctx, executionId: number): { ok: true } {
	const userId = me(ctx);
	loadModel(ctx.db, executionId);
	const cur = find(ctx.db, executionId, userId);
	if (cur?.joinedAt != null) {
		save(ctx.db, executionId, userId, { joinedAt: null });
		publish({ type: 'user_left', data: { executionId, userId } });
	}
	return { ok: true };
}

export function participants(ctx: Pick<Ctx, 'db'>, executionId: number) {
	loadModel(ctx.db, executionId);
	const rows = ctx.db
		.select({ p: executionParticipant, name: user.name })
		.from(executionParticipant)
		.innerJoin(user, eq(user.id, executionParticipant.userId))
		.where(and(eq(executionParticipant.executionId, executionId), isNotNull(executionParticipant.joinedAt)))
		.orderBy(executionParticipant.joinedAt)
		.all();
	return {
		executionId,
		participants: rows.map(({ p, name }) => ({
			userId: p.userId,
			name,
			joinedAt: p.joinedAt!,
			lastStepId: p.focusStepId
		}))
	};
}

/** Claim the OP a step belongs to. Refused where work cannot happen. */
export function focus(ctx: Ctx, input: { id: number; stepId: number }) {
	const userId = me(ctx);
	const m = loadModel(ctx.db, input.id);
	const target = getRow(m, input.stepId);
	const op = opRowOf(m, target);
	if (isTerminal(op.se.status)) throw new OpalError(409, 'op_finished', 'Operation is finished');
	const gates = claimBlockers(m, op);
	if (gates.length) throw new OpalError(409, 'op_gated', gates.map((b) => b.message).join('; '));
	const at = now();
	save(ctx.db, input.id, userId, { focusStepId: op.id, focusedAt: at, lastActiveAt: at });
	clockIn(ctx, m, userId, op.id, at);
	if (op.se.firstFocusedAt === null) {
		ctx.db.update(stepExecution).set({ firstFocusedAt: at }).where(eq(stepExecution.id, op.id)).run();
	}
	publish({ type: 'cursor_moved', data: { executionId: input.id, stepId: op.id, userId } });
	return { stepId: op.id, focusedAt: at };
}

export function release(ctx: Ctx, executionId: number): { ok: true } {
	const userId = me(ctx);
	const m = loadModel(ctx.db, executionId);
	save(ctx.db, executionId, userId, { focusStepId: null, focusedAt: null });
	clockOut(ctx, m, userId, now());
	publish({ type: 'cursor_moved', data: { executionId, stepId: null, userId } });
	return { ok: true };
}

export interface Claim {
	userId: number;
	stepId: number;
	focusedAt: string;
	lastActiveAt: string;
}

/** Live claims, each resolved to its OP. A claim on a finished OP no longer counts. */
export function claimsFor(db: Db, m: Model): Claim[] {
	const rows = db
		.select()
		.from(executionParticipant)
		.where(and(eq(executionParticipant.executionId, m.exec.id), isNotNull(executionParticipant.focusStepId)))
		.all();
	const out: Claim[] = [];
	for (const p of rows.sort((a, b) => (a.focusedAt ?? '').localeCompare(b.focusedAt ?? ''))) {
		const target = m.byId.get(p.focusStepId!);
		if (!target) continue;
		const op = opRowOf(m, target);
		if (isTerminal(op.se.status)) continue;
		out.push({ userId: p.userId, stepId: op.id, focusedAt: p.focusedAt!, lastActiveAt: p.lastActiveAt });
	}
	return out;
}

export function cursorOf(
	c: Pick<Claim, 'userId' | 'focusedAt' | 'lastActiveAt'>,
	name: string | null,
	avatarUrl: string | null
): ExecCursor {
	return {
		userId: c.userId,
		name,
		avatarUrl,
		initials: initials(name),
		focusedAt: c.focusedAt,
		stale: Date.now() - Date.parse(c.lastActiveAt) > PRESENCE_STALE_MS
	};
}

/** The roster: cursor holders first, then joined people whose cursor is not placed yet. */
export function roster(db: Db, m: Model): ExecRosterEntry[] {
	const claims = claimsFor(db, m);
	const joined = db
		.select()
		.from(executionParticipant)
		.where(and(eq(executionParticipant.executionId, m.exec.id), isNotNull(executionParticipant.joinedAt)))
		.all();
	const people = personRefs(db, [...claims.map((c) => c.userId), ...joined.map((j) => j.userId)]);
	const out: ExecRosterEntry[] = [];
	for (const c of claims) {
		const p = people.get(c.userId);
		out.push({
			...cursorOf(c, p?.name ?? null, p?.avatarUrl ?? null),
			stepId: c.stepId,
			stepNumber: m.byId.get(c.stepId)?.number ?? null
		});
	}
	const placed = new Set(claims.map((c) => c.userId));
	for (const j of joined) {
		if (placed.has(j.userId)) continue;
		const p = people.get(j.userId);
		out.push({
			...cursorOf({ userId: j.userId, focusedAt: j.joinedAt!, lastActiveAt: j.lastActiveAt }, p?.name ?? null, p?.avatarUrl ?? null),
			focusedAt: null,
			stepId: null,
			stepNumber: null
		});
	}
	return out;
}
