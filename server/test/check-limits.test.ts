import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limitsByField, overLimits } from '../scripts/check-limits.ts';
import { openDb } from '../src/db/client.ts';
import { user } from '../src/db/schema/index.ts';

describe('the stored-value limit check', () => {
	test('it lists a stored value over the limit the API accepts, and only that one', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'opal-limits-')), 'opal.db');
		const db = openDb(file);
		const at = new Date().toISOString();
		const row = db.insert(user).values({ username: 'long', name: 'x'.repeat(300), isAdmin: false, isActive: true, createdAt: at, updatedAt: at }).returning().get();
		db.insert(user).values({ username: 'short', name: 'Short', isAdmin: false, isActive: true, createdAt: at, updatedAt: at }).run();
		const { over } = overLimits(file);
		expect(over).toEqual([{ table: 'user', column: 'name', id: row.id, length: 300, limit: limitsByField().get('name')! }]);
		expect(db.select().from(user).where(eq(user.id, row.id)).get()?.name.length).toBe(300);
	});

	test('a real field limit is found', () => {
		expect(limitsByField().get('description')).toBeGreaterThan(1000);
	});
});
