import { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { now } from '@opal/shared';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { authSettingScope, KEY_FILE, readStored, seal } from '../src/auth/sealed.ts';
import { authSecret } from '../src/auth/signing.ts';
import type { Actor } from '../src/context.ts';
import { openDb, type Db } from '../src/db/client.ts';
import { authSetting, blob, part, user, userProfile } from '../src/db/schema/index.ts';
import { assertNoUnfinishedRestore, RESTORE_MARKER, restoreBackup, takeBackup, verifyBackup } from '../src/services/platform/backup.ts';
import { createTestProject } from './helpers/project.ts';

// These tests write and flush real files, which a busy machine can make slow.
setDefaultTimeout(60_000);

const roots: string[] = [];
const posix = process.platform === 'win32' ? test.skip : test;
const cli = join(import.meta.dir, '../src/cli.ts');

function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'opal-backup-'));
	roots.push(d);
	return d;
}

const oldUmask = process.umask();
beforeEach(() => {
	delete process.env.OPAL_DB_FILE;
	process.umask(oldUmask);
});
afterAll(() => {
	process.umask(oldUmask);
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

interface Instance {
	dir: string;
	db: Db;
	app: ReturnType<typeof createApp>;
	projectId: number;
	close(): void;
}

let migrated: string | undefined;

/** Every migration, once. Applying them for each test takes seconds on a real file. */
function migratedDb(): string {
	if (!migrated) {
		migrated = join(tempDir(), 'migrated.db');
		openDb(migrated).$client.close();
	}
	return migrated;
}

/** A real instance on a file, opened the way `serve` opens it. The data folder follows it. */
function open(dir: string): Instance {
	process.env.OPAL_DATA_DIR = dir;
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'opal.db');
	if (!existsSync(file)) copyFileSync(migratedDb(), file);
	const db = openDb(file);
	const ts = now();
	const person = db.select().from(user).get() ?? db.insert(user).values({ username: 'abby', name: 'Abby', isAdmin: true, createdAt: ts, updatedAt: ts }).returning().get();
	const actor: Actor = { kind: 'user', userId: person.id, isAdmin: true, sessionId: 1 };
	const app = createApp({ db, resolveActor: () => actor });
	const row = db.$client.query('SELECT id FROM project LIMIT 1').get() as { id: number } | null;
	const projectId = row?.id ?? createTestProject(db).id;
	return { dir, db, app, projectId, close: () => db.$client.close() };
}

async function raise(i: Instance, title: string): Promise<{ id: number; issueNumber: string }> {
	const res = await i.app.request('/api/issues', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title, projectId: i.projectId })
	});
	expect(res.status).toBe(201);
	return (await res.json()) as { id: number; issueNumber: string };
}

async function attach(i: Instance, issueId: number, name: string, body: string): Promise<{ id: number; sha256: string; href: string }> {
	const form = new FormData();
	form.set('file', new File([body], name, { type: 'text/plain' }));
	form.set('ownerType', 'issue');
	form.set('ownerId', String(issueId));
	const res = await i.app.request('/api/attachments', { method: 'POST', body: form });
	expect(res.status).toBe(201);
	return (await res.json()) as { id: number; sha256: string; href: string };
}

async function filesOf(i: Instance, issueId: number): Promise<{ filename: string; href: string; sha256: string }[]> {
	const res = await i.app.request(`/api/attachments?ownerType=issue&ownerId=${issueId}`);
	expect(res.status).toBe(200);
	return (await res.json()) as { filename: string; href: string; sha256: string }[];
}

/** An instance with one issue and one attachment. */
async function small(): Promise<Instance & { issueId: number; sha: string }> {
	const i = open(join(tempDir(), 'data'));
	const issue = await raise(i, 'Bent bracket');
	const a = await attach(i, issue.id, 'photo.txt', 'the bracket is bent');
	return { ...i, issueId: issue.id, sha: a.sha256 };
}

function finishedIn(parent: string): string[] {
	return readdirSync(parent)
		.filter((n) => /^opal-backup-[^.]+Z$/.test(n) && existsSync(join(parent, n, 'manifest.json')))
		.sort();
}

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)]));
}

function rewriteManifest(backup: string, change: (m: { files: Record<string, string> }) => void): void {
	const path = join(backup, 'manifest.json');
	const m = JSON.parse(readFileSync(path, 'utf8'));
	change(m);
	writeFileSync(path, JSON.stringify(m));
}

/** A restore that stops the way a crash would, after writing everything but the database. */
function crashBeforePublishing(backup: string): void {
	expect(() =>
		restoreBackup(backup, {
			publishing: () => {
				throw new Error('crash');
			}
		})
	).toThrow('crash');
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function runCli(args: string[], env: Record<string, string>) {
	const p = Bun.spawn([process.execPath, cli, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code, out, err };
}

describe('a backup restores to a working instance', () => {
	test('a backup taken from a second process during writes restores with its records and attachments readable', async () => {
		const live = open(join(tempDir(), 'data'));
		const parent = join(tempDir(), 'backups');
		const written = new Map<string, string>();
		let n = 0;
		const writeOne = async () => {
			n++;
			const issue = await raise(live, `Issue ${n}`);
			const body = `evidence for issue ${n}`;
			await attach(live, issue.id, `evidence-${n}.txt`, body);
			written.set(`evidence-${n}.txt`, body);
		};
		for (let k = 0; k < 20; k++) await writeOne();
		const before = n;

		// The test preload pins this variable, and a backup rightly warns about it.
		const { OPAL_SECRETS_KEY: _pinned, ...env } = process.env;
		const proc = Bun.spawn([process.execPath, cli, 'backup', parent], {
			env: { ...env, OPAL_DATA_DIR: live.dir },
			stdout: 'pipe',
			stderr: 'pipe'
		});
		let finished = false;
		const exited = proc.exited.then((c) => {
			finished = true;
			return c;
		});
		while (!finished) await writeOne();
		const [code, out, err] = await Promise.all([exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect(err).toBe('');
		expect(code).toBe(0);
		expect(n).toBeGreaterThan(before);
		live.close();

		const [name] = finishedIn(parent);
		expect(out).toContain(join(parent, name!));

		const restored = join(tempDir(), 'restored');
		process.env.OPAL_DATA_DIR = restored;
		restoreBackup(join(parent, name!));
		const back = open(restored);
		try {
			const res = await back.app.request('/api/issues?limit=500');
			expect(res.status).toBe(200);
			const issues = ((await res.json()) as { items: { id: number; title: string; issueNumber: string }[] }).items;
			// The copy holds everything from before the backup began. Later writes may or may not be in it.
			expect(issues.length).toBeGreaterThanOrEqual(before);
			let attachments = 0;
			for (const issue of issues) {
				expect(issue.title).toMatch(/^Issue \d+$/);
				for (const f of await filesOf(back, issue.id)) {
					const download = await back.app.request(f.href);
					expect(download.status).toBe(200);
					expect(await download.text()).toBe(written.get(f.filename)!);
					attachments++;
				}
			}
			expect(attachments).toBeGreaterThanOrEqual(before);

			// The restored instance takes new work, and numbers already used stay used.
			const taken = new Set(issues.map((x) => x.issueNumber));
			const next = await raise(back, 'After the restore');
			expect(taken.has(next.issueNumber)).toBe(false);
			const added = await attach(back, next.id, 'new.txt', 'written after the restore');
			expect(await (await back.app.request(added.href)).text()).toBe('written after the restore');
		} finally {
			back.close();
		}
	}, 120_000);

	test('an id used before the backup is not reused after the restore', async () => {
		const i = await small();
		const ts = now();
		const row = i.db.insert(part).values({ internalPn: 'P-1', name: 'Bolt', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1, createdAt: ts, updatedAt: ts }).returning().get();
		i.db.$client.run('DELETE FROM part WHERE id = ?', [row.id]);
		const parent = join(tempDir(), 'b');
		const { path } = takeBackup(parent);
		i.close();
		process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
		restoreBackup(path);
		const back = open(process.env.OPAL_DATA_DIR);
		const again = back.db.insert(part).values({ internalPn: 'P-2', name: 'Nut', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1, createdAt: ts, updatedAt: ts }).returning().get();
		expect(again.id).toBeGreaterThan(row.id);
		back.close();
	});

	test('the restored instance has the same signing secret and key files', async () => {
		const i = await small();
		const secret = authSecret();
		writeFileSync(join(i.dir, '.opal_secrets_key'), 'a-key-that-opens-stored-secrets\n');
		const { path, counts } = takeBackup(join(tempDir(), 'b'));
		i.close();
		expect(counts.keyFiles).toBe(2);
		process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
		restoreBackup(path);
		expect(readFileSync(join(process.env.OPAL_DATA_DIR, '.opal_secrets_key'), 'utf8')).toBe('a-key-that-opens-stored-secrets\n');
		expect(authSecret()).toBe(secret);
	});

	test('a key held in the environment is not in the backup, and the backup says so', async () => {
		const pinned = process.env.OPAL_SECRETS_KEY;
		const i = await small();
		try {
			process.env.OPAL_SECRETS_KEY = 'held-elsewhere';
			expect(takeBackup(join(tempDir(), 'b')).warnings.join(' ')).toContain('OPAL_SECRETS_KEY is set');
			delete process.env.OPAL_SECRETS_KEY;
			expect(takeBackup(join(tempDir(), 'c')).warnings.join(' ')).not.toContain('OPAL_SECRETS_KEY');
		} finally {
			process.env.OPAL_SECRETS_KEY = pinned;
			i.close();
		}
	});

	test('a secret saved with a key file reads back after a restore, because the key travels with the backup', async () => {
		const pinned = process.env.OPAL_SECRETS_KEY;
		delete process.env.OPAL_SECRETS_KEY;
		const i = await small();
		try {
			const scope = authSettingScope('oidc_client_secret');
			const stored = seal('client-secret-value', scope);
			expect(existsSync(join(i.dir, KEY_FILE))).toBe(true);
			const { path } = takeBackup(join(tempDir(), 'b'));
			expect(existsSync(join(path, KEY_FILE))).toBe(true);
			i.close();
			process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
			restoreBackup(path);
			expect(existsSync(join(process.env.OPAL_DATA_DIR, KEY_FILE))).toBe(true);
			expect(readStored(stored, scope)).toBe('client-secret-value');
		} finally {
			process.env.OPAL_SECRETS_KEY = pinned;
		}
	});

	test('avatars and plugin files come back where the instance looks for them', async () => {
		const i = await small();
		const avatar = 'a'.repeat(64);
		mkdirSync(join(i.dir, 'avatars'));
		writeFileSync(join(i.dir, 'avatars', avatar), 'photo');
		writeFileSync(join(i.dir, 'avatars', 'b'.repeat(64)), 'nobody uses this photo');
		const ts = now();
		i.db.insert(userProfile).values({ userId: i.db.select().from(user).get()!.id, avatarHash: avatar, avatarMime: 'image/png', createdAt: ts, updatedAt: ts }).run();
		mkdirSync(join(i.dir, 'plugins', 'lamp', 'abc123'), { recursive: true });
		writeFileSync(join(i.dir, 'plugins', 'lamp', 'abc123', 'main.js'), 'code');
		mkdirSync(join(i.dir, 'plugin-data', 'lamp'), { recursive: true });
		writeFileSync(join(i.dir, 'plugin-data', 'lamp', 'state.json'), '{}');
		const { path, counts } = takeBackup(join(tempDir(), 'b'));
		i.close();
		expect(counts).toMatchObject({ avatars: 1, pluginFiles: 2, attachments: 1 });
		const to = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = to;
		restoreBackup(path);
		expect(readFileSync(join(to, 'avatars', avatar), 'utf8')).toBe('photo');
		expect(existsSync(join(to, 'avatars', 'b'.repeat(64)))).toBe(false);
		expect(readFileSync(join(to, 'plugins', 'lamp', 'abc123', 'main.js'), 'utf8')).toBe('code');
		expect(readFileSync(join(to, 'plugin-data', 'lamp', 'state.json'), 'utf8')).toBe('{}');
	});
});

describe('a backup says whether its keys open its secrets', () => {
	const keepKey = (fn: () => Promise<void>) => async () => {
		const pinned = process.env.OPAL_SECRETS_KEY;
		delete process.env.OPAL_SECRETS_KEY;
		try {
			await fn();
		} finally {
			process.env.OPAL_SECRETS_KEY = pinned;
		}
	};
	const storeSecret = (i: Instance) => {
		const ts = now();
		i.db.insert(authSetting).values({ key: 'oidc_client_secret', value: seal('the client secret', authSettingScope('oidc_client_secret')), createdAt: ts, updatedAt: ts }).run();
	};

	test(
		'with the key file in the backup, the secrets open and it says the keys are included',
		keepKey(async () => {
			const i = await small();
			storeSecret(i);
			i.close();
			const parent = join(tempDir(), 'b');
			const r = takeBackup(parent);
			expect(r.secretsOpen).toBe(true);
			expect(r.warnings.join(' ')).not.toContain('oidc_client_secret');
			const cli_ = await runCli(['backup', parent], { OPAL_DATA_DIR: i.dir, OPAL_SECRETS_KEY: '' });
			expect(cli_.code).toBe(0);
			expect(cli_.out).toContain('database and its keys together');
		})
	);

	test(
		'a secret sealed with a key in the server environment only is named, and the keys are not claimed',
		keepKey(async () => {
			const i = await small();
			process.env.OPAL_SECRETS_KEY = 'a-key-only-the-server-unit-has-0123456789';
			storeSecret(i);
			delete process.env.OPAL_SECRETS_KEY;
			i.close();
			const parent = join(tempDir(), 'b');
			const r = takeBackup(parent);
			expect(r.secretsOpen).toBe(false);
			expect(r.warnings.join(' ')).toContain('will need entering again after a restore: oidc_client_secret');
			expect(existsSync(join(i.dir, KEY_FILE))).toBe(false);

			const cli_ = await runCli(['backup', parent], { OPAL_DATA_DIR: i.dir, OPAL_SECRETS_KEY: '' });
			expect(cli_.code).toBe(0);
			expect(cli_.out).not.toContain('keys together');
			expect(cli_.err).toContain('oidc_client_secret');
		})
	);

	test(
		'a key in the environment of the backup itself does not count, because it is not in the backup',
		keepKey(async () => {
			const i = await small();
			process.env.OPAL_SECRETS_KEY = 'a-key-only-the-server-unit-has-0123456789';
			storeSecret(i);
			i.close();
			const r = takeBackup(join(tempDir(), 'b'));
			expect(r.secretsOpen).toBe(false);
			expect(r.warnings.join(' ')).toContain('oidc_client_secret');
		})
	);

	test(
		'a key file that no longer opens what the copy holds is caught, as after a rotation during the backup',
		keepKey(async () => {
			const i = await small();
			storeSecret(i);
			i.close();
			writeFileSync(join(i.dir, KEY_FILE), `${'n'.repeat(64)}\n`);
			const r = takeBackup(join(tempDir(), 'b'));
			expect(r.secretsOpen).toBe(false);
			expect(r.warnings.join(' ')).toContain('oidc_client_secret');
		})
	);

	test(
		'checking leaves the live database and the key file as they were',
		keepKey(async () => {
			const i = await small();
			storeSecret(i);
			i.close();
			const before = [sha256(join(i.dir, 'opal.db')), sha256(join(i.dir, KEY_FILE))];
			takeBackup(join(tempDir(), 'b'));
			expect([sha256(join(i.dir, 'opal.db')), sha256(join(i.dir, KEY_FILE))]).toEqual(before);
		})
	);

	test('with no stored secret there is nothing to warn about', async () => {
		const i = await small();
		i.close();
		const r = takeBackup(join(tempDir(), 'b'));
		expect(r.secretsOpen).toBe(true);
		expect(r.warnings.join(' ')).not.toContain('entering again');
	});
});

describe('what a backup holds', () => {
	test('it leaves out the demo, the pre-migration copies, the 1.x file and files nothing refers to', async () => {
		const i = await small();
		// Key files have their own test. This one is about what stays out.
		rmSync(join(i.dir, '.opal_auth_secret'), { force: true });
		for (const f of ['demo.opal.db', 'opal.pre-migration-2026.db', 'opal.legacy.db', 'import-report.txt', 'someone-elses.txt']) writeFileSync(join(i.dir, f), 'x');
		mkdirSync(join(i.dir, 'demo.opal.db-attachments', 'blobs'), { recursive: true });
		writeFileSync(join(i.dir, 'demo.opal.db-attachments', 'blobs', 'c'.repeat(64)), 'demo file');
		writeFileSync(join(i.dir, 'blobs', 'd'.repeat(64)), 'no row names this');
		writeFileSync(join(i.dir, 'blobs', `${i.sha}.1234.tmp`), 'half an upload');
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const names = walk(path).map((p) => p.slice(path.length + 1));
		expect(names.sort()).toEqual(['blobs', `blobs/${i.sha}`, 'manifest.json', 'opal.db'].sort());
	});

	posix('every folder is 0700 and every file 0600, because it holds secrets', async () => {
		const i = await small();
		// A loose source file must not pass its looseness on.
		chmodSync(join(i.dir, 'blobs', i.sha), 0o644);
		writeFileSync(join(i.dir, '.opal_auth_secret'), 'secret', { mode: 0o644 });
		const old = process.umask(0o022);
		try {
			const parent = join(tempDir(), 'new', 'backups');
			const { path } = takeBackup(parent);
			expect(statSync(parent).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o700);
			for (const p of walk(path)) {
				const stat = lstatSync(p);
				expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
			}
		} finally {
			process.umask(old);
			i.close();
		}
	});

	test('a backup does not upgrade the database it reads', async () => {
		const i = await small();
		i.db.$client.run('DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)');
		const count = () => (i.db.$client.query('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n;
		const before = count();
		takeBackup(join(tempDir(), 'b'));
		expect(count()).toBe(before);
		expect(readdirSync(i.dir).filter((n) => n.includes('pre-migration'))).toEqual([]);
		i.close();
	});
});

describe('a backup that cannot be complete is not called finished', () => {
	test('a referenced attachment file that is missing fails the backup', async () => {
		const i = await small();
		const parent = join(tempDir(), 'b');
		const good = takeBackup(parent);
		rmSync(join(i.dir, 'blobs', i.sha));
		expect(() => takeBackup(parent, { keep: 1 })).toThrow(/missing/);
		i.close();
		// Nothing new, nothing left over, and the good backup is not pruned by a failed one.
		expect(readdirSync(parent)).toEqual([good.path.slice(parent.length + 1)]);
	});

	test('an attachment file that no longer matches its hash fails the backup', async () => {
		const i = await small();
		const parent = join(tempDir(), 'b');
		writeFileSync(join(i.dir, 'blobs', i.sha), 'something else entirely');
		expect(() => takeBackup(parent)).toThrow(/damaged/);
		i.close();
		expect(readdirSync(parent)).toEqual([]);
	});

	test('a failed backup exits non-zero from the command line', async () => {
		const i = await small();
		rmSync(join(i.dir, 'blobs', i.sha));
		const parent = join(tempDir(), 'b');
		const r = await runCli(['backup', parent], { OPAL_DATA_DIR: i.dir });
		i.close();
		expect(r.code).toBe(1);
		expect(r.err).toContain('Backup failed');
		expect(readdirSync(parent)).toEqual([]);
	}, 60_000);

	test('a damaged database fails the backup', () => {
		const dir = join(tempDir(), 'data');
		mkdirSync(dir);
		writeFileSync(join(dir, 'opal.db'), 'this is not a database, and it is long enough to look like a file'.repeat(200));
		process.env.OPAL_DATA_DIR = dir;
		const parent = join(tempDir(), 'b');
		expect(() => takeBackup(parent)).toThrow();
		expect(readdirSync(parent)).toEqual([]);
	});

	test('a database from before OPAL 2 is refused with a plain message', () => {
		const dir = join(tempDir(), 'data');
		mkdirSync(dir);
		const old = new Database(join(dir, 'opal.db'));
		old.run('CREATE TABLE alembic_version (version_num TEXT)');
		old.close();
		process.env.OPAL_DATA_DIR = dir;
		expect(() => takeBackup(join(tempDir(), 'b'))).toThrow(/not an OPAL 2 database/);
	});

	test('with no database there is nothing to back up, and nothing is created', () => {
		const dir = join(tempDir(), 'missing');
		process.env.OPAL_DATA_DIR = dir;
		const parent = join(tempDir(), 'b');
		expect(() => takeBackup(parent)).toThrow(/no database/);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(parent)).toBe(false);
	});

	test('a missing avatar warns and does not stop the backup of every record', async () => {
		const i = await small();
		const ts = now();
		i.db.insert(userProfile).values({ userId: i.db.select().from(user).get()!.id, avatarHash: 'e'.repeat(64), avatarMime: 'image/png', createdAt: ts, updatedAt: ts }).run();
		const r = takeBackup(join(tempDir(), 'b'));
		i.close();
		expect(r.warnings.join()).toContain('avatar');
		expect(r.counts.avatars).toBe(0);
		expect(() => verifyBackup(r.path)).not.toThrow();
	});

	test('a killed backup leaves a folder that is not counted, not restorable and not deleted', async () => {
		const i = await small();
		// Enough files that the process is still copying when it dies.
		const ts = now();
		i.db.$client.run('BEGIN');
		for (let k = 0; k < 300; k++) {
			const body = `file ${k}`;
			const sha = createHash('sha256').update(body).digest('hex');
			writeFileSync(join(i.dir, 'blobs', sha), body);
			i.db.insert(blob).values({ sha256: sha, sizeBytes: body.length, mimeType: 'text/plain', createdAt: ts }).run();
		}
		i.db.$client.run('COMMIT');
		const parent = join(tempDir(), 'b');
		const proc = Bun.spawn([process.execPath, cli, 'backup', parent], { env: { ...process.env, OPAL_DATA_DIR: i.dir }, stdout: 'ignore', stderr: 'ignore' });
		const partial = () => (existsSync(parent) ? readdirSync(parent).find((n) => n.endsWith('.partial')) : undefined);
		const copied = () => {
			const blobs = join(parent, partial() ?? '-', 'blobs');
			return existsSync(blobs) ? readdirSync(blobs).length : 0;
		};
		// Dies with the database copied and some of the files, not at the very start.
		for (let t = 0; t < 60_000 && copied() < 5; t += 2) await Bun.sleep(2);
		proc.kill('SIGKILL');
		await proc.exited;
		const name = partial();
		expect(name).toBeDefined();
		expect(existsSync(join(parent, name!, 'opal.db'))).toBe(true);
		expect(finishedIn(parent)).toEqual([]);

		process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
		expect(() => restoreBackup(join(parent, name!))).toThrow(/not a complete OPAL backup/);
		expect(existsSync(process.env.OPAL_DATA_DIR)).toBe(false);

		process.env.OPAL_DATA_DIR = i.dir;
		const first = takeBackup(parent, { keep: 1 });
		expect(first.unfinished).toEqual([name!]);
		const second = takeBackup(parent, { keep: 1 });
		i.close();
		expect(second.removed).toEqual([first.path.slice(parent.length + 1)]);
		expect(readdirSync(parent).sort()).toEqual([second.path.slice(parent.length + 1), name!].sort());
	}, 120_000);
});

describe('--keep', () => {
	test('it removes only finished backups beyond the newest n', async () => {
		const i = await small();
		const parent = join(tempDir(), 'b');
		const a = takeBackup(parent);
		const old = join(parent, 'opal-backup-2020-01-01T00-00-00-000Z');
		renameSync(a.path, old);
		const middle = takeBackup(parent);

		// Everything here looks a bit like a backup, or sits where backups sit, and none of it is ours to remove.
		const noManifest = 'opal-backup-2019-01-01T00-00-00-000Z';
		const badManifest = 'opal-backup-2018-01-01T00-00-00-000Z';
		const unfinished = 'opal-backup-2017-01-01T00-00-00-000Z.partial';
		mkdirSync(join(parent, noManifest));
		writeFileSync(join(parent, noManifest, 'opal.db'), 'x');
		mkdirSync(join(parent, badManifest));
		writeFileSync(join(parent, badManifest, 'manifest.json'), 'not json');
		mkdirSync(join(parent, unfinished));
		mkdirSync(join(parent, 'photos'));
		writeFileSync(join(parent, 'photos', 'manifest.json'), '{"format":"opal-backup","files":{}}');
		mkdirSync(join(parent, 'opal-backup-notes'));
		writeFileSync(join(parent, 'opal-backup-2016-01-01T00-00-00-000Z'), 'a file with a backup name');
		writeFileSync(join(parent, 'tax-records.txt'), 'x');
		const outside = takeBackup(tempDir());
		// Making a link needs a privilege on Windows.
		const link = process.platform === 'win32' ? [] : ['opal-backup-2015-01-01T00-00-00-000Z'];
		for (const l of link) symlinkSync(outside.path, join(parent, l));

		const newest = takeBackup(parent, { keep: 2 });
		i.close();
		const name = (p: string) => p.slice(parent.length + 1);
		expect(newest.removed).toEqual(['opal-backup-2020-01-01T00-00-00-000Z']);
		expect(readdirSync(parent).sort()).toEqual(
			[
				name(newest.path),
				name(middle.path),
				noManifest,
				badManifest,
				unfinished,
				'photos',
				'opal-backup-notes',
				'opal-backup-2016-01-01T00-00-00-000Z',
				'tax-records.txt',
				...link
			].sort()
		);
		expect(existsSync(outside.path)).toBe(true);
		expect(newest.unfinished).toEqual(expect.arrayContaining([noManifest, badManifest, unfinished, 'opal-backup-notes']));
	});

	test('the backup just written stays even when the clock has moved backwards', async () => {
		const i = await small();
		const parent = join(tempDir(), 'b');
		const a = takeBackup(parent);
		const future = join(parent, 'opal-backup-2999-01-01T00-00-00-000Z');
		renameSync(a.path, future);
		const r = takeBackup(parent, { keep: 1 });
		i.close();
		expect(existsSync(r.path)).toBe(true);
		expect(existsSync(future)).toBe(false);
	});

	test('a number that is not a whole number of at least 1 is refused before anything happens', async () => {
		const i = await small();
		const parent = join(tempDir(), 'b');
		const runs = await Promise.all(['0', '-1', '1.5', 'all'].map((keep) => runCli(['backup', parent, '--keep', keep], { OPAL_DATA_DIR: i.dir })));
		expect(runs.map((r) => r.code)).toEqual([2, 2, 2, 2]);
		i.close();
		expect(existsSync(parent)).toBe(false);
	}, 120_000);
});

describe('restore refuses', () => {
	async function aBackup() {
		const i = await small();
		const r = takeBackup(join(tempDir(), 'b'));
		i.close();
		return { path: r.path, sha: i.sha };
	}

	test('a folder that already has a database, and changes nothing in it', async () => {
		const { path } = await aBackup();
		const dir = tempDir();
		writeFileSync(join(dir, 'opal.db'), 'precious');
		process.env.OPAL_DATA_DIR = dir;
		expect(() => restoreBackup(path)).toThrow(/already has a database/);
		expect(readdirSync(dir)).toEqual(['opal.db']);
		expect(readFileSync(join(dir, 'opal.db'), 'utf8')).toBe('precious');
	});

	test('a folder with only the write-ahead log of a database', async () => {
		const { path } = await aBackup();
		const dir = tempDir();
		writeFileSync(join(dir, 'opal.db-wal'), 'recent commits');
		process.env.OPAL_DATA_DIR = dir;
		expect(() => restoreBackup(path)).toThrow(/already has a database/);
	});

	test('a folder that holds anything else, and names it', async () => {
		const { path } = await aBackup();
		const dir = tempDir();
		writeFileSync(join(dir, 'notes.txt'), 'x');
		process.env.OPAL_DATA_DIR = dir;
		expect(() => restoreBackup(path)).toThrow(/not empty \(notes\.txt\)/);
		expect(readdirSync(dir)).toEqual(['notes.txt']);
	});

	test('the database named by OPAL_DB_FILE', async () => {
		const { path } = await aBackup();
		const elsewhere = join(tempDir(), 'other.db');
		writeFileSync(elsewhere, 'precious');
		process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
		process.env.OPAL_DB_FILE = elsewhere;
		expect(() => restoreBackup(path)).toThrow(/already has a database/);
	});

	/** The folder stays uncreated: a refused restore leaves nothing to clean up. */
	function refusedFrom(path: string, message: RegExp) {
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		expect(() => restoreBackup(path)).toThrow(message);
		expect(existsSync(dir)).toBe(false);
	}

	test('a folder with no manifest', async () => {
		const { path } = await aBackup();
		rmSync(join(path, 'manifest.json'));
		refusedFrom(path, /not a complete OPAL backup.*interrupted/);
	});

	test('a folder that is not there', () => {
		refusedFrom(join(tempDir(), 'nothing-here'), /not a complete OPAL backup/);
	});

	test('a manifest that cannot be read', async () => {
		const { path } = await aBackup();
		writeFileSync(join(path, 'manifest.json'), '{"format":');
		refusedFrom(path, /cannot be read/);
	});

	test('a backup missing an attachment file', async () => {
		const { path, sha } = await aBackup();
		rmSync(join(path, 'blobs', sha));
		refusedFrom(path, /1 file missing/);
	});

	test('a backup whose attachment file was cut short', async () => {
		const { path, sha } = await aBackup();
		writeFileSync(join(path, 'blobs', sha), 'the bra');
		refusedFrom(path, /1 file changed/);
	});

	test('a manifest that leaves out a file the database needs', async () => {
		const { path, sha } = await aBackup();
		rewriteManifest(path, (m) => {
			delete m.files[`blobs/${sha}`];
		});
		rmSync(join(path, 'blobs', sha));
		refusedFrom(path, /needs 1 attachment file/);
	});

	test('a damaged database copy', async () => {
		const { path } = await aBackup();
		const db = join(path, 'opal.db');
		const bytes = readFileSync(db);
		bytes.fill(0x55, 4096, 12288);
		writeFileSync(db, bytes);
		rewriteManifest(path, (m) => {
			m.files['opal.db'] = sha256(db);
		});
		refusedFrom(path, /integrity check|cannot be read/);
	});

	test('a manifest that points outside the data folder', async () => {
		const { path } = await aBackup();
		for (const bad of ['../outside', 'plugins/../../outside', '/etc/outside', 'blobs/short', 'plugins/a/./b', 'unexpected.txt']) {
			const manifest = readFileSync(join(path, 'manifest.json'), 'utf8');
			rewriteManifest(path, (m) => {
				m.files[bad] = 'f'.repeat(64);
			});
			refusedFrom(path, /unexpected paths/);
			writeFileSync(join(path, 'manifest.json'), manifest);
		}
	});

	test('a backup whose database is newer than this program', async () => {
		const { path } = await aBackup();
		const db = join(path, 'opal.db');
		const sqlite = new Database(db);
		sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 99999999999999)");
		sqlite.close();
		rewriteManifest(path, (m) => {
			m.files['opal.db'] = sha256(db);
		});
		refusedFrom(path, /newer than this version/);
	});
});

describe('a restore that stops partway', () => {
	test('leaves a folder OPAL will not start on, and running it again finishes the job', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();

		// What a crash leaves: the marker, some files, one of them half written, no database.
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		crashBeforePublishing(path);
		writeFileSync(join(dir, 'blobs', i.sha), 'half');
		writeFileSync(join(dir, 'opal.db.restoring'), 'half');

		expect(() => assertNoUnfinishedRestore()).toThrow(/did not finish/);
		const serve = await runCli(['serve', '--port', '0'], { OPAL_DATA_DIR: dir, OPAL_PLUGINS: '0' });
		expect(serve.code).toBe(1);
		expect(serve.err).toContain('did not finish');
		expect(existsSync(join(dir, 'opal.db'))).toBe(false);
		expect(() => takeBackup(join(tempDir(), 'b2'))).toThrow(/did not finish/);

		restoreBackup(path);
		expect(() => assertNoUnfinishedRestore()).not.toThrow();
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);
		expect(existsSync(join(dir, 'opal.db.restoring'))).toBe(false);
		const back = open(dir);
		const [file] = await filesOf(back, i.issueId);
		expect(await (await back.app.request(file!.href)).text()).toBe('the bracket is bent');
		back.close();
	}, 60_000);

	posix('a finished restore is owner-only', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		const old = process.umask(0o022);
		try {
			restoreBackup(path);
		} finally {
			process.umask(old);
		}
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		for (const p of walk(dir)) expect(lstatSync(p).mode & 0o077).toBe(0);
	});
});

describe('a restore keeps its hands off a live database', () => {
	test('a server started while a restore verifies refuses, before anything is written', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		let serve: { exitCode: number; stderr: Buffer } | undefined;
		restoreBackup(path, {
			verifying: () => {
				expect(readdirSync(dir)).toEqual([RESTORE_MARKER]);
				serve = Bun.spawnSync([process.execPath, cli, 'serve', '--port', '0'], { env: { ...process.env, OPAL_DATA_DIR: dir, OPAL_PLUGINS: '0' } });
				expect(existsSync(join(dir, 'opal.db'))).toBe(false);
			}
		});
		expect(serve!.exitCode).toBe(1);
		expect(serve!.stderr.toString()).toContain(`opal restore ${path}`);
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);
		const back = open(dir);
		expect(await (await back.app.request((await filesOf(back, i.issueId))[0]!.href)).text()).toBe('the bracket is bent');
		back.close();
	});

	test('a backup that fails verification leaves the folder as it found it', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		writeFileSync(join(path, 'blobs', i.sha), 'cut');

		const missing = join(tempDir(), 'r', 'data');
		process.env.OPAL_DATA_DIR = missing;
		expect(() => restoreBackup(path)).toThrow(/changed since/);
		expect(existsSync(missing)).toBe(false);

		const empty = join(tempDir(), 'r2');
		mkdirSync(empty);
		process.env.OPAL_DATA_DIR = empty;
		expect(() => restoreBackup(path)).toThrow(/changed since/);
		expect(readdirSync(empty)).toEqual([]);
	});

	test.each([['opal.db'], ['opal.db-wal'], ['opal.db-shm'], ['something-else']])('%s appearing during a restore stops it, and nothing is replaced', async (name) => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		const stray = join(dir, name);
		expect(() => restoreBackup(path, { publishing: () => writeFileSync(stray, 'live') })).toThrow(/Something else wrote/);
		expect(readFileSync(stray, 'utf8')).toBe('live');
		if (name !== 'opal.db') expect(existsSync(join(dir, 'opal.db'))).toBe(false);
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(true);
		// It stays refused until a person has looked at the folder.
		expect(() => restoreBackup(path)).toThrow();
		expect(readFileSync(stray, 'utf8')).toBe('live');
	});
});

describe('a restore that stopped can be finished', () => {
	test('after a crash with the database in place, serve points at restore and restore finishes without writing it again', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		crashBeforePublishing(path);
		// The link is made, and the crash came before the temp file and the marker went.
		copyFileSync(join(dir, 'opal.db.restoring'), join(dir, 'opal.db'));
		const before = statSync(join(dir, 'opal.db')).mtimeMs;

		const serve = await runCli(['serve', '--port', '0'], { OPAL_DATA_DIR: dir, OPAL_PLUGINS: '0' });
		expect(serve.code).toBe(1);
		expect(serve.err).toContain(`opal restore ${path}`);

		const done = restoreBackup(path);
		expect(done.path).toBe(join(dir, 'opal.db'));
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);
		expect(existsSync(join(dir, 'opal.db.restoring'))).toBe(false);
		expect(statSync(join(dir, 'opal.db')).mtimeMs).toBe(before);
		const back = open(dir);
		expect(await (await back.app.request((await filesOf(back, i.issueId))[0]!.href)).text()).toBe('the bracket is bent');
		back.close();
	});

	test.each([
		['different content', 'opal.db', 'a database someone wrote to'],
		['a write-ahead log beside it', 'opal.db-wal', 'x']
	])('a database with %s is not taken for the restored one', async (_what, name, text) => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		crashBeforePublishing(path);
		copyFileSync(join(dir, 'opal.db.restoring'), join(dir, 'opal.db'));
		writeFileSync(join(dir, name), text);
		const before = sha256(join(dir, 'opal.db'));

		expect(() => restoreBackup(path)).toThrow(/is not the one in/);
		expect(sha256(join(dir, 'opal.db'))).toBe(before);
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(true);
	});

	test('a resumed restore refuses a different backup, and the first one still finishes', async () => {
		const i = await small();
		const parent = join(tempDir(), 'b');
		const first = takeBackup(parent);
		const second = takeBackup(parent);
		i.close();
		const dir = join(tempDir(), 'r');
		process.env.OPAL_DATA_DIR = dir;
		crashBeforePublishing(first.path);

		expect(() => restoreBackup(second.path)).toThrow(/different backup/);
		expect(existsSync(join(dir, 'opal.db'))).toBe(false);
		restoreBackup(first.path);
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);
		expect(existsSync(join(dir, 'opal.db'))).toBe(true);
	});

	test('a marker left empty by a crash takes any backup, because nothing was written yet', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		mkdirSync(dir);
		writeFileSync(join(dir, RESTORE_MARKER), '');
		process.env.OPAL_DATA_DIR = dir;
		restoreBackup(path);
		expect(existsSync(join(dir, RESTORE_MARKER))).toBe(false);
		expect(existsSync(join(dir, 'opal.db'))).toBe(true);
	});

	test('a marker nobody can read stops the restore and says what to do', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		const dir = join(tempDir(), 'r');
		mkdirSync(dir);
		writeFileSync(join(dir, RESTORE_MARKER), 'not json');
		process.env.OPAL_DATA_DIR = dir;
		expect(() => restoreBackup(path)).toThrow(/Move the folder aside/);
		expect(() => assertNoUnfinishedRestore()).toThrow(/did not finish/);
	});
});

describe('restore reads only regular files', () => {
	async function backupWith(change: (backup: string, m: { files: Record<string, string> }) => void): Promise<string> {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		rewriteManifest(path, (m) => change(path, m));
		process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
		return path;
	}
	const mkfifo = (path: string) => expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);

	posix('a FIFO in a manifest is refused without waiting on it', async () => {
		const path = await backupWith((backup, m) => {
			mkfifo(join(backup, '.opal_fifo'));
			m.files['.opal_fifo'] = 'a'.repeat(64);
		});
		expect(() => restoreBackup(path)).toThrow(/not a regular file: \.opal_fifo/);
		expect(existsSync(join(process.env.OPAL_DATA_DIR!, RESTORE_MARKER))).toBe(false);
	});

	posix('a FIFO as the manifest itself is refused without waiting on it', async () => {
		const i = await small();
		const { path } = takeBackup(join(tempDir(), 'b'));
		i.close();
		rmSync(join(path, 'manifest.json'));
		mkfifo(join(path, 'manifest.json'));
		process.env.OPAL_DATA_DIR = join(tempDir(), 'r');
		expect(() => restoreBackup(path)).toThrow(/cannot be read/);
	});

	posix('a symbolic link in a manifest is refused, at the file or on the way to it', async () => {
		const outside = join(tempDir(), 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'secret'), 'theirs');
		const hash = sha256(join(outside, 'secret'));
		const link = await backupWith((backup, m) => {
			mkdirSync(join(backup, 'plugin-data', 'x'), { recursive: true });
			symlinkSync(join(outside, 'secret'), join(backup, 'plugin-data', 'x', 'link'));
			m.files['plugin-data/x/link'] = hash;
		});
		expect(() => restoreBackup(link)).toThrow(/not a regular file: plugin-data\/x\/link/);

		const through = await backupWith((backup, m) => {
			mkdirSync(join(backup, 'plugin-data'), { recursive: true });
			symlinkSync(outside, join(backup, 'plugin-data', 'x'));
			m.files['plugin-data/x/secret'] = hash;
		});
		expect(() => restoreBackup(through)).toThrow(/not a regular file: plugin-data\/x\/secret/);
	});
});
