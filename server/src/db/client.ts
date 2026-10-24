/** Opens the SQLite file and applies migrations. One connection per process. */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { join } from 'node:path';
import { embedded } from '../http/embedded.ts';
import * as schema from './schema/index.ts';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export const MIGRATIONS_DIR = join(import.meta.dir, '../../drizzle');

export function openDb(path: string, migrationsFolder = MIGRATIONS_DIR): Db {
	const sqlite = new Database(path, { create: true, strict: true });
	sqlite.run('PRAGMA journal_mode = WAL');
	sqlite.run('PRAGMA foreign_keys = ON');
	sqlite.run('PRAGMA busy_timeout = 5000');
	const db = drizzle(sqlite, { schema });
	const bundled = embedded()?.migrations;
	if (bundled) {
		// The binary has no drizzle/ folder on disk. Same steps as `migrate`, from memory.
		const internals = db as unknown as {
			dialect: { migrate(m: MigrationMeta[], session: unknown, config: object): void };
			session: unknown;
		};
		internals.dialect.migrate(bundled, internals.session, { migrationsFolder });
	} else {
		migrate(db, { migrationsFolder });
	}
	return db;
}
