import { expect, test } from 'bun:test';
import { now } from '@opal/shared';
import { part, user } from '../src/db/schema/index.ts';
import { openTestDb } from './helpers/db.ts';

test('the test database is built from the schema', async () => {
	const db = await openTestDb();
	expect(db.select().from(part).all()).toEqual([]);
});

test('a row written in one test database is not in the next, and foreign keys are on in each', async () => {
	const ts = now();
	const first = await openTestDb();
	first.insert(user).values({ username: 'ada', name: 'Ada', createdAt: ts, updatedAt: ts }).run();
	const second = await openTestDb();
	expect(second.select().from(user).all()).toEqual([]);
	expect(first.select().from(user).all()).toHaveLength(1);
	expect(second.$client.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
});
