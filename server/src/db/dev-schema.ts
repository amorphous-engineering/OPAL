/**
 * Build a database straight from the TypeScript schema, without migrations.
 * For tests and for dev servers on a fresh data folder (OPAL_DEV_SCHEMA=1) while
 * areas are being ported. Never used for a release.
 */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import type { Db } from './client.ts';
import * as schema from './schema/index.ts';

let ddl: string[] | undefined;

export async function schemaSql(): Promise<string[]> {
	if (!ddl) {
		const empty = await generateSQLiteDrizzleJson({});
		const current = await generateSQLiteDrizzleJson(schema);
		ddl = await generateSQLiteMigration(empty, current);
	}
	return ddl;
}

export async function openSchemaDb(path: string): Promise<Db> {
	const sqlite = new Database(path, { create: true, strict: true });
	if (path !== ':memory:') sqlite.run('PRAGMA journal_mode = WAL');
	sqlite.run('PRAGMA foreign_keys = ON');
	sqlite.run('PRAGMA busy_timeout = 5000');
	const fresh = !sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table'").get();
	if (fresh) for (const stmt of await schemaSql()) sqlite.run(stmt);
	return drizzle(sqlite, { schema });
}
