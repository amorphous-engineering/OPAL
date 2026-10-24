/**
 * The content of a fresh demo database.
 *
 * PLACEHOLDER. The legacy seed (`seed.py`) is not ported. The import agent fills this
 * function: it copies the legacy seeded database (`notes/fixtures/legacy-seed.db`) into `db`
 * with the legacy import. Until then a new demo database is empty (schema only), and the
 * operator who enters the demo is added as an admin by the lifecycle code.
 *
 * Contract: `db` is a new, empty database with the current schema. Fill it synchronously, do
 * not close it, and do not create users that clash with the operator (the lifecycle code
 * matches the operator by email, then by name).
 */
import type { Db } from '../../db/client.ts';

export function buildDemoContent(_db: Db): void {
	// Intentionally empty: see the note above.
}
