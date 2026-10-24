import { and, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { issue } from '../../db/schema/index.ts';
import { blockingSql } from '../issues/state.ts';

/** Which of these executions have a blocking issue. */
export function blockedExecutionIds(db: Db, ids: number[]): Set<number> {
	if (!ids.length) return new Set();
	return new Set(
		db
			.selectDistinct({ id: issue.executionId })
			.from(issue)
			.where(and(blockingSql, isNotNull(issue.executionId), inArray(issue.executionId, ids)))
			.all()
			.map((r) => r.id!)
	);
}
