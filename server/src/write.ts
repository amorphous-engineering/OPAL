/**
 * Audited writes. Services change data only through these helpers, so every
 * create, update and delete leaves an audit row in the same transaction.
 */
import { now } from '@opal/shared';
import { eq, getTableName } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Ctx } from './context.ts';
import { auditLog } from './db/schema/index.ts';

// Drizzle's generic table types do not narrow to "a table with an id column",
// so the helpers take any table and read `id` through a cast.
type AnyTable = SQLiteTable & { id: any; $inferInsert: any; $inferSelect: any };

/** Secrets never reach the audit log. */
const REDACTED = new Set(['passwordHash', 'tokenHash']);
function redact(row: unknown): unknown {
	if (!row || typeof row !== 'object') return row ?? null;
	return Object.fromEntries(
		Object.entries(row).map(([k, v]) => [k, REDACTED.has(k) && v != null ? '[redacted]' : v])
	);
}

function audit(
	ctx: Ctx,
	table: AnyTable,
	entityId: number,
	action: 'create' | 'update' | 'delete',
	before: unknown,
	after: unknown
) {
	ctx.db
		.insert(auditLog)
		.values({
			at: now(),
			entity: getTableName(table),
			entityId,
			action,
			op: ctx.op,
			actorUserId: ctx.actor.kind === 'user' || ctx.actor.kind === 'token' ? ctx.actor.userId : null,
			actorTokenId: ctx.actor.kind === 'token' ? ctx.actor.tokenId : null,
			before: redact(before),
			after: redact(after)
		})
		.run();
}

/** Insert values: everything except the timestamps, which the helper sets. */
type Values<T extends AnyTable> = Omit<T['$inferInsert'], 'createdAt' | 'updatedAt'>;

export function insert<T extends AnyTable>(ctx: Ctx, table: T, values: Values<T>): T['$inferSelect'] {
	const ts = now();
	const row = ctx.db
		.insert(table)
		.values({
			...('createdAt' in table ? { createdAt: ts } : {}),
			...('updatedAt' in table ? { updatedAt: ts } : {}),
			...values
		} as T['$inferInsert'])
		.returning()
		.get() as T['$inferSelect'];
	audit(ctx, table, row.id, 'create', null, row);
	return row;
}

export function update<T extends AnyTable>(
	ctx: Ctx,
	table: T,
	id: number,
	patch: Partial<Values<T>>
): T['$inferSelect'] {
	const before = ctx.db.select().from(table).where(eq(table.id, id)).get();
	if (!before) throw new Error(`update: ${getTableName(table)} ${id} does not exist`);
	const after = ctx.db
		.update(table)
		.set({ ...patch, ...('updatedAt' in table ? { updatedAt: now() } : {}) })
		.where(eq(table.id, id))
		.returning()
		.get() as T['$inferSelect'];
	audit(ctx, table, id, 'update', before, after);
	return after;
}

/** Hard delete. Only for rows nothing references (drafts); see CLAUDE.md rule 6. */
export function remove<T extends AnyTable>(ctx: Ctx, table: T, id: number): void {
	const before = ctx.db.select().from(table).where(eq(table.id, id)).get();
	if (!before) return;
	ctx.db.delete(table).where(eq(table.id, id)).run();
	audit(ctx, table, id, 'delete', before, null);
}
