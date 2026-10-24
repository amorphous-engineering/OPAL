/** A write transaction for code that runs outside `runOp` (the OIDC browser redirects). */
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { serialized } from '../../registry.ts';

export function inTransaction<T>(db: Db, fn: () => T): Promise<T> {
	return serialized(async () => {
		db.run(sql`BEGIN IMMEDIATE`);
		try {
			const out = fn();
			db.run(sql`COMMIT`);
			return out;
		} catch (e) {
			db.run(sql`ROLLBACK`);
			throw e;
		}
	});
}
