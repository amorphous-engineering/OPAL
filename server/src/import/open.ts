/**
 * Opens the destination database of an import.
 *
 * Normal: the migrations create the schema. With OPAL_DEV_SCHEMA=1 (and in tests) the schema is
 * built from the TypeScript tables, so the import works before the migrations are regenerated.
 */
import { type Db, openDb } from '../db/client.ts';
import { loadDevSchema } from '../db/dev.ts';

export async function openSchemaImportDb(path: string): Promise<Db> {
	return (await loadDevSchema()).openSchemaDb(path);
}

export async function openImportDb(path: string): Promise<Db> {
	return process.env.OPAL_DEV_SCHEMA === '1' ? openSchemaImportDb(path) : openDb(path);
}
