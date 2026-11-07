/**
 * What a stopped or crashed run leaves behind. A crash in 1.x, or in the import, loses nothing, and the
 * original stays recoverable.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.ts';
import { hasAlembicVersion, importInPlace, importLegacy, importPending, mightBeLegacy, openSchemaImportDb, reportSummary } from '../src/import/index.ts';
import { buildLegacyFixture } from './fixtures/legacy-data.ts';

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-import-files-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const open = (path: string) => openSchemaImportDb(path);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const names = (path: string) => (new Database(path).query('SELECT name FROM part ORDER BY id').all() as { name: string }[]).map((r) => r.name);

/** The folder as 1.x leaves it when it dies in the middle of a write. */
function crashedFolder(): { dir: string; src: string; committed: string[] } {
	const from = tmp();
	const live = buildLegacyFixture(from);
	const db = new Database(live);
	db.run('PRAGMA journal_mode = DELETE');
	const committed = (db.query('SELECT name FROM part ORDER BY id').all() as { name: string }[]).map((r) => r.name);
	db.run('PRAGMA cache_size = 1');
	db.run('BEGIN');
	db.run("UPDATE part SET name = 'torn ' || name, description = hex(randomblob(2000))");
	db.run("UPDATE app_setting SET value = value");
	db.run("UPDATE issue SET title = 'torn ' || title");
	const dir = tmp();
	const src = join(dir, 'opal.db');
	copyFileSync(live, src);
	copyFileSync(`${live}-journal`, `${src}-journal`);
	db.run('ROLLBACK');
	db.close();
	Bun.spawnSync(['cp', '-r', join(from, 'attachments'), dir]);
	return { dir, src, committed };
}

describe('1.x stopped in the middle of a write', () => {
	test('the test folder really does hold a torn file', () => {
		const { dir, src } = crashedFolder();
		copyFileSync(src, join(dir, 'alone.db'));
		const torn = names(join(dir, 'alone.db'));
		expect(torn.some((n) => n.startsWith('torn '))).toBe(true);
	});

	test('the import reads what was committed, not the unfinished write', async () => {
		const { src, dir, committed } = crashedFolder();
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(report.warnings.some((w) => w.includes('unfinished write'))).toBe(true);
		const fresh = new Database(join(dir, 'opal.db'));
		expect((fresh.query('SELECT name FROM part ORDER BY id').all() as { name: string }[]).map((r) => r.name)).toEqual(committed);
		expect((fresh.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
		fresh.close();
	});

	test('the new database does not land beside the journal of the old one', async () => {
		const { src, dir } = crashedFolder();
		await importInPlace(src, { open, acceptFailedRows: true });
		expect(existsSync(join(dir, 'opal.db-journal'))).toBe(false);
		expect(existsSync(join(dir, 'opal.legacy.db-journal'))).toBe(true);
	});

	test('the original moves with its journal, and opens to what was committed', async () => {
		const { src, dir, committed } = crashedFolder();
		const before = { main: sha(src), journal: sha(`${src}-journal`) };
		await importInPlace(src, { open, acceptFailedRows: true });
		expect(sha(join(dir, 'opal.legacy.db'))).toBe(before.main);
		expect(sha(join(dir, 'opal.legacy.db-journal'))).toBe(before.journal);
		// On a copy, because opening it plays the journal back.
		const check = tmp();
		copyFileSync(join(dir, 'opal.legacy.db'), join(check, 'opal.legacy.db'));
		copyFileSync(join(dir, 'opal.legacy.db-journal'), join(check, 'opal.legacy.db-journal'));
		expect(names(join(check, 'opal.legacy.db'))).toEqual(committed);
	});

	test('a journal that names another file is refused before SQLite can follow it', async () => {
		const { src, dir } = crashedFolder();
		const victim = join(dir, 'victim.txt');
		writeFileSync(victim, 'keep me');
		const name = Buffer.from(victim);
		const tail = Buffer.alloc(16);
		tail.writeUInt32BE(name.length, 0);
		Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(tail, 8);
		appendFileSync(`${src}-journal`, Buffer.concat([name, tail]));
		const before = sha(src);
		await expect(importInPlace(src, { open, acceptFailedRows: true })).rejects.toThrow('names another journal');
		expect(readFileSync(victim, 'utf8')).toBe('keep me');
		expect(sha(src)).toBe(before);
	});

	test('a damaged file is refused and stays where it was', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const bytes = readFileSync(src);
		bytes.fill(0xee, 4096, 12288);
		writeFileSync(src, bytes);
		const before = sha(src);
		await expect(importInPlace(src, { open, acceptFailedRows: true })).rejects.toThrow(/damaged|malformed/);
		expect(sha(src)).toBe(before);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(false);
		expect(existsSync(join(dir, 'opal.db.new'))).toBe(false);
	});
});

describe('a 1.x database in WAL mode stopped without closing', () => {
	/** Committed rows that are only in the -wal file, as a killed 1.4 leaves them. */
	function walFolder(): { dir: string; src: string } {
		const from = tmp();
		const live = buildLegacyFixture(from);
		const db = new Database(live);
		db.run('PRAGMA journal_mode = WAL');
		db.run('PRAGMA wal_autocheckpoint = 0');
		db.run("UPDATE part SET name = 'only in the wal ' || name");
		const dir = tmp();
		const src = join(dir, 'opal.db');
		copyFileSync(live, src);
		copyFileSync(`${live}-wal`, `${src}-wal`);
		copyFileSync(`${live}-shm`, `${src}-shm`);
		db.close();
		Bun.spawnSync(['cp', '-r', join(from, 'attachments'), dir]);
		return { dir, src };
	}

	test('the import reads what only the -wal file holds', async () => {
		const { dir, src } = walFolder();
		await importInPlace(src, { open, acceptFailedRows: true });
		const fresh = new Database(join(dir, 'opal.db'));
		const rows = fresh.query('SELECT name FROM part').all() as { name: string }[];
		fresh.close();
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.name.startsWith('only in the wal '))).toBe(true);
	});

	test('the original moves with its -wal and -shm, both unchanged, and none stays beside the new file', async () => {
		const { dir, src } = walFolder();
		const before = { main: sha(src), wal: sha(`${src}-wal`), shm: sha(`${src}-shm`) };
		await importInPlace(src, { open, acceptFailedRows: true });
		const legacy = join(dir, 'opal.legacy.db');
		expect({ main: sha(legacy), wal: sha(`${legacy}-wal`), shm: sha(`${legacy}-shm`) }).toEqual(before);
		const check = tmp();
		copyFileSync(legacy, join(check, 'opal.legacy.db'));
		copyFileSync(`${legacy}-wal`, join(check, 'opal.legacy.db-wal'));
		expect(names(join(check, 'opal.legacy.db')).every((n) => n.startsWith('only in the wal '))).toBe(true);
	});
});

describe('the private copy', () => {
	const copies = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('opal-import-src-'));

	test('a copy left by a killed run is removed by the next run', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		mkdirSync(join(dir, 'opal-import-src-left'));
		writeFileSync(join(dir, 'opal-import-src-left', 'source.db'), 'plaintext');
		await importInPlace(src, { open, acceptFailedRows: true });
		expect(copies(dir)).toEqual([]);
	});

	test('half an avatar left by a killed run is removed by the next run', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		mkdirSync(join(dir, 'avatars'));
		writeFileSync(join(dir, 'avatars', 'half.tmp'), 'half');
		writeFileSync(join(dir, 'avatars', 'abc123'), 'an avatar');
		await importInPlace(src, { open, acceptFailedRows: true });
		expect(readdirSync(join(dir, 'avatars'))).toContain('abc123');
		expect(readdirSync(join(dir, 'avatars'))).not.toContain('half.tmp');
	});

	test('a finished import leaves no copy in the folder', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		await importInPlace(src, { open, acceptFailedRows: true });
		expect(copies(dir)).toEqual([]);
	});

	test('a refused import leaves no copy in the folder', async () => {
		const dir = tmp();
		writeFileSync(join(dir, 'opal.db'), 'not a database, and long enough to have a header at all, which it needs to be looked at. And a little more than a hundred bytes.');
		await importInPlace(join(dir, 'opal.db'), { open, acceptFailedRows: true });
		expect(copies(dir)).toEqual([]);
	});

	test('an OPAL 2 database is told apart from its first bytes, with no copy', async () => {
		const dir = tmp();
		const path = join(dir, 'opal.db');
		const db = await open(path);
		db.$client.run('PRAGMA user_version = 1');
		db.$client.run('PRAGMA wal_checkpoint(TRUNCATE)');
		db.$client.close();
		expect(mightBeLegacy(path)).toBe(false);
		expect(hasAlembicVersion(path)).toBe(false);
		expect(copies(dir)).toEqual([]);
	});

	test('a real OPAL 2 database has its mark, so its starts do not copy it', () => {
		const dir = tmp();
		const path = join(dir, 'opal.db');
		const db = openDb(path);
		db.$client.run('PRAGMA wal_checkpoint(TRUNCATE)');
		db.$client.close();
		expect(mightBeLegacy(path)).toBe(false);
	});

	test('a 1.x database is still seen, in either journal mode', () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		expect(mightBeLegacy(src)).toBe(true);
		expect(hasAlembicVersion(src)).toBe(true);
		const db = new Database(src);
		db.run('PRAGMA journal_mode = WAL');
		db.close();
		expect(mightBeLegacy(src)).toBe(true);
		expect(hasAlembicVersion(src)).toBe(true);
	});
});

describe('stopped between the renames', () => {
	/** A finished import, then the folder put back to how it was at each point of the swap. */
	async function finished() {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		await importInPlace(src, { open, acceptFailedRows: true });
		return { src, ready: join(dir, 'opal.db.imported'), legacy: join(dir, 'opal.legacy.db') };
	}

	test('before the first rename, the next start finishes the swap', async () => {
		const { src, ready, legacy } = await finished();
		const newBytes = sha(src);
		const oldBytes = sha(legacy);
		copyFileSync(src, ready);
		copyFileSync(legacy, src);
		rmSync(legacy);
		expect(importPending(src)).toBe(true);
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(report.dest).toBe(src);
		expect(sha(src)).toBe(newBytes);
		expect(sha(legacy)).toBe(oldBytes);
		expect(existsSync(ready)).toBe(false);
	});

	test('with the old file moved and its journal not, the next start moves the journal first', async () => {
		const { src, ready, legacy } = await finished();
		const newBytes = sha(src);
		copyFileSync(src, ready);
		rmSync(src);
		writeFileSync(`${src}-journal`, 'the journal of the old file');
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(report.dest).toBe(src);
		expect(sha(src)).toBe(newBytes);
		expect(existsSync(`${src}-journal`)).toBe(false);
		expect(readFileSync(`${legacy}-journal`, 'utf8')).toBe('the journal of the old file');
	});

	test('with the database gone and an unfinished result, OPAL stops and does not start empty', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const legacy = join(dir, 'opal.legacy.db');
		copyFileSync(src, legacy);
		rmSync(src);
		writeFileSync(`${src}.new`, 'half made');
		expect(importPending(src)).toBe(true);
		await expect(importInPlace(src, { open, acceptFailedRows: true })).rejects.toThrow('did not finish');
		expect(existsSync(src)).toBe(false);
	});

	test('a result from a stopped run is removed and the import runs again', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		writeFileSync(`${src}.new`, 'half made');
		expect(await importInPlace(src, { open, acceptFailedRows: true })).not.toBeNull();
		expect(existsSync(`${src}.new`)).toBe(false);
		expect(statSync(src).size).toBeGreaterThan(100);
	});
});

describe('a bad result', () => {
	test('one failed row leaves the old database where it was, and the report names the row', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const before = sha(src);
		await expect(importInPlace(src, { open })).rejects.toThrow(/Did not import .*rows failed.*--accept-failed-rows/);
		expect(sha(src)).toBe(before);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(false);
		expect(existsSync(join(dir, 'opal.db.new'))).toBe(false);
		expect(existsSync(join(dir, 'opal.db.imported'))).toBe(false);
		const report = readFileSync(join(dir, 'import-report.txt'), 'utf8');
		expect(report).toContain('Did not import');
		expect(report).toContain('Result: not written');
		expect(report).toContain('attachment 4: file a4-missing.png is missing');
	});

	test('a refused import takes back the files it added', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		await expect(importInPlace(src, { open })).rejects.toThrow('Did not import');
		expect(existsSync(join(dir, 'blobs')) ? readdirSync(join(dir, 'blobs')) : []).toEqual([]);
	});

	test('a person can accept the failed rows, and the report says so', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(report.acceptedFailures).toBe(true);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(true);
		expect(reportSummary(report, dir)).toContain('(accepted)');
		expect(readFileSync(join(dir, 'import-report.txt'), 'utf8')).toContain('--accept-failed-rows was given');
	});

	test('rows nothing explains refuse the swap too', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const db = new Database(src);
		db.run('CREATE TABLE nothing_reads_this (id INTEGER PRIMARY KEY)');
		db.run('INSERT INTO nothing_reads_this VALUES (1)');
		db.close();
		await expect(importInPlace(src, { open })).rejects.toThrow('not accounted for');
	});

	test('attachment rows with no folder are refused, pointing at the flag', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		rmSync(join(dir, 'attachments'), { recursive: true });
		const before = sha(src);
		await expect(importInPlace(src, { open })).rejects.toThrow(/attachments.*not there.*--attachments <folder>/);
		expect(sha(src)).toBe(before);
	});

	test('the folder can be named instead', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const elsewhere = join(dir, 'moved');
		renameSync(join(dir, 'attachments'), elsewhere);
		const report = (await importInPlace(src, { open, acceptFailedRows: true, attachmentsDir: elsewhere }))!;
		expect(report.failedRows.filter((f) => f.table === 'attachment').length).toBe(1);
	});

	test('a database that lacks what its stamp claims is refused, naming what is missing', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const db = new Database(src);
		db.run('ALTER TABLE step_note DROP COLUMN body');
		db.close();
		const before = sha(src);
		await expect(importInPlace(src, { open, acceptFailedRows: true })).rejects.toThrow(/step_note\.body.*Its stamp may be wrong/);
		expect(sha(src)).toBe(before);
	});
});

describe('opal import', () => {
	test('a failed import leaves nothing at the destination that looks like a new install', async () => {
		const dir = tmp();
		const src = join(dir, 'old.db');
		const db = new Database(src);
		db.run('CREATE TABLE alembic_version (version_num TEXT)');
		db.run("INSERT INTO alembic_version VALUES ('b8d2f1a5c3e0')");
		db.close();
		const out = join(tmp(), 'new.db');
		await expect(importLegacy(src, out, { acceptFailedRows: true, open: async (p) => { await open(p); throw new Error('stopped'); } })).rejects.toThrow();
		expect(existsSync(out)).toBe(false);
	});

	test('the source folder gets no copy when the destination is elsewhere', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const before = readdirSync(dir).sort();
		const out = join(tmp(), 'new.db');
		await importLegacy(src, out, { open, acceptFailedRows: true });
		expect(readdirSync(dir).sort()).toEqual(before);
	});
});
