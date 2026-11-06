import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR, openDb } from '../../src/db/client.ts';
import { snapshotBeforeMigrating } from '../../src/db/snapshot.ts';

const dirs: string[] = [];
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-migrations-'));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the migrations folder cut at one tag, for building a database as it once was. */
function migrationsUpTo(tag: string): string {
	const dir = tempDir();
	cpSync(MIGRATIONS_DIR, dir, { recursive: true });
	const path = join(dir, 'meta/_journal.json');
	const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { tag: string }[] };
	const at = journal.entries.findIndex((e) => e.tag === tag);
	expect(at).toBeGreaterThanOrEqual(0);
	journal.entries = journal.entries.slice(0, at + 1);
	writeFileSync(path, JSON.stringify(journal));
	return dir;
}

/** A migration that rebuilds `execution` the way drizzle-kit writes it, on top of the real ones. */
function withRebuildOfExecution(): string {
	const dir = tempDir();
	cpSync(MIGRATIONS_DIR, dir, { recursive: true });
	const current = openDb(':memory:', dir).$client.query("SELECT sql FROM sqlite_master WHERE name = 'execution'").get() as { sql: string };
	const path = join(dir, 'meta/_journal.json');
	const journal = JSON.parse(readFileSync(path, 'utf8')) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
	const last = journal.entries[journal.entries.length - 1]!;
	journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: '9999_rebuild', breakpoints: true });
	writeFileSync(path, JSON.stringify(journal));
	writeFileSync(
		join(dir, '9999_rebuild.sql'),
		[
			'PRAGMA foreign_keys=OFF;',
			`${current.sql.replace(/^CREATE TABLE ["`]?execution["`]?/, 'CREATE TABLE `__new_execution`')};`,
			'INSERT INTO `__new_execution` SELECT * FROM `execution`;',
			'DROP TABLE `execution`;',
			'ALTER TABLE `__new_execution` RENAME TO `execution`;',
			'PRAGMA foreign_keys=ON;'
		].join('--> statement-breakpoint\n')
	);
	return dir;
}

/** Rows a work order needs, by raw SQL so the test does not depend on today's services. */
function seedWorkOrder(path: string, status: string) {
	const db = new Database(path);
	db.run('PRAGMA foreign_keys = OFF');
	db.run("INSERT INTO execution (id, wo_number, project_id, procedure_id, version_id, status, priority, created_at, updated_at) VALUES (1, 'WO-0000000001', 1, 1, 1, ?, 'normal', 'x', 'x')", [status]);
	db.run("INSERT INTO step_execution (id, execution_id, step_id, status, created_at, updated_at) VALUES (1, 1, 1, 'completed', 'x', 'x')");
	db.run("INSERT INTO signoff (id, step_execution_id, slot, label, signed_at, created_at) VALUES (1, 1, 0, 'Primary buyoff', 'x', 'x')");
	db.close();
}

const count = (path: string, table: string) => {
	const db = new Database(path);
	const n = (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
	db.close();
	return n;
};

describe('applying migrations', () => {
	test('rebuilding a table keeps the rows that reference it', () => {
		const path = join(tempDir(), 'opal.db');
		openDb(path);
		seedWorkOrder(path, 'cut');
		openDb(path, withRebuildOfExecution());
		expect(count(path, 'execution')).toBe(1);
		expect(count(path, 'step_execution')).toBe(1);
		expect(count(path, 'signoff')).toBe(1);
	});

	test('foreign keys are enforced again once migrations finish', () => {
		const path = join(tempDir(), 'opal.db');
		const db = openDb(path);
		const on = db.$client.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
		expect(on.foreign_keys).toBe(1);
		const refused = () => db.$client.run("INSERT INTO step_execution (execution_id, step_id, status, created_at, updated_at) VALUES (999, 1, 'pending', 'x', 'x')");
		expect(refused).toThrow();
	});

	test('reopening a database with nothing pending changes nothing', () => {
		const path = join(tempDir(), 'opal.db');
		openDb(path);
		seedWorkOrder(path, 'cut');
		const db = openDb(path);
		expect(count(path, 'step_execution')).toBe(1);
		expect((db.$client.query('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
	});

});

describe('the copy taken before an upgrade', () => {
	const copies = (dir: string) => readdirSync(dir).filter((f) => f.includes('.pre-migration-')).sort();
	/** A database one migration behind the current ones, holding one work order. */
	function behind() {
		const dir = tempDir();
		const path = join(dir, 'opal.db');
		openDb(path, migrationsUpTo('0004_skip_required_gate'));
		seedWorkOrder(path, 'aborted');
		return { dir, path };
	}

	test('an upgrade leaves a readable copy of the database as it was', () => {
		const { dir, path } = behind();
		openDb(path);
		const [copy] = copies(dir);
		const old = new Database(join(dir, copy!), { readonly: true });
		expect(old.query('SELECT status FROM execution').all()).toEqual([{ status: 'aborted' }]);
		old.close();
		const db = new Database(path);
		expect(db.query('SELECT status FROM execution').all()).toEqual([{ status: 'closed_short' }]);
		db.close();
	});

	test('the copy is private to the account that runs OPAL', () => {
		const { dir, path } = behind();
		openDb(path);
		const mode = statSync(join(dir, copies(dir)[0]!)).mode & 0o777;
		if (process.platform !== 'win32') expect(mode).toBe(0o600);
	});

	test('opening a new database or one with nothing pending takes no copy', () => {
		const dir = tempDir();
		const path = join(dir, 'opal.db');
		openDb(path);
		openDb(path);
		expect(copies(dir)).toEqual([]);
	});

	test('only the three newest copies are kept', () => {
		const { dir, path } = behind();
		for (const stamp of ['2026-01-01', '2026-01-02', '2026-01-03']) writeFileSync(join(dir, `opal.pre-migration-${stamp}.db`), 'x');
		openDb(path);
		const left = copies(dir);
		expect(left.length).toBe(3);
		expect(left).not.toContain('opal.pre-migration-2026-01-01.db');
		expect(left).toContain('opal.pre-migration-2026-01-03.db');
	});

	test('a copy that cannot be taken stops the upgrade and leaves the database as it was', () => {
		const { path } = behind();
		const applied = () => count(path, '__drizzle_migrations');
		const before = applied();
		expect(() =>
			openDb(path, MIGRATIONS_DIR, () => {
				throw new Error('disk full');
			})
		).toThrow('disk full');
		expect(applied()).toBe(before);
		const db = new Database(path);
		expect(db.query('SELECT status FROM execution').all()).toEqual([{ status: 'aborted' }]);
		db.close();
	});

	test('a failed copy says the database was left as it was and leaves no partial file', () => {
		const { dir, path } = behind();
		const db = new Database(path);
		expect(() => snapshotBeforeMigrating(db, join(path, 'not-a-folder', 'opal.db'))).toThrow(/left as it was/);
		db.close();
		expect(copies(dir)).toEqual([]);
	});
});

describe('retiring the aborted status', () => {
	/** A database as it stood before the status changed, holding one work order. */
	function older(status: string, reason: string | null = null) {
		const path = join(tempDir(), 'opal.db');
		openDb(path, migrationsUpTo('0004_skip_required_gate'));
		seedWorkOrder(path, status);
		const db = new Database(path);
		db.run('UPDATE execution SET abort_reason = ? WHERE id = 1', [reason]);
		db.close();
		return path;
	}
	const read = (path: string, sql: string) => {
		const db = new Database(path);
		const rows = db.query(sql).all();
		db.close();
		return rows;
	};

	test('an aborted work order reads closed short after the upgrade, with its steps and reason', () => {
		const path = older('aborted', 'wrong part');
		openDb(path);
		expect(read(path, 'SELECT status, abort_reason FROM execution')).toEqual([{ status: 'closed_short', abort_reason: 'wrong part' }]);
		expect(count(path, 'step_execution')).toBe(1);
		expect(count(path, 'signoff')).toBe(1);
	});

	test('a work order in any other status keeps it through the upgrade', () => {
		const path = older('in_work');
		openDb(path);
		expect(read(path, 'SELECT status FROM execution')).toEqual([{ status: 'in_work' }]);
	});

	test('every column of an upgraded work order holds the value it held before', () => {
		const path = older('completed', 'n/a');
		const before = read(path, 'SELECT * FROM execution');
		openDb(path);
		expect(read(path, 'SELECT * FROM execution')).toEqual(before as never);
	});

	test('the upgraded table refuses aborted and takes the new statuses', () => {
		const path = older('cut');
		const db = openDb(path).$client;
		expect(() => db.run("UPDATE execution SET status = 'aborted' WHERE id = 1")).toThrow();
		db.run("UPDATE execution SET status = 'void' WHERE id = 1");
		db.run("UPDATE execution SET status = 'closed_short' WHERE id = 1");
	});

	test('an existing engineer role gets the close-short gate once, and an admin removal sticks', () => {
		const path = older('cut');
		const db = new Database(path);
		db.run("INSERT INTO role (id, name, key, is_system, created_at, updated_at) VALUES (1, 'Engineer', 'engineer', 1, 'x', 'x')");
		db.close();
		const gates = () => read(path, "SELECT gate FROM role_gate WHERE gate = 'execution.closeShort'");
		const upgraded = openDb(path).$client;
		expect(gates()).toEqual([{ gate: 'execution.closeShort' }]);
		upgraded.run("DELETE FROM role_gate WHERE gate = 'execution.closeShort'");
		openDb(path);
		expect(gates()).toEqual([]);
	});
});
