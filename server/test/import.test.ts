import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importInPlace, importLegacy, LEGACY_HEAD, OLD_VERSION_MESSAGE } from '../src/import/index.ts';
import { openDb } from '../src/db/client.ts';
import { part } from '../src/db/schema.ts';

const SCHEMA = join(import.meta.dir, 'fixtures/legacy-schema.sql');
const SEED = join(import.meta.dir, '../../notes/fixtures/legacy-seed.db');
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-import-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function legacyDb(path: string, version = LEGACY_HEAD): void {
	const db = new Database(path, { create: true });
	db.exec(readFileSync(SCHEMA, 'utf8'));
	db.run('DELETE FROM alembic_version');
	db.run('INSERT INTO alembic_version VALUES (?)', [version]);
	db.run(
		`INSERT INTO user (id, name, username, password_hash, email, oidc_issuer, oidc_subject,
			is_active, is_admin, needs_profile_setup, needs_onboarding, job_title, created_at, updated_at)
		 VALUES (7, 'Ada', 'ada', 'argon2$hash', 'ada@x.test', 'https://id.test', 'sub-1', 1, 1, 0, 0, 'Lead',
			'2026-10-24 09:16:24.601408', '2026-10-24 09:16:25.5')`
	);
	db.run(
		`INSERT INTO api_token (id, user_id, name, token_hash, created_at, updated_at, last_used_at)
		 VALUES (3, 7, 'cli', 'abc123', '2026-10-24 09:16:24.601408', '2026-10-24 09:16:24.601408', '2026-10-25 01:02:03')`
	);
	const part = `INSERT INTO part (id, internal_pn, name, unit_of_measure, tracking_type, procurement, tier,
		reorder_point, is_tooling, lifecycle_state, created_at, updated_at, deleted_at, activated_at, activated_by_id, parent_id)
		VALUES (?, ?, ?, 'ea', 'bulk', 'buy', 2, ?, 0, ?, '2026-10-24 09:16:24.601408', '2026-10-24 09:16:24.601408', ?, ?, ?, ?)`;
	db.run(part, [10, 'P-0010', 'Washer', 1.2345, 'active', null, '2026-01-02 03:04:05.678912', 7, null]);
	db.run(part, [11, 'P-0011', 'Gone', null, 'active', '2026-05-05 00:00:00', null, null, 10]);
	db.run(part, [12, null, 'No number', 0.0001, 'draft', null, null, null, null]);
	db.close();
}

describe('legacy import', () => {
	const dir = tmp();
	const src = join(dir, 'legacy.db');
	const dest = join(dir, 'new.db');
	legacyDb(src);
	const report = importLegacy(src, dest);
	const out = new Database(dest, { readonly: true });
	const q = (s: string) => out.query(s).all() as Record<string, unknown>[];

	test('keeps ids and copies auth fields verbatim', () => {
		expect(q('SELECT id, username, password_hash, email, oidc_issuer, oidc_subject, is_active, is_admin FROM user')).toEqual([
			{ id: 7, username: 'ada', password_hash: 'argon2$hash', email: 'ada@x.test', oidc_issuer: 'https://id.test', oidc_subject: 'sub-1', is_active: 1, is_admin: 1 }
		]);
		expect(q('SELECT id, user_id, token_hash FROM api_token')).toEqual([{ id: 3, user_id: 7, token_hash: 'abc123' }]);
		expect(q('SELECT id FROM part ORDER BY id').map((r) => r.id)).toEqual([10, 11, 12]);
	});

	test('converts timestamps to ISO 8601 milliseconds with Z', () => {
		expect(q('SELECT created_at, updated_at FROM user')[0]).toEqual({
			created_at: '2026-10-24T09:16:24.601Z',
			updated_at: '2026-10-24T09:16:25.500Z'
		});
		expect(q('SELECT last_used_at FROM api_token')[0]?.last_used_at).toBe('2026-10-25T01:02:03.000Z');
		expect(q('SELECT activated_at FROM part WHERE id = 10')[0]?.activated_at).toBe('2026-01-02T03:04:05.678Z');
	});

	test('quantities are exact integers in Qty units', () => {
		const r = q('SELECT id, reorder_point FROM part ORDER BY id');
		expect(r.map((x) => x.reorder_point)).toEqual([12345, null, 1]);
	});

	test('deleted part becomes obsolete and is listed', () => {
		expect(q('SELECT state FROM part ORDER BY id').map((r) => r.state)).toEqual(['active', 'obsolete', 'draft']);
		expect(report.obsoleteParts).toEqual([{ id: 11, internalPn: 'P-0011' }]);
	});

	test('missing part number becomes LEGACY-<id> and is listed', () => {
		expect(q('SELECT internal_pn FROM part WHERE id = 12')[0]?.internal_pn).toBe('LEGACY-12');
		expect(report.placeholderPns).toEqual([{ id: 12, internalPn: 'LEGACY-12' }]);
	});

	test('sequences sit at or above the highest id', () => {
		const seq = Object.fromEntries(q('SELECT name, seq FROM sqlite_sequence').map((r) => [r.name, r.seq]));
		expect(seq.user).toBeGreaterThanOrEqual(7);
		expect(seq.api_token).toBeGreaterThanOrEqual(3);
		expect(seq.part).toBeGreaterThanOrEqual(12);
		const w = new Database(dest);
		w.run("INSERT INTO user (username, name, created_at, updated_at) VALUES ('n', 'N', 'x', 'x')");
		w.close();
		expect(q('SELECT MAX(id) AS m FROM user')[0]?.m).toBe(8);
	});

	test('writes one summary audit row per table and reports the rest', () => {
		const rows = q("SELECT op, action, entity FROM audit_log WHERE entity = 'import'");
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.op === 'legacy.import' && r.action === 'create')).toBe(true);
		expect(report.tables.part.droppedColumns).toContain('parent_id');
		expect(report.notImported.some((t) => t.table === 'bom_lines' || t.table === 'workcenter')).toBe(true);
		expect(report.notImported.some((t) => t.table.includes('_fts'))).toBe(false);
	});

	test('refuses a wrong alembic version', () => {
		const old = join(tmp(), 'old.db');
		legacyDb(old, 'deadbeef0000');
		expect(() => importLegacy(old, join(dirname(old), 'x.db'))).toThrow(OLD_VERSION_MESSAGE);
	});

	test('refuses an existing destination', () => {
		expect(() => importLegacy(src, dest)).toThrow('already exists');
	});
});

function dirname(p: string): string {
	return p.slice(0, p.lastIndexOf('/'));
}

describe('importInPlace', () => {
	test('renames the old file, leaves it byte-identical, writes reports', () => {
		const d = tmp();
		const p = join(d, 'opal.db');
		legacyDb(p);
		const before = readFileSync(p);
		const report = importInPlace(p);
		expect(report?.tables.part.imported).toBe(3);
		expect(readFileSync(join(d, 'opal.legacy.db')).equals(before)).toBe(true);
		expect(existsSync(`${p}.new`)).toBe(false);
		expect(existsSync(join(d, 'import-report.txt'))).toBe(true);
		expect(JSON.parse(readFileSync(join(d, 'import-report.json'), 'utf8')).tables.user.imported).toBe(1);
		expect(importInPlace(p)).toBeNull();
	});

	test('the renamed file is complete on its own: no WAL left behind, every row readable', () => {
		const d = tmp();
		const p = join(d, 'opal.db');
		legacyDb(p);
		importInPlace(p);
		expect(existsSync(`${p}.new-wal`)).toBe(false);
		const db = openDb(p);
		expect(db.select().from(part).all()).toHaveLength(3);
		db.$client.close();
	});

	test('refuses when opal.legacy.db exists', () => {
		const d = tmp();
		const p = join(d, 'opal.db');
		legacyDb(p);
		legacyDb(join(d, 'opal.legacy.db'));
		const before = readFileSync(p);
		expect(() => importInPlace(p)).toThrow('already exists');
		expect(readFileSync(p).equals(before)).toBe(true);
	});
});

describe('seeded demo database', () => {
	test.skipIf(!existsSync(SEED))('imports with zero failed rows', () => {
		const d = tmp();
		const copy = join(d, 'seed.db');
		copyFileSync(SEED, copy);
		const report = importLegacy(copy, join(d, 'out.db'));
		console.log(JSON.stringify({ tables: report.tables, obsolete: report.obsoleteParts.length, placeholders: report.placeholderPns.length, warnings: report.warnings, notImported: report.notImported.length }));
		expect(report.failedRows).toEqual([]);
		expect(report.tables.part.imported).toBe(report.tables.part.read);
	});
});
