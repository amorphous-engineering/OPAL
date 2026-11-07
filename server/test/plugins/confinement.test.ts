import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dlopen, FFIType } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { eq } from 'drizzle-orm';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.ts';
import type { Actor, Ctx } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, plugin, user } from '../../src/db/schema/index.ts';
import { setGithubFetch } from '../../src/services/plugins/github.ts';
import { PluginHost } from '../../src/services/plugins/host.ts';
import { idleRuntime, setRuntime } from '../../src/services/plugins/runtime.ts';
import { ConfinementRefused, confinementPolicy, planLaunch, type PluginStart } from '../../src/services/plugins/sandbox.ts';
import { insert } from '../../src/write.ts';
import { openTestDb } from '../helpers/db.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'plugins', 'reach');
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'opal-plugin.json'), 'utf8'));
const DB_HEAD = 'SQLite format 3';
const SECRET = 'the-auth-secret';
const SECRETS_KEY = 'the-key-to-stored-secrets';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

async function until(fn: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await Bun.sleep(25);
	}
	throw new Error('timed out');
}

/**
 * Asks the kernel itself, not the code under test: a sandbox that stops working must fail these
 * tests, not skip them.
 */
function kernelOffersLandlock(): boolean {
	if (process.platform !== 'linux' || process.getuid?.() === 0) return false;
	const { symbols } = dlopen('libc.so.6', {
		syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 }
	});
	return Number(symbols.syscall(444, 0, 0, 1)) > 0;
}
const LANDLOCK = kernelOffersLandlock();
const ROOT = process.platform === 'linux' && process.getuid?.() === 0;

/** A data folder like a real one: a real SQLite file, held open, and an auth secret. */
function fillDataFolder(): { dir: string; held: Database } {
	const dir = mkdtempSync(join(tmpdir(), 'opal-confine-'));
	process.env.OPAL_DATA_DIR = dir;
	const held = new Database(join(dir, 'opal.db'));
	held.run('PRAGMA journal_mode = WAL');
	held.run('CREATE TABLE t (x)');
	held.run("INSERT INTO t VALUES ('private')");
	writeFileSync(join(dir, '.opal_auth_secret'), SECRET, { mode: 0o600 });
	writeFileSync(join(dir, '.opal_secrets_key'), SECRETS_KEY, { mode: 0o600 });
	writeFileSync(join(dir, '.opal_secrets_key.tmp'), SECRETS_KEY, { mode: 0o600 });
	mkdirSync(join(dir, 'plugin-data', 'other'), { recursive: true });
	writeFileSync(join(dir, 'plugin-data', 'other', 'note.txt'), 'not yours');
	return { dir, held };
}

const denied = (r: { ok: boolean; code?: string }) => expect(r.ok, JSON.stringify(r)).toBe(false);

function repoTarball(version: string, over: Record<string, string> = {}): Uint8Array {
	const work = mkdtempSync(join(tmpdir(), 'opal-tar-'));
	const top = join(work, 'owner-repo-abc1234');
	cpSync(FIXTURE, top, { recursive: true });
	writeFileSync(join(top, 'version.txt'), version);
	for (const [path, content] of Object.entries(over)) writeFileSync(join(top, path), content);
	const out = join(work, 'out.tar.gz');
	if (Bun.spawnSync(['tar', '-czf', out, '-C', work, 'owner-repo-abc1234']).exitCode !== 0) throw new Error('tar failed');
	const bytes = new Uint8Array(readFileSync(out));
	rmSync(work, { recursive: true, force: true });
	return bytes;
}

/** A real server, a real host, and the plugin installed and enabled through the API. */
async function serverWithPlugin() {
	const { dir, held } = fillDataFolder();
	const db: Db = await openTestDb();
	const sys = (): Ctx => ({ db, actor: { kind: 'system' }, op: 'test' });
	const admin = insert(sys(), user, { username: 'admin', name: 'Admin', isAdmin: true });
	const actor: Actor = { kind: 'user', userId: admin.id, isAdmin: true, sessionId: 1 };
	const app = createApp({ db, resolveActor: () => actor });
	// The plugin's own calls go through the real token check.
	const served = createApp({ db });
	const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => served.fetch(r) });
	const oldPort = process.env.OPAL_PORT;
	process.env.OPAL_PORT = String(server.port);
	const host = new PluginHost(db, { healthPollMs: 25, killAfterMs: 1000, backoffStartMs: 50, backoffMaxMs: 200 });
	setRuntime(host);

	const tars: Record<string, Uint8Array> = {};
	setGithubFetch(async (url) => {
		const t = /tar\.gz\/([0-9a-f]{40})$/.exec(url);
		return t && tars[t[1]!] ? new Response(tars[t[1]!] as unknown as BodyInit) : new Response('no', { status: 404 });
	});
	const call = (method: string, path: string, body?: unknown) =>
		app.request(`/api${path}`, {
			method,
			headers: body ? { 'content-type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
	const installCommit = async (sha: string, version: string) => {
		tars[sha] = repoTarball(version);
		const res = await call('POST', '/plugins/install', { source: 'owner/repo', sha });
		expect(res.status).toBe(200);
	};
	const get = async (path: string) => (await fetch(`http://127.0.0.1:${host.port('reach')}${path}`)).json() as Promise<any>;
	const running = () => until(() => host.process('reach').state === 'running');
	const close = async () => {
		await host.stopAll();
		setRuntime(idleRuntime);
		setGithubFetch(fetch);
		await server.stop(true);
		if (oldPort === undefined) delete process.env.OPAL_PORT;
		else process.env.OPAL_PORT = oldPort;
		held.close();
	};
	return { db, dir, host, call, installCommit, get, running, close, server };
}

afterEach(() => {
	delete process.env.OPAL_PLUGIN_CONFINEMENT;
});

describe.if(LANDLOCK)('a confined plugin on Linux', () => {
	let s: Awaited<ReturnType<typeof serverWithPlugin>>;

	beforeEach(async () => {
		s = await serverWithPlugin();
		await s.installCommit(SHA1, '1');
		expect((await s.call('POST', '/plugins/reach/enable')).status).toBe(200);
		await s.running();
	});
	afterEach(async () => {
		await s.close();
	});

	test('cannot read the database or the auth secret, or list the data folder', async () => {
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		for (const name of ['db', 'dbWal', 'secret', 'dataFolder']) denied(o[name]);
		expect(o.db.code).toBe('EACCES');
		expect(o.secret.code).toBe('EACCES');
		expect(JSON.stringify(o)).not.toContain(DB_HEAD);
		expect(JSON.stringify(o)).not.toContain(SECRET);
	});

	test('cannot read the key that decrypts stored secrets', async () => {
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		expect(o.secretsKey).toEqual({ ok: false, code: 'EACCES' });
		expect(o.secretsKeyTmp).toEqual({ ok: false, code: 'EACCES' });
		expect(JSON.stringify(o)).not.toContain(SECRETS_KEY);
	});

	test('cannot change the database in any way, and it stays intact', async () => {
		const before = statSync(join(s.dir, 'opal.db'));
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		for (const name of ['dbWrite', 'rename', 'chmod', 'truncate']) denied(o[name]);
		const after = statSync(join(s.dir, 'opal.db'));
		expect(after.mode).toBe(before.mode);
		expect(after.size).toBe(before.size);
		expect(readFileSync(join(s.dir, 'opal.db')).subarray(0, 15).toString()).toBe(DB_HEAD);
		expect(existsSync(join(s.dir, 'plugin-data', 'reach', 'stolen.db'))).toBe(false);
	});

	test('a link in its own folder does not lead to the database', async () => {
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		denied(o.symlink);
		denied(o.hardlink);
	});

	test('cannot touch another plugin, the home folder or /tmp, or write to its own code', async () => {
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		for (const name of ['sibling', 'siblingWrite', 'codeWrite', 'home', 'tmp', 'etcShadow']) denied(o[name]);
		expect(readFileSync(join(s.dir, 'plugin-data', 'other', 'note.txt'), 'utf8')).toBe('not yours');
	});

	test('cannot reach the server through /proc', async () => {
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		for (const name of ['serverEnviron', 'serverMem', 'serverCwd', 'serverRoot']) denied(o[name]);
		expect(o.serverFds.length).toBeGreaterThan(0);
		for (const fd of o.serverFds) denied(fd);
	});

	test('holds no file the server has open', async () => {
		const i = await s.get('/inside');
		const under = i.openFiles.filter((p: string) => p.startsWith(s.dir) && !p.startsWith(join(s.dir, 'plugin-data', 'reach')));
		expect(under).toEqual([]);
		expect(i.openFiles.some((p: string) => p.includes('opal.db'))).toBe(false);
	});

	test('cannot connect to a Unix socket, the way out through a user service bus', async () => {
		const path = join(mkdtempSync(join(tmpdir(), 'opal-sock-')), 's');
		const listener = Bun.listen({ unix: path, socket: { data() {} } });
		try {
			const r = await s.get(`/socket?path=${encodeURIComponent(path)}`);
			denied(r);
			expect(r.code).toBe('EACCES');
		} finally {
			listener.stop(true);
		}
	});

	test('works normally in its own folder and temp folder, and can run programs', async () => {
		const i = await s.get('/inside');
		const own = join(s.dir, 'plugin-data', 'reach');
		expect(i.write).toEqual({ ok: true, value: 'kept' });
		expect(i.temp.ok).toBe(true);
		expect(i.temp.value.startsWith(own)).toBe(true);
		expect(i.home).toBe(own);
		expect(i.code.ok).toBe(true);
		expect(i.child).toEqual({ ok: true, value: 'from a child' });
		expect(i.bunChild).toEqual({ ok: true, value: '2' });
	});

	test('reaches the API with its scoped token, and nothing beyond the scope', async () => {
		expect(await s.get('/api?path=/auth/me')).toEqual({ status: 200 });
		expect(await s.get('/api?path=/health')).toEqual({ status: 200 });
		expect(await s.get('/api?path=/parts')).toEqual({ status: 403 });
	});

	test('the process view and the log say how it is confined', async () => {
		const res = await s.call('GET', '/plugins/reach');
		expect(((await res.json()) as any).process.confinement).toBe('landlock');
		expect(s.host.log('reach').some((l) => l.includes('Confined: Landlock ABI'))).toBe(true);
	});

	test('the launch instructions do not reach the plugin', async () => {
		const r = Bun.spawnSync(['sh', '-c', `tr '\\0' '\\n' < /proc/${s.host.process('reach').pid}/environ`]);
		const names = r.stdout.toString().split('\n').map((l) => l.split('=')[0]);
		expect(names).toContain('OPAL_TOKEN');
		expect(names).not.toContain('OPAL_SANDBOX_SPEC');
		expect(names).not.toContain('OPAL_DATA_DIR');
	});

	test('a crash restarts it, still confined', async () => {
		const pid = s.host.process('reach').pid;
		await s.get('/crash');
		await until(() => s.host.process('reach').state === 'running' && s.host.process('reach').pid !== pid);
		expect(s.host.process('reach').confinement).toBe('landlock');
		denied((await s.get(`/outside?home=${encodeURIComponent(homedir())}`)).db);
	});

	test('an update runs the new code, keeps its data, gets a new token and stays confined', async () => {
		await s.get('/keep?text=across-updates');
		const live = () => s.db.select().from(apiToken).all().filter((t) => !t.revokedAt);
		const firstToken = live()[0]!.tokenHash;
		await s.installCommit(SHA2, '2');
		await until(() => s.host.process('reach').state === 'running' && live()[0]?.tokenHash !== firstToken);
		await s.running();
		const v = await s.get('/version');
		expect(v.version).toBe('2');
		expect(v.mine).toEqual({ ok: true, value: 'across-updates' });
		expect(live()).toHaveLength(1);
		expect(await s.get('/api?path=/auth/me')).toEqual({ status: 200 });
		expect(s.host.process('reach').confinement).toBe('landlock');
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		denied(o.db);
		denied(o.secret);
	});
});

describe.if(LANDLOCK)('what runs before confinement', () => {
	test('a file the launcher inherits open does not reach the plugin', async () => {
		const { dir, held } = fillDataFolder();
		const fd = openSync(join(dir, 'opal.db'), 'r');
		try {
			const code = mkdtempSync(join(tmpdir(), 'opal-inherit-'));
			const data = join(dir, 'plugin-data', 'inherit');
			mkdirSync(data, { recursive: true });
			writeFileSync(
				join(code, 'main.js'),
				`import { readSync } from 'node:fs';
				const b = Buffer.alloc(15);
				try { readSync(3, b, 0, 15, 0); console.log('read:' + b); } catch (e) { console.log('refused:' + e.code); }`
			);
			const plan = await planLaunch({ id: 1, code, main: 'main.js', data, local: true, env: { BUN_BE_BUN: '1' } });
			expect(plan.confinement).toBe('landlock');
			const proc = Bun.spawn(plan.cmd, { cwd: plan.cwd, env: plan.env, stdio: ['ignore', 'pipe', 'inherit', fd] });
			const out = await new Response(proc.stdout as ReadableStream).text();
			await proc.exited;
			expect(out).not.toContain(DB_HEAD);
			expect(out).toContain('refused:');
		} finally {
			closeSync(fd);
			held.close();
		}
	});

	test('config files in the plugin folder and its data folder cannot run code ahead of the sandbox', async () => {
		const { dir, held } = fillDataFolder();
		try {
			const code = mkdtempSync(join(tmpdir(), 'opal-preload-'));
			const data = join(dir, 'plugin-data', 'evil');
			mkdirSync(data, { recursive: true });
			const preload = join(code, 'preload.js');
			writeFileSync(
				preload,
				`import { appendFileSync, readFileSync } from 'node:fs';
				let got = 'denied';
				try { got = readFileSync(${JSON.stringify(join(dir, 'opal.db'))}).subarray(0, 15).toString(); } catch {}
				appendFileSync(${JSON.stringify(join(data, 'preload.log'))}, got + '\\n');
				try { appendFileSync(${JSON.stringify(join(dir, 'unconfined-preload'))}, 'ran\\n'); } catch {}`
			);
			const bunfig = `preload = [${JSON.stringify(preload)}]\n`;
			writeFileSync(join(code, 'bunfig.toml'), bunfig);
			writeFileSync(join(data, '.bunfig.toml'), bunfig);
			writeFileSync(join(data, 'bunfig.toml'), bunfig);
			writeFileSync(join(code, 'main.js'), 'console.log("main ran")');

			const plan = await planLaunch({ id: 1, code, main: 'main.js', data, local: true, env: { BUN_BE_BUN: '1', PATH: process.env.PATH ?? '' } });
			expect(plan.confinement).toBe('landlock');
			const proc = Bun.spawn(plan.cmd, { cwd: plan.cwd, env: plan.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			await proc.exited;
			expect(out + err).toContain('main ran');
			// It ran once, inside: it could write to its own folder and nowhere else.
			expect(existsSync(join(dir, 'unconfined-preload'))).toBe(false);
			expect(readFileSync(join(data, 'preload.log'), 'utf8').trim().split('\n')).toEqual(['denied']);
		} finally {
			held.close();
		}
	});
});

describe('when a plugin cannot be confined', () => {
	const start = (over: Partial<PluginStart> = {}): PluginStart => ({
		id: 1,
		code: FIXTURE,
		main: 'main.js',
		data: join(tmpdir(), 'opal-none'),
		local: true,
		env: { BUN_BE_BUN: '1' },
		...over
	});

	test.each(['darwin', 'win32'] as const)('on %s it runs as OPAL does, and the note says it can read the database', async (platform) => {
		const plan = await planLaunch(start(), { platform, uid: 501 });
		expect(plan.confinement).toBe('none');
		expect(plan.cmd).toEqual([process.execPath, join(FIXTURE, 'main.js')]);
		expect(plan.note).toContain('Not confined');
		expect(plan.note).toContain('database');
	});

	test.each(['darwin', 'win32'] as const)('on %s with confinement required it is refused', async (platform) => {
		process.env.OPAL_PLUGIN_CONFINEMENT = 'required';
		await expect(planLaunch(start(), { platform, uid: 501 })).rejects.toBeInstanceOf(ConfinementRefused);
	});

	test('a misspelled policy counts as required, and an empty one as auto', () => {
		process.env.OPAL_PLUGIN_CONFINEMENT = 'requierd';
		expect(confinementPolicy()).toBe('required');
		process.env.OPAL_PLUGIN_CONFINEMENT = ' ';
		expect(confinementPolicy()).toBe('auto');
		process.env.OPAL_PLUGIN_CONFINEMENT = 'OFF';
		expect(confinementPolicy()).toBe('off');
	});

	describe.if(LANDLOCK)('on a Linux machine that could', () => {
		test('off turns it off, and the plugin reads the database as before', async () => {
			const s = await serverWithPlugin();
			try {
				process.env.OPAL_PLUGIN_CONFINEMENT = 'off';
				await s.installCommit(SHA1, '1');
				await s.call('POST', '/plugins/reach/enable');
				await s.running();
				expect(s.host.process('reach').confinement).toBe('none');
				const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
				expect(o.db).toEqual({ ok: true, value: DB_HEAD });
				expect(s.host.log('reach').some((l) => l.includes('[err] Not confined'))).toBe(true);
			} finally {
				await s.close();
			}
		});

		/** A local source that holds the data folder would leave the database readable. */
		async function dataInsideCode() {
			const parent = mkdtempSync(join(tmpdir(), 'opal-parent-'));
			cpSync(FIXTURE, parent, { recursive: true });
			const dir = join(parent, 'data');
			mkdirSync(join(dir, 'plugin-data', 'reach'), { recursive: true });
			writeFileSync(join(dir, 'opal.db'), 'SQLite format 3\0');
			process.env.OPAL_DATA_DIR = dir;
			process.env.OPAL_PLUGINS_LOCAL = '1';
			const db: Db = await openTestDb();
			const u = insert({ db, actor: { kind: 'system' }, op: 'test' }, user, { username: 'plugin.reach', name: 'Reach' });
			insert({ db, actor: { kind: 'system' }, op: 'test' }, plugin, {
				key: 'reach',
				source: `local:${parent}`,
				sha: 'local',
				version: '0.1.0',
				manifest: { ...manifest, settings: [], panels: [], actions: [], links: [] },
				enabled: true,
				userId: u.id
			});
			return { db, parent };
		}

		test('a plan that would leave the database readable is not called confined', async () => {
			const { parent } = await dataInsideCode();
			const dir = process.env.OPAL_DATA_DIR!;
			const plan = await planLaunch({ id: 1, code: parent, main: 'main.js', data: join(dir, 'plugin-data', 'reach'), local: true, env: { BUN_BE_BUN: '1' } });
			expect(plan.confinement).toBe('none');
			expect(plan.note).toContain('could still read');
			delete process.env.OPAL_PLUGINS_LOCAL;
		});

		test('with confinement required it does not start, says why, and mints no token', async () => {
			process.env.OPAL_PLUGIN_CONFINEMENT = 'required';
			const { db } = await dataInsideCode();
			const host = new PluginHost(db, { backoffStartMs: 5000, backoffMaxMs: 5000 });
			try {
				await host.start('reach');
				await until(() => host.process('reach').state === 'crashed');
				expect(host.process('reach').pid).toBeNull();
				expect(host.log('reach').some((l) => l.includes('requires confinement'))).toBe(true);
				expect(db.select().from(apiToken).all()).toHaveLength(0);
			} finally {
				await host.stopAll();
				delete process.env.OPAL_PLUGINS_LOCAL;
			}
		});
	});
});

test('CI runs the confinement tests rather than skipping them', () => {
	if (!process.env.CI || process.platform !== 'linux') return;
	expect(LANDLOCK).toBe(true);
});

// Runs only under root: `sudo bun test test/plugins/confinement.test.ts --timeout 240000`.
describe.if(ROOT)('a plugin started by root', () => {
	let s: Awaited<ReturnType<typeof serverWithPlugin>>;

	beforeEach(async () => {
		s = await serverWithPlugin();
		await s.installCommit(SHA1, '1');
		expect((await s.call('POST', '/plugins/reach/enable')).status).toBe(200);
		await s.running();
	});
	afterEach(async () => {
		await s.close();
	});

	test('runs as its own user, with no groups, and owns only its data folder', async () => {
		expect(s.host.process('reach').confinement).toBe('separate-user');
		const who = await s.get('/uid');
		expect(who.uid).toBeGreaterThan(1_000_000_000);
		expect(who.gid).toBe(who.uid);
		expect(who.groups.filter((g: number) => g !== who.gid)).toEqual([]);
		expect(statSync(join(s.dir, 'plugin-data', 'reach')).uid).toBe(who.uid);
		const code = join(s.dir, 'plugins', 'reach', SHA1);
		expect(statSync(code).uid).toBe(0);
		expect(statSync(code).mode & 0o777).toBe(0o750);
	});

	test('cannot read the database or the secret, or write to its own code', async () => {
		const o = await s.get(`/outside?home=${encodeURIComponent(homedir())}`);
		for (const name of ['db', 'secret', 'secretsKey', 'dataFolder', 'sibling', 'codeWrite', 'dbWrite', 'chmod', 'truncate', 'serverEnviron']) denied(o[name]);
		expect(readdirSync(s.dir)).toContain('opal.db');
	});

	test('still works in its own folder, reaches the API, and survives an update', async () => {
		expect((await s.get('/inside')).write).toEqual({ ok: true, value: 'kept' });
		expect(await s.get('/api?path=/auth/me')).toEqual({ status: 200 });
		await s.get('/keep?text=across-updates');
		const { pid } = s.host.process('reach');
		await s.installCommit(SHA2, '2');
		await until(() => s.host.process('reach').state === 'running' && s.host.process('reach').pid !== pid);
		const v = await s.get('/version');
		expect(v.version).toBe('2');
		expect(v.mine).toEqual({ ok: true, value: 'across-updates' });
		expect(s.host.process('reach').confinement).toBe('separate-user');
		denied((await s.get(`/outside?home=${encodeURIComponent(homedir())}`)).db);
	});
});
