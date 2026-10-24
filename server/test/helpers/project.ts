import { now } from '@opal/shared';
import type { Db } from '../../src/db/client.ts';
import { project } from '../../src/db/schema/index.ts';

/** Insert an active project and return it. Scoped records need one. */
export function createTestProject(db: Db, code = 'TP') {
	const ts = now();
	return db
		.insert(project)
		.values({ code, name: `Project ${code}`, description: null, state: 'active', createdAt: ts, updatedAt: ts })
		.returning()
		.get();
}
