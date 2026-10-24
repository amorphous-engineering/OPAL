import { expect, test } from 'bun:test';
import { part } from '../src/db/schema/index.ts';
import { openTestDb } from './helpers/db.ts';

test('the test database is built from the schema', async () => {
	const db = await openTestDb();
	expect(db.select().from(part).all()).toEqual([]);
});
