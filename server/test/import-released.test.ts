/**
 * Databases made by the released 1.x code import. The files in fixtures/legacy-released come from
 * build.sh in that folder, which runs the code at each release tag. `<name>.alembic` is the same
 * database taken forward by real Alembic, so the bridge is checked against what 1.x would do.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zProcedureDataSchema, zProcedureSnapshot } from '@opal/shared';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.ts';
import { openDb } from '../src/db/client.ts';
import { user } from '../src/db/schema/index.ts';
import { bridgeToHead, canBridge, RELEASED_HEADS } from '../src/import/bridge.ts';
import { checkSource, importInPlace, importLegacy, LEGACY_HEAD, OLD_VERSION_MESSAGE, openSchemaImportDb, renderReport, reportSummary } from '../src/import/index.ts';
import { firstAdminClaimLinks } from '../src/services/auth/claim.ts';
import { buildLegacyFixture } from './fixtures/legacy-data.ts';

const FIXTURES = join(import.meta.dir, 'fixtures/legacy-released');
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-released-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Row = Record<string, unknown>;
const open = (path: string) => openSchemaImportDb(path);
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Writes one fixture into `dir` as opal.db, with its attachments and project file. */
function unpack(name: string, dir: string, fileName = 'opal.db'): string {
	const path = join(dir, fileName);
	writeFileSync(path, Bun.gunzipSync(new Uint8Array(readFileSync(join(FIXTURES, `${name}.db.gz`)))));
	const files = join(FIXTURES, `${name}.attachments.tgz`);
	if (existsSync(files)) Bun.spawnSync(['tar', '-xzf', files, '-C', dir]);
	const project = join(FIXTURES, `${name}.project.yaml`);
	if (existsSync(project)) copyFileSync(project, join(dir, 'opal.project.yaml'));
	return path;
}

/** Every release that moved the Alembic head, with the revision its database carries. */
const RELEASES: [name: string, revision: string][] = [
	['v1.2.8', '00d3ac121e5e'],
	['v1.3.0-beta', 'a310ab9da1d8'],
	['v1.3.0', '0c42f39a04cc'],
	['v1.3.2', '8a5444d1e3e6'],
	['v1.3.2-migrated', '8a5444d1e3e6'],
	['v1.4.0-beta.1', 'd4e8b7a2c5f1'],
	['v1.4.0-beta.2', 'c1a2b3d4e5f6'],
	['v1.4.0-beta.3', 'f3a9d2c8b501']
];

describe('a stamp is only what the file claims', () => {
	test.each(RELEASES.filter(([, revision]) => revision !== 'f3a9d2c8b501'))('%s stamped at the head is refused or reads the same', async (name) => {
		const correctDir = tmp();
		const correct = (await importInPlace(unpack(name, correctDir), { open }))!;
		const dir = tmp();
		const src = unpack(name, dir);
		const db = new Database(src);
		db.query('UPDATE alembic_version SET version_num = ?').run(LEGACY_HEAD);
		db.close();
		const before = sha(src);
		const report = await importInPlace(src, { open }).catch((e: Error) => e);
		if (report instanceof Error) {
			expect(report.message).toMatch(/Its stamp may be wrong|Could not bring/);
			expect(sha(src)).toBe(before);
			return;
		}
		expect(Object.fromEntries(Object.entries(report!.tables).map(([t, r]) => [t, r.imported]))).toEqual(Object.fromEntries(Object.entries(correct.tables).map(([t, r]) => [t, r.imported])));
	});

	test('a 1.4.0-beta.3 file stamped at the head does not lose its procedures', async () => {
		const correctDir = tmp();
		const correct = (await importInPlace(unpack('v1.4.0-beta.3', correctDir), { open }))!;
		const dir = tmp();
		const src = unpack('v1.4.0-beta.3', dir);
		const db = new Database(src);
		db.query('UPDATE alembic_version SET version_num = ?').run(LEGACY_HEAD);
		db.close();
		const report = await importInPlace(src, { open }).catch((e: Error) => e);
		if (report instanceof Error) expect(report.message).toMatch(/Its stamp may be wrong|Could not bring|Did not import/);
		else expect(report!.tables.master_procedure!.imported).toBe(correct.tables.master_procedure!.imported);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(!(report instanceof Error));
	});
});

const tableNames = (db: Database) =>
	(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && !n.includes('_fts'));
const columnNames = (db: Database, t: string) => (db.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((r) => r.name);

/** JSON is the same whatever its spacing, and floats are the same within rounding. */
function same(a: unknown, b: unknown): boolean {
	if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
	if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.from(a).equals(Buffer.from(b));
	if (typeof a === 'string' && typeof b === 'string' && /^[[{]/.test(a)) {
		try {
			return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
		} catch {
			return a === b;
		}
	}
	return a === b;
}

/** Columns a migration stamps with the time it ran. They differ between any two runs. */
const STAMPED_NOW: Record<string, string[]> = {
	part: ['activated_at'],
	role: ['created_at', 'updated_at'],
	user_role: ['granted_at'],
	step_signoff: ['created_at', 'updated_at'],
	risk_issue_link: ['created_at', 'updated_at'],
	designator_sequence: ['created_at', 'updated_at'],
	step_note: ['created_at', 'updated_at']
};

/** Left out of the bridge on purpose: the import lists them as not imported where they exist. */
const NOT_BRIDGED = ['auth_session', 'extension', 'webauthn_challenge'];

describe.each(RELEASES)('a database from %s', (name, revision) => {
	test(`is at ${revision}, and the bridge knows it`, () => {
		const d = tmp();
		const db = new Database(unpack(name, d), { readonly: true });
		expect(checkSource(db, name)).toBe(revision);
		expect(canBridge(revision)).toBe(true);
		db.close();
	});

	test('comes out of the bridge the same as out of real Alembic', () => {
		const d = tmp();
		const db = new Database(unpack(name, d));
		const report = bridgeToHead(db, revision);
		const expected = new Database(unpack(`${name}.alembic`, d, 'alembic.db'), { readonly: true });
		expect((expected.query('SELECT version_num FROM alembic_version').get() as Row).version_num).toBe(LEGACY_HEAD);

		expect(tableNames(db).sort()).toEqual(tableNames(expected).filter((t) => !NOT_BRIDGED.includes(t) || tableNames(db).includes(t)).sort());
		const problems: string[] = [];
		for (const t of tableNames(db)) {
			expect([t, columnNames(db, t).sort()]).toEqual([t, columnNames(expected, t).sort()]);
			const cols = columnNames(db, t).filter((c) => !STAMPED_NOW[t]?.includes(c));
			const order = columnNames(db, t).includes('id') ? 'id' : columnNames(db, t).includes('key') ? 'key' : 'designator_type';
			const read = (from: Database) => from.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}" ORDER BY "${order}"`).all() as Row[];
			const mine = read(db);
			const theirs = read(expected);
			expect([t, mine.length]).toEqual([t, theirs.length]);
			mine.forEach((row, i) => {
				for (const c of cols) if (!same(row[c], theirs[i]![c])) problems.push(`${t} row ${i} ${c}: ${String(row[c])} != ${String(theirs[i]![c])}`);
			});
		}
		expect(problems).toEqual([]);
		expect(report.from).toBe(revision);
		expect(report.release).toBe(RELEASED_HEADS[revision]!);
		db.close();
		expected.close();
	});
});

describe.each(RELEASES.map(([name]) => name))('importing %s', (name) => {
	const scratch = tmp();
	const dir = join(scratch, 'data');
	mkdirSync(dir);
	const src = unpack(name, dir);
	const before = sha(src);
	const sourceDb = new Database(src, { readonly: true });
	const sourceTables = (sourceDb.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name).filter((n) => !n.startsWith('sqlite_') && n !== 'alembic_version');
	const sourceCount = (t: string) => (sourceDb.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
	const reportPromise = importInPlace(src, { open });

	test('keeps the source as opal.legacy.db, byte for byte, and writes the report', async () => {
		const report = (await reportPromise)!;
		expect(sha(join(dir, 'opal.legacy.db'))).toBe(before);
		expect(report.source).toBe(join(dir, 'opal.legacy.db'));
		expect(readFileSync(join(dir, 'import-report.txt'), 'utf8')).toContain(`Alembic: ${report.alembicVersion}`);
		expect(JSON.parse(readFileSync(join(dir, 'import-report.json'), 'utf8')).sourceTables.length).toBe(sourceTables.length);
	});

	test('accounts for every table and every row of the source', async () => {
		const report = (await reportPromise)!;
		expect(report.sourceTables.map((t) => t.table).sort()).toEqual([...sourceTables].sort());
		expect(report.sourceTables.filter((t) => t.unaccounted > 0)).toEqual([]);
		for (const t of report.sourceTables) {
			if (!t.table.includes('_fts')) expect([t.table, t.rows]).toEqual([t.table, sourceCount(t.table)]);
		}
		expect(report.failedRows).toEqual([]);
		// Row counts differ only where a step explains it.
		const moved = report.sourceTables.filter((t) => report.tables[t.table] && report.tables[t.table]!.read !== t.rows).map((t) => t.table);
		const explained = [...(report.bridge?.steps ?? []).flatMap((s) => s.changes), report.projectFile ? 'app_setting' : ''].join('\n');
		for (const t of moved) expect([t, explained.includes(t)]).toEqual([t, true]);
	});

	test('lists extension and Onshape data as not imported', async () => {
		const report = (await reportPromise)!;
		const listed = new Map(report.notImported.map((n) => [n.table, n.rows]));
		expect(listed.get('onshape_link')).toBe(sourceCount('onshape_link'));
		expect(listed.get('onshape_sync_log')).toBe(sourceCount('onshape_sync_log'));
		const onshapeKeys = sourceTables.includes('app_setting') ? (sourceDb.query("SELECT COUNT(*) AS n FROM app_setting WHERE key LIKE 'onshape_%'").get() as { n: number }).n : 0;
		expect(listed.get('app_setting (onshape_*)') ?? 0).toBe(onshapeKeys);
		expect(listed.has('extension')).toBe(true);
		if (sourceTables.includes('extension')) expect(listed.get('extension')).toBe(1);
		const text = renderReport(report);
		expect(text).toContain('onshape_link');
		expect(text).toContain('extension');
	});

	test('leaves no Onshape secret in the new database', () => {
		const out = new Database(join(dir, 'opal.db'), { readonly: true });
		expect(out.query("SELECT key FROM app_setting WHERE key LIKE 'onshape%'").all()).toEqual([]);
		expect((out.query("SELECT value FROM app_setting WHERE key = 'x_site_note'").get() as Row | null)?.value ?? 'kept').toBe('kept');
		out.close();
	});

	test('has no broken references', async () => {
		await reportPromise;
		const out = new Database(join(dir, 'opal.db'), { readonly: true });
		expect(out.query('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(out.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
		out.close();
	});

	test('copies attachment files, and carries the project name', async () => {
		const report = (await reportPromise)!;
		// Before 1.3 a template's drawing has no owner. Its file is stored and its row kept in legacy_row.
		expect(report.tables.attachment!.imported + (report.tables.attachment!.leftOut ?? 0)).toBe(sourceCount('attachment'));
		expect(readdirSync(join(dir, 'blobs')).length).toBe(sourceCount('attachment'));
		const out = new Database(join(dir, 'opal.db'), { readonly: true });
		const project = (out.query('SELECT name FROM project').get() as Row).name as string;
		expect(project).not.toBe('Imported project');
		out.close();
	});

	test('every published version reads as a snapshot, and its work orders find their steps', async () => {
		await reportPromise;
		const out = new Database(join(dir, 'opal.db'), { readonly: true });
		for (const v of out.query('SELECT content FROM procedure_version').all() as { content: string }[]) {
			const snap = zProcedureSnapshot.parse(JSON.parse(v.content));
			expect(new Set(snap.steps.map((s) => s.id)).size).toBe(snap.steps.length);
			const ids = new Set(snap.steps.map((s) => s.id));
			for (const s of snap.steps) if (s.parentId !== null) expect(ids.has(s.parentId)).toBe(true);
		}
		expect((out.query('SELECT COUNT(*) AS n FROM step_execution').get() as { n: number }).n).toBeGreaterThanOrEqual(sourceCount('step_execution'));
		out.close();
	});

	test('reports no warning that a column was missing', async () => {
		const report = (await reportPromise)!;
		expect(report.warnings.filter((w) => w.includes('not in this database'))).toEqual([]);
	});
});

/** Signs in on an imported file and opens every record the way a page does. Returns the refusals. */
async function openEveryRecord(path: string): Promise<{ opened: Record<string, number>; refused: string[] }> {
	const db = await open(path);
	try {
		const admin = db.select().from(user).all().find((u) => u.isActive && u.isAdmin)!;
		db.update(user).set({ passwordHash: await Bun.password.hash('read-every-record', { algorithm: 'argon2id' }) }).where(eq(user.id, admin.id)).run();
		const app = createApp({ db });
		const login = await app.request('http://opal.test/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: admin.username, password: 'read-every-record' })
		});
		expect(login.status).toBe(200);
		const cookie = login.headers.getSetCookie().find((c) => c.startsWith('opal_session='))!.split(';')[0]!;
		const get = (path: string) => app.request(`http://opal.test/api${path}`, { headers: { cookie } });
		const opened: Record<string, number> = {};
		const refused: string[] = [];
		for (const kind of ['requirements', 'parts', 'risks', 'issues', 'procedures', 'executions', 'purchases', 'suppliers', 'workcenters', 'datasets']) {
			opened[kind] = 0;
			for (let cursor = ''; ; ) {
				const list = await get(`/${kind}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
				if (list.status !== 200) {
					refused.push(`GET /${kind}: ${list.status}`);
					break;
				}
				// Short lists come whole, long ones in pages.
				const body = (await list.json()) as { id: number }[] | { items: { id: number }[]; next?: string | null };
				const page = Array.isArray(body) ? { items: body, next: null } : body;
				for (const { id } of page.items) {
					const res = await get(`/${kind}/${id}`);
					if (res.status === 200) opened[kind]!++;
					else refused.push(`GET /${kind}/${id}: ${res.status}`);
					if (kind !== 'procedures') continue;
					const versions = await get(`/procedures/${id}/versions`);
					if (versions.status !== 200) {
						refused.push(`GET /procedures/${id}/versions: ${versions.status}`);
						continue;
					}
					const body = (await versions.json()) as { id: number }[] | { items: { id: number }[] };
					for (const v of Array.isArray(body) ? body : body.items) {
						const version = await get(`/procedures/versions/${v.id}`);
						if (version.status !== 200) refused.push(`GET /procedures/versions/${v.id}: ${version.status}`);
					}
				}
				if (!page.next) break;
				cursor = page.next;
			}
		}
		return { opened, refused };
	} finally {
		db.$client.close();
	}
}

describe.each(RELEASES.map(([name]) => name))('reading %s after the import', (name) => {
	test('every record opens', async () => {
		const d = tmp();
		const src = unpack(name, d);
		const source = new Database(src, { readonly: true });
		const count = (t: string) => (source.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
		const parts = count('part');
		const risks = count('risk');
		const issues = count('issue');
		const procedures = count('master_procedure');
		source.close();
		await importInPlace(src, { open });
		const { opened, refused } = await openEveryRecord(src);
		expect(refused).toEqual([]);
		expect(opened.parts).toBe(parts);
		expect(opened.risks).toBe(risks);
		expect(opened.issues).toBe(issues);
		expect(opened.procedures).toBe(procedures);
	});
});

describe('capture fields 1.x took and OPAL 2 would refuse', () => {
	test('the procedure still opens, each field is in a shape OPAL 2 reads, and the report says what changed', async () => {
		const d = tmp();
		const src = unpack('v1.4.0-beta.3', d);
		const fields = [
			{ name: 'a', type: 'string', label: 'A' },
			{ name: 'b', type: 'date' },
			{ label: 'No name', type: 'number' },
			{ name: 'a', type: 'text' },
			{ name: 'c', type: 'number', min: '5', tolerance: 0.1 },
			{ name: 'd', type: 'checkbox', unit: null },
			'not a field'
		];
		const old = new Database(src);
		const step = old.query('SELECT id FROM procedure_step LIMIT 1').get() as { id: number };
		old.query('UPDATE procedure_step SET required_data_schema = ? WHERE id = ?').run(JSON.stringify({ fields }), step.id);
		const version = old.query('SELECT id, content FROM procedure_version LIMIT 1').get() as { id: number; content: string };
		const content = JSON.parse(version.content);
		content.steps[0].required_data_schema = { fields };
		old.query('UPDATE procedure_version SET content = ? WHERE id = ?').run(JSON.stringify(content), version.id);
		old.close();

		const report = (await importInPlace(src, { open }))!;
		expect((await openEveryRecord(src)).refused).toEqual([]);

		const out = new Database(src, { readonly: true });
		const live = zProcedureDataSchema.parse(JSON.parse((out.query('SELECT data_schema FROM procedure_step WHERE id = ?').get(step.id) as { data_schema: string }).data_schema));
		const published = JSON.parse((out.query('SELECT content FROM procedure_version WHERE id = ?').get(version.id) as { content: string }).content).steps[0].dataSchema;
		out.close();
		for (const schema of [live, zProcedureDataSchema.parse(published)]) {
			expect(schema.fields.map((f) => [f.name, f.type])).toEqual([['a', 'text'], ['b', 'text'], ['No name', 'number'], ['a_2', 'text'], ['c', 'number'], ['d', 'boolean']]);
		}
		const said = report.warnings.filter((w) => w.startsWith(`procedure_step ${step.id}`)).join('\n');
		expect(said).toContain('type "date" is not in OPAL 2');
		expect(said).toContain('named "No name"');
		expect(said).toContain('named "a_2"');
		expect(said).toContain('property "min" is "5"');
		expect(said).toContain('property "tolerance" has no place');
		expect(said).toContain('field 7 is "not a field"');
		expect(said).not.toContain('"string"');
		expect(said).not.toContain('"checkbox"');
		expect(said).not.toContain('"unit"');
	});
});

describe('the terminal warning about Onshape keys', () => {
	test('names the keys and the file that still holds them, never their values', async () => {
		const d = tmp();
		const src = unpack('v1.4.0-beta.3', d);
		const old = new Database(src, { readonly: true });
		const keys = old.query("SELECT key, value FROM app_setting WHERE key LIKE 'onshape_%' ORDER BY key").all() as { key: string; value: string }[];
		old.close();
		expect(keys.length).toBe(3);
		const report = (await importInPlace(src, { open }))!;
		const summary = reportSummary(report, d);
		expect(summary).toContain('Onshape does not carry over to OPAL 2');
		expect(summary).toContain(`These keys were not imported: ${keys.map((k) => k.key).join(', ')}.`);
		expect(summary).toContain(`still in plaintext in ${join(d, 'opal.legacy.db')}`);
		expect(summary).toContain('Revoke them in Onshape');
		for (const k of keys) expect(summary).not.toContain(k.value);
	});

	test('does not appear when the file holds no Onshape credential', async () => {
		const d = tmp();
		const src = unpack('v1.4.0-beta.3', d);
		const old = new Database(src);
		old.run("DELETE FROM app_setting WHERE key IN ('onshape_secret_key', 'onshape_webhook_secret')");
		// A setting that is not a credential: left out like the rest, with nothing to revoke.
		old.run("UPDATE app_setting SET key = 'onshape_base_url', value = 'https://example.test' WHERE key = 'onshape_access_key'");
		old.close();
		const report = (await importInPlace(src, { open }))!;
		expect(reportSummary(report, d)).not.toContain('Onshape');
		expect(report.notImported.find((n) => n.table === 'app_setting (onshape_*)')?.rows).toBe(1);
	});

	test('does not appear for a key with no value, which holds nothing to revoke', async () => {
		const d = tmp();
		const src = unpack('v1.4.0-beta.3', d);
		const old = new Database(src);
		old.run("UPDATE app_setting SET value = '' WHERE key LIKE 'onshape_%'");
		old.close();
		const report = (await importInPlace(src, { open }))!;
		expect(reportSummary(report, d)).not.toContain('Onshape');
		expect(report.notImported.find((n) => n.table === 'app_setting (onshape_*)')?.rows).toBe(3);
	});
});

describe('signing in after a 1.3.2 import', () => {
	test('the report names who has no password and OPAL can print a link for the administrator', async () => {
		const d = tmp();
		const src = unpack('v1.3.2', d);
		const report = (await importInPlace(src))!;
		expect(report.noSignIn.some((p) => p.isAdmin)).toBe(true);
		const db = await openDb(src);
		const links = firstAdminClaimLinks(db, 'http://localhost:8080');
		expect(links.length).toBe(1);
		expect(links[0]!.url).toContain('/claim?token=');
		// Once an administrator has a password there is no more need for a printed link.
		db.update(user).set({ passwordHash: 'x' }).run();
		expect(firstAdminClaimLinks(db, 'http://localhost:8080')).toEqual([]);
		db.$client.close();
	});
});

describe('a file whose stamp claims steps it never had', () => {
	// A demo database made between releases by `create_all`, and stamped c7a2e9d41f88. It has neither
	// arm of the first diamond. Made by hand long ago and not by build.sh, which is the point of it.
	const d = tmp();
	const dir = join(d, 'data');
	mkdirSync(dir);
	const src = unpack('between-releases-c7a2e9d41f88', dir);
	const old = new Database(src, { readonly: true });
	const risks = old.query('SELECT id, status, mitigation_plan FROM risk').all() as { id: number; status: string; mitigation_plan: string | null }[];
	const allocations = (old.query('SELECT COUNT(*) AS n FROM part_requirements').get() as { n: number }).n;
	old.close();
	const reportPromise = importInPlace(src, { open });

	test('runs the arm steps the file lacks, so risk and issue values are not lost', async () => {
		const report = (await reportPromise)!;
		expect(report.bridge!.steps.filter((s) => s.pastStamp).map((s) => s.revision)).toEqual(['a7c41d92e803', 'a7b9c1d3e5f7']);
		const out = new Database(join(dir, 'opal.db'), { readonly: true });
		const to: Record<string, string> = { identified: 'open', analyzing: 'research', mitigating: 'mitigate', monitoring: 'watch', closed: 'closed' };
		expect(risks.some((r) => r.mitigation_plan)).toBe(true);
		for (const r of risks) {
			const now = out.query('SELECT disposition, description FROM risk WHERE id = ?').get(r.id) as { disposition: string; description: string };
			expect(now.disposition).toBe(to[r.status]!);
			if (r.mitigation_plan) expect(now.description).toContain(r.mitigation_plan);
		}
		out.close();
		expect(report.warnings.filter((w) => w.includes('not valid'))).toEqual([]);
		expect(report.warnings.filter((w) => w.includes('not in this database'))).toEqual([]);
	});

	test('free-text allocations with no requirement are kept and accounted for, not lost', async () => {
		const report = (await reportPromise)!;
		expect(report.sourceTables.filter((t) => t.unaccounted > 0)).toEqual([]);
		expect(report.notImported.find((n) => n.table === 'part_requirements (legacy_row)')?.rows).toBe(allocations);
		const out = new Database(join(dir, 'opal.db'), { readonly: true });
		expect((out.query("SELECT COUNT(*) AS n FROM legacy_row WHERE table_name = 'part_requirements'").get() as { n: number }).n).toBe(allocations);
		out.close();
	});

	test('a revision on one arm of a merge is accepted: the other arm is seen to be missing', () => {
		expect(canBridge('a7c41d92e803')).toBe(true);
		expect(canBridge('52973e130a6f')).toBe(true);
	});
});

describe('a database the bridge cannot take', () => {
	test('an unknown revision is refused, named, and the file is left alone', async () => {
		const d = tmp();
		const old = buildLegacyFixture(d, { version: 'deadbeef0000' });
		const before = sha(old);
		const error = await importLegacy(old, join(d, 'x.db'), { open }).catch((e: Error) => e);
		expect(String(error)).toContain('deadbeef0000');
		expect(String(error)).toContain(OLD_VERSION_MESSAGE);
		expect(existsSync(join(d, 'x.db'))).toBe(false);
		expect(sha(old)).toBe(before);
	});

	test('a failing step is named, and the import leaves nothing behind', async () => {
		const d = tmp();
		const dir = join(d, 'data');
		mkdirSync(dir);
		const src = unpack('v1.3.2', dir);
		const broken = new Database(src);
		broken.run('DROP TABLE issue');
		broken.close();
		const before = sha(src);
		const error = await importInPlace(src, { open }).catch((e: Error) => e);
		expect(String(error)).toContain('a7c41d92e803');
		expect(String(error)).toContain('The file was not changed');
		expect(sha(src)).toBe(before);
		expect(existsSync(`${src}.new`)).toBe(false);
		expect(existsSync(join(dir, 'opal.legacy.db'))).toBe(false);
	});
});

describe('the project file of a database from before 1.4', () => {
	test('--project is used when given, and a wrong path says so', async () => {
		const d = tmp();
		const src = unpack('v1.3.2', d);
		rmSync(join(d, 'opal.project.yaml'));
		const yaml = join(d, 'elsewhere.yaml');
		writeFileSync(yaml, 'name: Elsewhere\ntiers:\n- level: 1\n  name: FLIGHT\n  code: F\n');
		const error = await importLegacy(src, join(d, 'a.db'), { open, projectFile: join(d, 'absent.yaml') }).catch((e: Error) => e);
		expect(String(error)).toContain('absent.yaml');
		const report = await importLegacy(src, join(d, 'b.db'), { open, projectFile: yaml });
		expect(report.projectFile).toBe(yaml);
		const out = new Database(join(d, 'b.db'), { readonly: true });
		expect((out.query('SELECT name FROM project').get() as Row).name).toBe('Elsewhere');
		out.close();
	});
});
