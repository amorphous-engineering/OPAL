/**
 * Which instance a database is. `opal backup --keep` prunes only its own backups, and a folder may be
 * shared. It lives in the database because nothing else is sure to come along: a data folder moves, a
 * container gets a new host name, and a database file can sit outside any folder. A restore keeps it, so
 * a restored instance goes on pruning the backups it came from. A copy of a database counts as the same
 * instance.
 */
import type { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { randomUUID } from 'node:crypto';

const KEY = 'instance_id';

/** The id in this database, or null for one no version with ids has opened. Plain SQL, because a copy may be older than this program. */
export function instanceIdOf(sqlite: Database): string | null {
	if (!sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_setting'").get()) return null;
	const row = sqlite.query('SELECT value FROM app_setting WHERE key = ?').get(KEY) as { value: string | null } | null;
	return row?.value ?? null;
}

/** Runs at every open and writes nothing once there is an id. */
export function ensureInstanceId(sqlite: Database): void {
	if (instanceIdOf(sqlite)) return;
	const ts = now();
	sqlite.query('INSERT INTO app_setting (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run(KEY, randomUUID(), ts, ts);
}
