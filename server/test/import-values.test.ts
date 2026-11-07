/**
 * Values in a legacy database that OPAL 2 cannot hold as they are. A value that does not survive gets a
 * line in the report, and a record that imports also opens.
 */
import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zDatasetSchema } from '@opal/shared';
import { createApp } from '../src/app.ts';
import { signPayload } from '../src/auth/signing.ts';
import { openDb } from '../src/db/client.ts';
import { auditLog, user } from '../src/db/schema/index.ts';
import { importInPlace, openSchemaImportDb, type ImportReport } from '../src/import/index.ts';
import { firstAdminClaimLinks } from '../src/services/auth/claim.ts';
import { buildLegacyFixture } from './fixtures/legacy-data.ts';
import { eq } from 'drizzle-orm';

const FIXTURES = join(import.meta.dir, 'fixtures/legacy-released');
const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'opal-import-values-'));
	dirs.push(d);
	return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const open = (path: string) => openSchemaImportDb(path);

async function importedWith(change: (old: Database) => void): Promise<{ src: string; report: ImportReport; out: Database }> {
	const dir = tmp();
	const src = buildLegacyFixture(dir);
	const old = new Database(src);
	change(old);
	old.close();
	const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
	return { src, report, out: new Database(src) };
}

const warned = (report: ImportReport, ...parts: string[]) => report.warnings.some((w) => parts.every((p) => w.includes(p)));

describe('a value that does not survive gets a line', () => {
	test('a cost or quantity that is not a number', async () => {
		const { report, out } = await importedWith((old) => {
			old.run("UPDATE purchase_line SET unit_cost = '12,50' WHERE id = 1");
			old.run("UPDATE part SET reorder_point = 'lots' WHERE id = 10");
		});
		expect(warned(report, 'purchase_line 1 unit_cost', '12,50')).toBe(true);
		expect(warned(report, 'part 10 reorder_point', 'lots')).toBe(true);
		out.close();
	});

	test('a date that is not one', async () => {
		const { report, out } = await importedWith((old) => void old.run("UPDATE purchase SET target_date = '12/01/2026' WHERE id = 1"));
		expect(warned(report, 'purchase 1 target_date', '12/01/2026')).toBe(true);
		out.close();
	});

	test('unreadable metadata', async () => {
		const { report, out } = await importedWith((old) => void old.run("UPDATE part SET metadata = '{oops' WHERE id = 10"));
		expect(warned(report, 'part 10 metadata', '{oops')).toBe(true);
		out.close();
	});

	test('a step or issue status OPAL 2 has no place for', async () => {
		const { report, out } = await importedWith((old) => {
			old.run("UPDATE step_execution SET status = 'blocked' WHERE id = (SELECT MIN(id) FROM step_execution)");
			old.run("UPDATE issue SET status = 'cancelled' WHERE id = 1");
		});
		expect(warned(report, 'step_execution', '"blocked"', 'pending')).toBe(true);
		expect(warned(report, 'issue 1', '"cancelled"', 'open')).toBe(true);
		out.close();
	});

	test('an attachment whose owner never existed', async () => {
		const { report, out } = await importedWith((old) => void old.run('UPDATE attachment SET issue_id = 999, procedure_instance_id = NULL, step_execution_id = NULL, step_note_id = NULL WHERE id = 1'));
		expect(warned(report, 'attachment 1', 'issue 999', 'does not exist')).toBe(true);
		out.close();
	});

	test('an issue that named a procedure', async () => {
		const { report, out } = await importedWith((old) => void old.run('UPDATE issue SET procedure_id = 1, procedure_instance_id = NULL WHERE id = 1'));
		expect(warned(report, 'issue 1', 'procedure 1')).toBe(true);
		out.close();
	});

	test('an aborted work order reads as closed short, with the reason, and the report says so', async () => {
		const { report, out } = await importedWith((old) => void old.run("UPDATE procedure_instance SET status = 'aborted' WHERE id = 1"));
		expect(warned(report, 'procedure_instance 1', 'aborted')).toBe(true);
		expect(out.query('SELECT status, abort_reason FROM execution WHERE id = 1').get()).toEqual({ status: 'closed_short', abort_reason: 'Aborted in OPAL 1.x' });
		out.close();
	});
});

describe('a record that imports opens', () => {
	test('a dataset schema with no fields does not stop the list, and what was stored is kept', async () => {
		const { report, out } = await importedWith((old) => void old.run(`UPDATE dataset SET schema = '{"columns":["a"]}' WHERE id = 1`));
		const row = out.query('SELECT schema FROM dataset WHERE id = 1').get() as { schema: string };
		expect(zDatasetSchema.safeParse(JSON.parse(row.schema)).success).toBe(true);
		expect(warned(report, 'dataset 1', 'legacy_row')).toBe(true);
		expect(String((out.query("SELECT data FROM legacy_row WHERE table_name = 'dataset'").get() as { data: string }).data)).toContain('columns');
		out.close();
	});

	test('a schema with one bad field keeps the good ones', async () => {
		const { out } = await importedWith((old) => void old.run(`UPDATE dataset SET schema = '{"fields":[{"name":"psi","type":"number"},{"name":"","type":"nope"}]}' WHERE id = 1`));
		expect(JSON.parse((out.query('SELECT schema FROM dataset WHERE id = 1').get() as { schema: string }).schema).fields.map((f: { name: string }) => f.name)).toEqual(['psi']);
		out.close();
	});

	test.each([
		['a list', '[1, 2]', 'value', [1, 2]],
		['a number', '7', 'value', 7],
		['text that is not JSON', 'torque ok', 'unreadable_text', 'torque ok']
	])('captured data that is %s stays, under its own key', async (_what, stored, key, kept) => {
		const { report, out } = await importedWith((old) => void old.query('UPDATE step_execution SET data_captured = ? WHERE id = (SELECT MIN(id) FROM step_execution WHERE ad_hoc_issue_id IS NULL)').run(stored));
		const row = out.query('SELECT data_captured FROM step_execution WHERE data_captured IS NOT NULL ORDER BY id LIMIT 1').get() as { data_captured: string };
		expect(JSON.parse(row.data_captured)).toEqual({ [key]: kept });
		expect(warned(report, 'captured data')).toBe(true);
		out.close();
	});

	test('a nested point value reads as its JSON', async () => {
		const { out } = await importedWith((old) => void old.run(`UPDATE data_point SET "values" = '{"psi":{"a":1}}' WHERE id = 1`));
		expect(JSON.parse((out.query('SELECT "values" AS v FROM data_point WHERE id = 1').get() as { v: string }).v)).toEqual({ psi: '{"a":1}' });
		out.close();
	});

	test('a callout of another kind opens, and keeps its words', async () => {
		const { report, out } = await importedWith((old) => {
			old.run(`UPDATE procedure_step SET callouts = '[{"kind":"warning","text":"Hot"},{"kind":"tip","text":"Wear gloves"}]' WHERE id = (SELECT MIN(id) FROM procedure_step)`);
			const v = old.query('SELECT id, content FROM procedure_version ORDER BY id LIMIT 1').get() as { id: number; content: string };
			const content = JSON.parse(v.content);
			content.steps[0].callouts = [{ kind: 'warning', text: 'Hot' }, { kind: 'tip', text: 'Wear gloves' }];
			old.query('UPDATE procedure_version SET content = ? WHERE id = ?').run(JSON.stringify(content), v.id);
		});
		expect(report.failedRows.filter((f) => f.table === 'procedure_version' && f.reason.includes('callouts'))).toEqual([]);
		expect(warned(report, 'procedure_version', 'tip', 'info')).toBe(true);
		const step = out.query('SELECT callouts FROM procedure_step ORDER BY id LIMIT 1').get() as { callouts: string };
		expect(JSON.parse(step.callouts)).toEqual([{ kind: 'caution', text: 'Hot' }, { kind: 'info', text: 'tip: Wear gloves' }]);
		out.close();
	});

	test('a version that still would not open is a failed row, so a person decides', async () => {
		const { report, out } = await importedWith((old) => {
			const v = old.query('SELECT id, content FROM procedure_version ORDER BY id LIMIT 1').get() as { id: number; content: string };
			const content = JSON.parse(v.content);
			content.steps[0].title = 12345;
			old.query('UPDATE procedure_version SET content = ? WHERE id = ?').run(JSON.stringify(content), v.id);
		});
		expect(report.failedRows.some((f) => f.table === 'procedure_version' && f.reason.includes('will not open'))).toBe(true);
		out.close();
	});
});

describe('imported roles', () => {
	test('a system role gets the gates 1.x did not have, and keeps those its administrators chose', async () => {
		const { out } = await importedWith((old) => void old.run("DELETE FROM role_gate WHERE gate = 'issue.disposition'"));
		expect((out.query('SELECT gate FROM role_gate WHERE role_id = 1 ORDER BY gate').all() as { gate: string }[]).map((r) => r.gate)).toEqual(['execution.closeShort', 'execution.skipRequired']);
		out.close();
	});

	test('a role of their own gets nothing added', async () => {
		const { out } = await importedWith(() => {});
		expect(out.query('SELECT gate FROM role_gate WHERE role_id = 2').all()).toEqual([]);
		out.close();
	});
});

describe('the project file', () => {
	const noConfig = (src: string) => {
		const old = new Database(src);
		old.run("DELETE FROM app_setting WHERE key = 'project_config'");
		old.close();
	};
	const YAML = 'name: Someone Else Entirely\ntiers:\n- level: 1\n  name: FLIGHT\n  code: F\npart_numbering:\n  prefix: X\n  separator: "-"\n  sequence_digits: 4\n  format: "{prefix}{sep}{tier_code}{sep}{sequence}"\n';

	test('one in the working folder is mentioned and not used', async () => {
		const dir = tmp();
		const data = join(dir, 'data');
		const elsewhere = join(dir, 'elsewhere', 'deep');
		mkdirSync(data);
		mkdirSync(elsewhere, { recursive: true });
		writeFileSync(join(dir, 'elsewhere', 'opal.project.yaml'), YAML);
		const src = buildLegacyFixture(data);
		noConfig(src);
		const cwd = process.cwd();
		process.chdir(elsewhere);
		try {
			const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
			expect(report.projectFile).toBeNull();
			expect(warned(report, join(dir, 'elsewhere', 'opal.project.yaml'), 'was not used', '--project')).toBe(true);
			const out = new Database(src);
			expect((out.query('SELECT name FROM project').get() as { name: string }).name).toBe('Imported project');
			out.close();
		} finally {
			process.chdir(cwd);
		}
	});

	test('one beside the database, or in the folder above it, is used', async () => {
		for (const where of ['beside', 'above']) {
			const dir = tmp();
			const data = join(dir, 'data');
			mkdirSync(data);
			writeFileSync(join(where === 'beside' ? data : dir, 'opal.project.yaml'), YAML);
			const src = buildLegacyFixture(data);
			noConfig(src);
			const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
			expect(report.projectFile).toContain('opal.project.yaml');
		}
	});

	test('one built from aliases is not expanded', async () => {
		const dir = tmp();
		let yaml = 'name: boom\na0: &a0 [x, x, x, x, x, x, x, x, x]\n';
		for (let i = 1; i < 12; i++) yaml += `a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(', ')}]\n`;
		writeFileSync(join(dir, 'opal.project.yaml'), yaml);
		const src = buildLegacyFixture(dir);
		noConfig(src);
		const before = Date.now();
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(Date.now() - before).toBeLessThan(10_000);
		expect(report.projectFile).toBeNull();
		expect(warned(report, 'anchors or aliases')).toBe(true);
	});

	test('one too large to be a project file is not read', async () => {
		const dir = tmp();
		writeFileSync(join(dir, 'opal.project.yaml'), `name: big\nnote: ${'x'.repeat(1024 * 1024 + 1)}\n`);
		const src = buildLegacyFixture(dir);
		noConfig(src);
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(report.projectFile).toBeNull();
		expect(warned(report, 'bytes, more than a project file holds')).toBe(true);
	});

	test('text with a star or ampersand in it is not an alias', async () => {
		const dir = tmp();
		writeFileSync(join(dir, 'opal.project.yaml'), `${YAML}description: R&D stand, 3*4 m and a star * here\n`);
		const src = buildLegacyFixture(dir);
		noConfig(src);
		const report = (await importInPlace(src, { open, acceptFailedRows: true }))!;
		expect(report.projectFile).toContain('opal.project.yaml');
	});
});

describe('the link printed at a start', () => {
	/** An imported 1.3.2 database: people, and none of them can sign in. */
	async function passwordless() {
		const dir = tmp();
		const src = join(dir, 'opal.db');
		writeFileSync(src, Bun.gunzipSync(new Uint8Array(readFileSync(join(FIXTURES, 'v1.3.2.db.gz')))));
		Bun.spawnSync(['tar', '-xzf', join(FIXTURES, 'v1.3.2.attachments.tgz'), '-C', dir]);
		writeFileSync(join(dir, 'opal.project.yaml'), readFileSync(join(FIXTURES, 'v1.3.2.project.yaml')));
		await importInPlace(src);
		const db = openDb(src, undefined, () => null);
		return { db, app: createApp({ db }) };
	}
	const tokenOf = (url: string) => decodeURIComponent(url.split('token=')[1]!);
	const status = async (app: ReturnType<typeof createApp>, token: string, host = '127.0.0.1') => (await app.request(`http://${host}/api/auth/claim?token=${encodeURIComponent(token)}`)).status;

	test('works during this start, on an address setup would take', async () => {
		const { db, app } = await passwordless();
		const [link] = firstAdminClaimLinks(db, 'http://localhost:8080');
		expect(await status(app, tokenOf(link!.url))).toBe(200);
		expect(await status(app, tokenOf(link!.url), 'evil.example')).toBe(404);
		db.$client.close();
	});

	test('from an earlier start no longer works', async () => {
		const { db, app } = await passwordless();
		const admin = db.select().from(user).all().find((u) => u.isAdmin)!;
		const earlier = signPayload({ kind: 'printed-claim', uid: admin.id, born: admin.createdAt, rev: admin.updatedAt, start: 'an-earlier-start' }, 60_000);
		expect(await status(app, earlier)).toBe(404);
		db.$client.close();
	});

	test('lasts hours, not days', async () => {
		const { db } = await passwordless();
		const [link] = firstAdminClaimLinks(db, 'http://localhost:8080');
		const payload = JSON.parse(Buffer.from(tokenOf(link!.url).split('.')[0]!, 'base64url').toString()) as { __exp: number };
		expect(payload.__exp - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600);
		db.$client.close();
	});

	test('is not printed for a database that was never imported', async () => {
		const { db } = await passwordless();
		db.delete(auditLog).where(eq(auditLog.op, 'legacy.import')).run();
		expect(firstAdminClaimLinks(db, 'http://localhost:8080')).toEqual([]);
		db.$client.close();
	});

	test('does not set a password on an account tied to single sign-on', async () => {
		const { db, app } = await passwordless();
		const [link] = firstAdminClaimLinks(db, 'http://localhost:8080');
		db.update(user).set({ oidcIssuer: 'https://sso.example', oidcSubject: 'u1' }).run();
		expect(firstAdminClaimLinks(db, 'http://localhost:8080')).toEqual([]);
		expect(await status(app, tokenOf(link!.url))).toBe(404);
		db.$client.close();
	});

	test('does nothing where passwords are turned off', async () => {
		const { db, app } = await passwordless();
		const [link] = firstAdminClaimLinks(db, 'http://localhost:8080');
		const at = new Date().toISOString();
		db.$client.query("INSERT INTO auth_setting (key, value, created_at, updated_at) VALUES ('password_login_enabled', 'false', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(at, at);
		expect(firstAdminClaimLinks(db, 'http://localhost:8080')).toEqual([]);
		expect(await status(app, tokenOf(link!.url))).toBe(404);
		db.$client.close();
	});

	test('a claim link from an administrator also stops where passwords are turned off', async () => {
		const { db, app } = await passwordless();
		const admin = db.select().from(user).all().find((u) => u.isAdmin)!;
		const token = signPayload({ kind: 'account-claim', uid: admin.id, born: admin.createdAt, rev: admin.updatedAt }, 60_000);
		expect(await status(app, token)).toBe(200);
		const at = new Date().toISOString();
		db.$client.query("INSERT INTO auth_setting (key, value, created_at, updated_at) VALUES ('password_login_enabled', 'false', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(at, at);
		expect(await status(app, token)).toBe(404);
		db.$client.close();
	});
});
