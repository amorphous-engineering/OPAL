/** Opens the SQLite file and applies migrations. One connection per process. */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { join } from 'node:path';
import { embedded } from '../http/embedded.ts';
import { retireAbortedStatus } from './retire-aborted.ts';
import { ensureInstanceId } from './instance-id.ts';
import { holdsPlaintextSecret, sealDatabase } from './seal-secrets.ts';
import * as schema from './schema/index.ts';
import { snapshotBeforeMigrating } from './snapshot.ts';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export const MIGRATIONS_DIR = join(import.meta.dir, '../../drizzle');

/** The binary has no drizzle/ folder on disk, so it reads the same files from memory. */
export const migrationFiles = (migrationsFolder = MIGRATIONS_DIR): MigrationMeta[] =>
	embedded()?.migrations ?? readMigrationFiles({ migrationsFolder });

/** Newest applied migration, by the same `created_at` drizzle's migrator compares against. */
export function lastApplied(sqlite: Database): number {
	const table = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
	if (!table) return 0;
	const row = sqlite.query('SELECT max(created_at) AS at FROM __drizzle_migrations').get() as { at: number | null };
	return Number(row.at ?? 0);
}

/**
 * Applies what is pending with foreign keys off. Drizzle runs every migration inside one
 * transaction, where `PRAGMA foreign_keys` does nothing, so the OFF a generated table rebuild
 * opens with is ignored and its DROP TABLE cascades into every child row. The check afterwards
 * counts only new violations: a database imported from 1.x may already hold some.
 */
function applyMigrations(sqlite: Database, pending: MigrationMeta[], apply: () => void): void {
	if (!pending.length) return;
	const violations = () => sqlite.query('PRAGMA foreign_key_check').all().length;
	sqlite.run('PRAGMA foreign_keys = OFF');
	try {
		const before = violations();
		apply();
		const after = violations();
		if (after > before) throw new Error(`Migrations left ${after - before} rows pointing at a missing parent`);
	} finally {
		sqlite.run('PRAGMA foreign_keys = ON');
	}
}

export interface OpenOptions {
	/** The caller runs `scrubDatabase` once it is ready to, because that can take a while on a large file. */
	scrubLater?: boolean;
}

export function openDb(
	path: string,
	migrationsFolder = MIGRATIONS_DIR,
	snapshot: (sqlite: Database, path: string) => string | null = snapshotBeforeMigrating,
	options: OpenOptions = {}
): Db {
	const sqlite = new Database(path, { create: true, strict: true });
	sqlite.run('PRAGMA journal_mode = WAL');
	sqlite.run('PRAGMA foreign_keys = ON');
	sqlite.run('PRAGMA busy_timeout = 5000');
	const db = drizzle(sqlite, { schema });
	const files = migrationFiles(migrationsFolder);
	const last = lastApplied(sqlite);
	const pending = files.filter((m) => m.folderMillis > last);
	const onDisk = path !== ':memory:';
	// A new database has nothing to lose, and a test's :memory: has no folder to put a copy in.
	// Sealing the first time is an upgrade too: this copy is the way back to a version that cannot read a sealed value.
	if (last > 0 && onDisk && (pending.length || holdsPlaintextSecret(sqlite))) {
		const copy = snapshot(sqlite, path);
		if (copy) console.log(`Copied the database before upgrading it: ${copy}`);
	}
	const internals = db as unknown as {
		dialect: { migrate(m: MigrationMeta[], session: unknown, config: object): void };
		session: unknown;
	};
	applyMigrations(sqlite, pending, () => {
		retireAbortedStatus(sqlite);
		internals.dialect.migrate(files, internals.session, { migrationsFolder });
	});
	if (onDisk) {
		sealDatabase(sqlite, last === 0, options.scrubLater);
		ensureInstanceId(sqlite);
	}
	return db;
}
