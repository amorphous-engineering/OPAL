/**
 * One-time data step for retiring the `aborted` status. Lives outside the migrations so they stay
 * pure schema and can be regenerated.
 *
 * It has to run before them. The rebuild of `execution` copies its rows into a table whose CHECK
 * refuses `aborted`, and the old table's CHECK refuses `closed_short`, so the value can change only
 * with CHECK enforcement off, ahead of the copy. The old CHECK still naming `aborted` is what marks
 * a database that has not had this step, so it runs exactly once per database.
 *
 * A data rewrite, not an operation: no audit rows. An old aborted order has no linked issue and
 * usually no reason, and it stays that way: nobody recorded them.
 */
import type { Database } from 'bun:sqlite';

export function retireAbortedStatus(sqlite: Database): void {
	const table = sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution'").get() as { sql: string } | null;
	if (!table?.sql.includes("'aborted'")) return;
	sqlite.run('PRAGMA ignore_check_constraints = ON');
	try {
		sqlite.run("UPDATE execution SET status = 'closed_short' WHERE status = 'aborted'");
	} finally {
		sqlite.run('PRAGMA ignore_check_constraints = OFF');
	}
	// ensureSystemRoles maps a gate only when it creates the role, so an existing engineer role
	// gets the new default here, once. An admin's later edits stick.
	sqlite.run("INSERT OR IGNORE INTO role_gate (role_id, gate) SELECT id, 'execution.closeShort' FROM role WHERE key = 'engineer'");
}
