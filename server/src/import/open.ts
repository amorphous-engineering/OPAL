/**
 * Opens the destination database of an import.
 *
 * Normal: the migrations create the schema. With OPAL_DEV_SCHEMA=1 (and in tests) the schema is
 * built from the TypeScript tables, plus the two import-only tables, so the import works before
 * the migrations are regenerated.
 */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { type Db, openDb } from '../db/client.ts';
import * as schema from '../db/schema/index.ts';
import * as legacyTables from '../db/schema/legacy.ts';

let ddl: string[] | undefined;

export async function openSchemaImportDb(path: string): Promise<Db> {
	const all = { ...schema, ...legacyTables };
	if (!ddl) ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(all));
	const sqlite = new Database(path, { create: true, strict: true });
	sqlite.run('PRAGMA journal_mode = WAL');
	sqlite.run('PRAGMA foreign_keys = ON');
	for (const stmt of ddl) sqlite.run(stmt);
	return drizzle(sqlite, { schema: all }) as unknown as Db;
}

export async function openImportDb(path: string): Promise<Db> {
	return process.env.OPAL_DEV_SCHEMA === '1' ? openSchemaImportDb(path) : openDb(path);
}
