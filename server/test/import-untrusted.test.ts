/**
 * A legacy database and its folder may come from someone else. Nothing in them gets to run, to reach
 * another file, or to change the original.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importInPlace, importLegacy, openSchemaImportDb } from '../src/import/index.ts';
import { buildLegacyFixture } from './fixtures/legacy-data.ts';

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-untrusted-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const open = (path: string) => openSchemaImportDb(path);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('names in the file', () => {
	const stray = (dir: string) => join(dir, 'stray.db');

	test('a column name that is really a statement is refused and runs nothing', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const db = new Database(src);
		const name = `z" FROM part; ATTACH DATABASE '${stray(dir)}' AS other; CREATE TABLE other.t(x); --`;
		db.run(`ALTER TABLE part ADD COLUMN "${name.replaceAll('"', '""')}" TEXT`);
		db.close();
		const before = sha(src);
		await expect(importInPlace(src, { open })).rejects.toThrow('no OPAL 1.x made');
		expect(existsSync(stray(dir))).toBe(false);
		expect(sha(src)).toBe(before);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(false);
	});

	test('a trigger name that is really a statement is refused and runs nothing', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const db = new Database(src);
		const name = `t"; ATTACH DATABASE '${stray(dir)}' AS other; CREATE TABLE other.t(x); --`;
		db.run(`CREATE TRIGGER "${name.replaceAll('"', '""')}" AFTER INSERT ON part BEGIN SELECT 1; END`);
		db.close();
		const before = sha(src);
		await expect(importInPlace(src, { open })).rejects.toThrow('no OPAL 1.x made');
		expect(existsSync(stray(dir))).toBe(false);
		expect(sha(src)).toBe(before);
	});
});

describe('files named in rows', () => {
	const issueAttachment = (src: string, stored: string) => {
		const db = new Database(src);
		db.query('UPDATE attachment SET stored_filename = ? WHERE id = (SELECT MIN(id) FROM attachment)').run(stored);
		db.close();
	};

	test.each([
		['a path out of the folder', '../secret.key'],
		['an absolute path', '/etc/hostname'],
		['a device', '../../../../../../../../dev/zero'],
		['an empty name', ''],
		['the folder itself', '.']
	])('%s is a failed row and nothing is read', async (_what, stored) => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		writeFileSync(join(dir, 'secret.key'), 'top secret');
		issueAttachment(src, stored);
		const report = await importLegacy(src, join(dir, 'new.db'), { open });
		expect(report.failedRows.some((f) => f.table === 'attachment')).toBe(true);
		const stolen = createHash('sha256').update('top secret').digest('hex');
		expect(existsSync(join(dir, 'blobs', stolen))).toBe(false);
	});

	test('a link inside the folder that leads out of it is a failed row', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		writeFileSync(join(dir, 'secret.key'), 'top secret');
		symlinkSync(join(dir, 'secret.key'), join(dir, 'attachments', 'innocent.png'));
		issueAttachment(src, 'innocent.png');
		const report = await importLegacy(src, join(dir, 'new.db'), { open });
		expect(report.failedRows.some((f) => f.table === 'attachment' && f.reason.includes('not a regular file'))).toBe(true);
		expect(existsSync(join(dir, 'blobs', createHash('sha256').update('top secret').digest('hex')))).toBe(false);
	});

	test('a folder link in the middle of the path that leads out of it is a failed row', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		mkdirSync(join(dir, 'elsewhere'));
		writeFileSync(join(dir, 'elsewhere', 'secret.key'), 'top secret');
		symlinkSync(join(dir, 'elsewhere'), join(dir, 'attachments', 'sub'));
		issueAttachment(src, 'sub/secret.key');
		const report = await importLegacy(src, join(dir, 'new.db'), { open });
		expect(report.failedRows.some((f) => f.table === 'attachment' && f.reason.includes('leads outside'))).toBe(true);
	});

	test('a pipe in the folder does not hang the import', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		Bun.spawnSync(['mkfifo', join(dir, 'attachments', 'pipe.png')]);
		issueAttachment(src, 'pipe.png');
		const report = await importLegacy(src, join(dir, 'new.db'), { open });
		expect(report.failedRows.some((f) => f.table === 'attachment' && f.reason.includes('not a regular file'))).toBe(true);
	});

	test('an avatar name reads nothing outside the avatars folder', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		writeFileSync(join(dir, 'secret.key'), 'top secret');
		const db = new Database(src);
		db.query('UPDATE user SET avatar_filename = ?, avatar_source = ? WHERE id = (SELECT MIN(id) FROM user)').run('../../secret.key', 'upload');
		db.close();
		const report = await importLegacy(src, join(dir, 'new.db'), { open });
		expect(report.failedRows.some((f) => f.table === 'user' && f.reason.startsWith('avatar'))).toBe(true);
		expect(existsSync(join(dir, 'avatars', createHash('sha256').update('top secret').digest('hex')))).toBe(false);
	});

	test('a short file left under a hash by a stopped run is replaced with the whole file', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const db = new Database(src);
		const row = db.query('SELECT stored_filename AS name FROM attachment ORDER BY id LIMIT 1').get() as { name: string };
		db.close();
		const whole = readFileSync(join(dir, 'attachments', row.name));
		const hash = createHash('sha256').update(whole).digest('hex');
		mkdirSync(join(dir, 'blobs'));
		writeFileSync(join(dir, 'blobs', hash), whole.subarray(0, 3));
		await importLegacy(src, join(dir, 'new.db'), { open });
		expect(createHash('sha256').update(readFileSync(join(dir, 'blobs', hash))).digest('hex')).toBe(hash);
	});

	test('a file the failed import added is taken back, and one it found is left alone', async () => {
		const dir = tmp();
		const src = buildLegacyFixture(dir);
		const failing = async (path: string) => {
			const db = await open(path);
			db.$client.run('CREATE TRIGGER stop BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, \'stopped on purpose\'); END');
			return db;
		};
		mkdirSync(join(dir, 'blobs'));
		writeFileSync(join(dir, 'blobs', 'found-here'), 'x');
		await expect(importLegacy(src, join(dir, 'new.db'), { open: failing })).rejects.toThrow('stopped on purpose');
		expect(readdirSync(join(dir, 'blobs'))).toEqual(['found-here']);
		expect(existsSync(join(dir, 'new.db'))).toBe(false);
	});
});
