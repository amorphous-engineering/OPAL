/**
 * Undo last action (decision O4).
 *
 * Only an operation that registers itself as reversible can be undone. There
 * is no generic replay of audit rows: the area that owns the operation says
 * how to reverse it, usually with `revertRows` limited to its own tables.
 *
 *   registerReversible('parts.create', {
 *     revert: (ctx, rows) => revertRows(ctx, rows, { part }),
 *   });
 *
 * "Last action" is the caller's newest audit group from the last hour, skipping
 * undo's own rows and groups already undone. If that group's operation is not
 * reversible, undo refuses: it never reaches past it.
 */
import { conflict, notFound, now } from '@opal/shared';
import { and, desc, eq, gte, ne } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { actorUserId, type Ctx } from '../../context.ts';
import { auditLog, undoMark } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { auditEntries } from './audit.ts';
import { entityLabel } from './entities.ts';

export const UNDO_WINDOW_MS = 60 * 60 * 1000;

export type AuditRow = typeof auditLog.$inferSelect;
type AnyTable = SQLiteTable & { id: any; $inferInsert: any; $inferSelect: any };

export interface Reversible {
	/** Reverse the group. `rows` are oldest first. Use `revertRows` or write the reversal by hand. */
	revert(ctx: Ctx, rows: AuditRow[]): void | { summary?: string };
	/**
	 * How many of `rows` (newest first, same operation, same user) belong to the
	 * last call. Default: up to and including the first `create`, else 1.
	 */
	group?(rows: AuditRow[]): number;
	/** Text for the confirmation. Default: the audit entry's action, entity and record. */
	describe?(ctx: Ctx, rows: AuditRow[]): string;
}

const reversible = new Map<string, Reversible>();

/** Mark an operation as reversible. Call at module load, next to the operation's binding. */
export function registerReversible(opName: string, spec: Reversible): void {
	reversible.set(opName, spec);
}

export function isReversible(opName: string): boolean {
	return reversible.has(opName);
}

const defaultGroup = (rows: AuditRow[]): number => {
	const i = rows.findIndex((r) => r.action === 'create');
	return i === -1 ? 1 : i + 1;
};

/**
 * Reverse audit rows on the given tables, newest first: a create is removed, an
 * update gets its previous values back, a delete is re-inserted. Refuses when
 * a later change touched the same record (so no one's newer work is lost).
 */
export function revertRows(ctx: Ctx, rows: AuditRow[], tables: Record<string, AnyTable>): void {
	assertUntouchedSince(ctx, rows);
	const skip = new Set(['id', 'createdAt', 'updatedAt']);
	const strip = (v: unknown) =>
		Object.fromEntries(Object.entries(v as object).filter(([k]) => !skip.has(k)));
	try {
		for (const r of [...rows].reverse()) {
			const table = tables[r.entity];
			if (!table) throw conflict('not_reversible', `${entityLabel(r.entity)} cannot be reversed here`);
			if (r.action === 'create') remove(ctx, table, r.entityId);
			else if (r.action === 'update') update(ctx, table, r.entityId, strip(r.before));
			else insert(ctx, table, { ...strip(r.before), id: r.entityId });
		}
	} catch (e) {
		if ((e as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT')) {
			throw conflict('undo_blocked', 'Other records now depend on this change, so it cannot be undone');
		}
		throw e;
	}
}

/** Refuse when any record in `rows` changed after the newest of them. */
export function assertUntouchedSince(ctx: Ctx, rows: AuditRow[]): void {
	const last = Math.max(...rows.map((r) => r.id));
	for (const r of rows) {
		const later = ctx.db
			.select({ id: auditLog.id })
			.from(auditLog)
			.where(and(eq(auditLog.entity, r.entity), eq(auditLog.entityId, r.entityId)))
			.orderBy(desc(auditLog.id))
			.limit(1)
			.get();
		if (later && later.id > last) {
			throw conflict('changed_since', 'The record changed after this action, so it cannot be undone');
		}
	}
}

interface Candidate {
	rows: AuditRow[]; // oldest first
	spec: Reversible | undefined;
}

function lastGroup(ctx: Ctx): Candidate | null {
	const userId = actorUserId(ctx.actor);
	if (userId === null) return null;
	const since = new Date(Date.now() - UNDO_WINDOW_MS).toISOString();
	const undone = new Set(
		ctx.db
			.select({ id: undoMark.auditId })
			.from(undoMark)
			.all()
			.map((m) => m.id)
	);
	const mine = ctx.db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.actorUserId, userId), gte(auditLog.at, since), ne(auditLog.op, 'undo.last')))
		.orderBy(desc(auditLog.id))
		.all()
		.filter((r) => !undone.has(r.id));
	const head = mine[0];
	if (!head) return null;
	const same: AuditRow[] = [];
	for (const r of mine) {
		if (r.op !== head.op) break;
		same.push(r);
	}
	const spec = reversible.get(head.op);
	const n = Math.min(same.length, (spec?.group ?? defaultGroup)(same));
	return { rows: same.slice(0, n).reverse(), spec };
}

export function preview(ctx: Ctx) {
	const c = lastGroup(ctx);
	if (!c) throw notFound('Recent action');
	const newest = c.rows.at(-1)!;
	const [entry] = auditEntries(ctx.db, [c.rows[0]!]);
	let summary = `${entry!.action.toUpperCase()} ${entry!.entityLabel}${entry!.recordLabel ? ` ${entry!.recordLabel}` : ''}`;
	if (entry!.action === 'update' && entry!.changes.length) {
		summary += ` (changed: ${entry!.changes
			.slice(0, 5)
			.map((x) => x.field)
			.join(', ')})`;
	}
	if (c.spec?.describe) summary = c.spec.describe(ctx, c.rows);
	return {
		auditId: newest.id,
		op: newest.op,
		summary,
		at: newest.at,
		canUndo: c.spec !== undefined,
		reason: c.spec ? null : `The last action (${newest.op}) cannot be undone`
	};
}

export function undoLast(ctx: Ctx): { summary: string } {
	const c = lastGroup(ctx);
	if (!c) throw notFound('Recent action');
	if (!c.spec) throw conflict('not_reversible', `The last action (${c.rows[0]!.op}) cannot be undone`);
	const described = preview(ctx).summary;
	const out = c.spec.revert(ctx, c.rows);
	const at = now();
	ctx.db
		.insert(undoMark)
		.values(c.rows.map((r) => ({ auditId: r.id, createdAt: at })))
		.run();
	return { summary: (out && out.summary) || `Reverted: ${described}` };
}

