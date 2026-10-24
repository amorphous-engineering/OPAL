/** A part's audit trail, from the audit log. */
import { desc, and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { auditLog, user } from '../../db/schema/index.ts';
import { getRow } from './index.ts';

/** Bookkeeping columns that change on every write and say nothing. */
const SKIP = new Set(['updatedAt', 'createdAt', 'id']);

export function history(ctx: Ctx, id: number, limit: number) {
	getRow(ctx, id);
	const where = and(eq(auditLog.entity, 'part'), eq(auditLog.entityId, id));
	const total = ctx.db.select({ n: sql<number>`count(*)` }).from(auditLog).where(where).get()?.n ?? 0;
	const rows = ctx.db
		.select({ entry: auditLog, userName: user.name })
		.from(auditLog)
		.leftJoin(user, eq(auditLog.actorUserId, user.id))
		.where(where)
		.orderBy(desc(auditLog.at), desc(auditLog.id))
		.limit(limit)
		.all();
	return {
		total,
		items: rows.map(({ entry, userName }) => {
			const before = (entry.before ?? {}) as Record<string, unknown>;
			const after = (entry.after ?? {}) as Record<string, unknown>;
			const changes =
				entry.action === 'update'
					? Object.keys(after)
							.filter((k) => !SKIP.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
							.map((field) => ({ field, old: before[field] ?? null, new: after[field] ?? null }))
					: [];
			return { at: entry.at, action: entry.action as 'create' | 'update' | 'delete', op: entry.op, userName, changes };
		})
	};
}
