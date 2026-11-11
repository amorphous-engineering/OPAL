/**
 * In-memory database built straight from the TypeScript schema, so tests do not
 * depend on generated migrations. Running the DDL takes 8 ms and copying its result
 * under 1 ms, and nearly every test opens one, so it runs once.
 */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { Db } from '../../src/db/client.ts';
import { openSchemaDb } from '../../src/db/dev-schema.ts';
import * as schema from '../../src/db/schema/index.ts';

let template: Uint8Array | undefined;

export async function openTestDb(): Promise<Db> {
	template ??= (await openSchemaDb(':memory:')).$client.serialize();
	const sqlite = Database.deserialize(template, { strict: true });
	sqlite.run('PRAGMA foreign_keys = ON');
	return drizzle(sqlite, { schema });
}
