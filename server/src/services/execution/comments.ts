/** The comment thread of a work order. Any execution state, also after completion. */
import type { ExecutionComment } from '@opal/shared';
import { asc, eq } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { executionComment } from '../../db/schema/index.ts';
import { insert } from '../../write.ts';
import { personRefs } from '../org/people.ts';
import { publish } from '../platform/index.ts';
import { executionRow } from './model.ts';

type Row = typeof executionComment.$inferSelect;

function out(ctx: Pick<Ctx, 'db'>, rows: Row[]): ExecutionComment[] {
	const people = personRefs(
		ctx.db,
		rows.flatMap((r) => (r.authorId === null ? [] : [r.authorId]))
	);
	return rows.map((r) => ({
		id: r.id,
		executionId: r.executionId,
		author: r.authorId === null ? null : (people.get(r.authorId) ?? null),
		createdAt: r.createdAt,
		body: r.body
	}));
}

export function listComments(ctx: Pick<Ctx, 'db'>, executionId: number): ExecutionComment[] {
	executionRow(ctx.db, executionId);
	const rows = ctx.db
		.select()
		.from(executionComment)
		.where(eq(executionComment.executionId, executionId))
		.orderBy(asc(executionComment.id))
		.all();
	return out(ctx, rows);
}

export function addComment(ctx: Ctx, executionId: number, body: string): ExecutionComment {
	executionRow(ctx.db, executionId);
	const row = insert(ctx, executionComment, { executionId, authorId: actorUserId(ctx.actor), body });
	// Everyone with the work order open reloads the thread.
	publish({ type: 'execution_comment', data: { executionId, commentId: row.id } });
	return out(ctx, [row])[0]!;
}
