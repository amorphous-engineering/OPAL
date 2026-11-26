import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoPackPath, writeDemo } from '../../src/services/reports/demo.ts';

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-pack-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// From the sources the pack is built once and cached; the first build loads the dataset.
beforeAll(() => void demoPackPath(), 600_000);

const count = (db: Database, t: string) => (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('demo pack', () => {
	test('a new demo is Mojave Sphinx, with its photos in the demo folder', () => {
		const dir = tmp();
		const file = join(dir, 'demo.opal.db');
		const folder = join(dir, 'demo.opal.db-attachments');
		writeDemo(file, folder);
		const db = new Database(file, { readonly: true });
		try {
			expect([count(db, 'project'), count(db, 'procedure'), count(db, 'execution')]).toEqual([1, 21, 35]);
			expect(count(db, 'part')).toBeGreaterThan(150);
			const hashes = (db.query('SELECT sha256 FROM blob').all() as { sha256: string }[]).map((r) => r.sha256);
			expect(hashes.length).toBeGreaterThan(0);
			for (const h of hashes) expect(existsSync(join(folder, 'blobs', h))).toBe(true);
			expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	test('a demo carries no sign-in, instance id or pack table of its own', () => {
		const dir = tmp();
		const file = join(dir, 'demo.opal.db');
		writeDemo(file, join(dir, 'files'));
		const db = new Database(file, { readonly: true });
		try {
			expect(count(db, 'session')).toBe(0);
			expect(count(db, 'api_token')).toBe(0);
			expect(count(db, 'auth_setting')).toBe(0);
			expect(db.query('SELECT COUNT(*) AS n FROM user WHERE password_hash IS NOT NULL').get()).toEqual({ n: 0 });
			expect(db.query("SELECT 1 FROM app_setting WHERE key = 'instance_id'").get()).toBeNull();
			expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'demo_pack_file'").get()).toBeNull();
		} finally {
			db.close();
		}
	});

	test('a pack file named outside the demo folder is not written', () => {
		const dir = tmp();
		const pack = join(dir, 'pack.db');
		const db = new Database(demoPackPath(), { readonly: true });
		db.run('VACUUM INTO ?', [pack]);
		db.close();
		const evil = new Database(pack);
		evil.run("INSERT INTO demo_pack_file (path, data) VALUES ('../escaped', x'00'), ('blobs/../../escaped2', x'00'), ('keys/.opal_secrets_key', x'00')");
		evil.close();
		const saved = process.env.OPAL_DEMO_PACK;
		process.env.OPAL_DEMO_PACK = pack;
		try {
			const folder = join(dir, 'demo', 'files');
			writeDemo(join(dir, 'demo', 'demo.opal.db'), folder);
			expect(readdirSync(join(dir, 'demo')).sort()).toEqual(['demo.opal.db', 'files']);
			expect(readdirSync(folder)).toEqual(['blobs']);
			expect(existsSync(join(dir, 'escaped'))).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.OPAL_DEMO_PACK;
			else process.env.OPAL_DEMO_PACK = saved;
		}
	});
});
