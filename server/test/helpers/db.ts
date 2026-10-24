/**
 * In-memory database built straight from the TypeScript schema, so tests do not
 * depend on generated migrations. A drift check (pnpm db:check) keeps the two equal.
 */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import type { Db } from '../../src/db/client.ts';
import * as schema from '../../src/db/schema/index.ts';

let ddl: string[] | undefined;

async function schemaSql(): Promise<string[]> {
	if (!ddl) {
		const empty = await generateSQLiteDrizzleJson({});
		const current = await generateSQLiteDrizzleJson(schema);
		ddl = await generateSQLiteMigration(empty, current);
	}
	return ddl;
}

export async function openTestDb(): Promise<Db> {
	const sqlite = new Database(':memory:', { strict: true });
	sqlite.run('PRAGMA foreign_keys = ON');
	for (const stmt of await schemaSql()) sqlite.run(stmt);
	return drizzle(sqlite, { schema });
}
