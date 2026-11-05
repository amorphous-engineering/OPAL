import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR, openDb } from '../../src/db/client.ts';

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

	test('the cut folder helper builds a database at an older migration', () => {
		const path = join(tempDir(), 'opal.db');
		openDb(path, migrationsUpTo('0004_skip_required_gate'));
		expect(count(path, 'execution')).toBe(0);
	});
});
