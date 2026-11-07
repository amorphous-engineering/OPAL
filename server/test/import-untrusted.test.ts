/**
 * A legacy database and its folder may come from someone else. Nothing in them gets to run, to reach
 * another file, or to change the original.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importInPlace, openSchemaImportDb } from '../src/import/index.ts';
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
