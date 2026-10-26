import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, plugin, pluginSetting, user } from '../../src/db/schema/index.ts';
import { errorResponse, mountOps, serialized } from '../../src/registry.ts';
import { pluginsImpls } from '../../src/ops/plugins.ts';
import { PluginHost } from '../../src/services/plugins/host.ts';
import { runtime, idleRuntime, setRuntime } from '../../src/services/plugins/runtime.ts';
import { openTestDb } from '../helpers/db.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'plugins', 'echo');
const manifest = JSON.parse(readFileSync(join(FIXTURE, 'opal-plugin.json'), 'utf8'));
const ts = '2026-01-01T00:00:00.000Z';

function addPlugin(db: Db, over: Partial<typeof plugin.$inferInsert> = {}) {
	const u = db
		.insert(user)
		.values({ username: 'plugin.echo', name: 'Echo', createdAt: ts, updatedAt: ts })
		.returning()
		.get();
	return db
		.insert(plugin)
		.values({
			key: 'echo',
			source: `local:${FIXTURE}`,
			sha: 'local',
			version: '0.1.0',
			manifest,
			enabled: true,
			userId: u.id,
			createdAt: ts,
			updatedAt: ts,
			...over
		})
		.returning()
		.get();
}

const flush = () => serialized(async () => undefined);
async function until(fn: () => boolean, ms = 8000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await Bun.sleep(25);
	}
	throw new Error('timed out');
}

describe('plugin host', () => {
	let db: Db;
	let server: ReturnType<typeof Bun.serve>;
	let host: PluginHost;
	let oldPort: string | undefined;

	beforeEach(async () => {
		process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-plugins-'));
		db = await openTestDb();
		const app = createApp({ db });
		server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => app.fetch(r) });
		oldPort = process.env.OPAL_PORT;
		process.env.OPAL_PORT = String(server.port);
		host = new PluginHost(db, { healthPollMs: 25, killAfterMs: 1000, backoffStartMs: 50, backoffMaxMs: 200 });
	});
	afterEach(async () => {
		await host.stopAll();
		await server.stop(true);
		if (oldPort === undefined) delete process.env.OPAL_PORT;
		else process.env.OPAL_PORT = oldPort;
	});

	const get = async (path: string) => {
		const res = await fetch(`http://127.0.0.1:${host.port('echo')}${path}`);
		return res.json() as Promise<any>;
	};

	test('an enabled plugin starts, reaches running and gets the agreed environment', async () => {
		addPlugin(db, {});
		db.insert(pluginSetting).values({ pluginId: 1, key: 'apiKey', value: 's3', secret: true, createdAt: ts, updatedAt: ts }).run();
		await host.start('echo');
		await until(() => host.process('echo').state === 'running');
		expect(host.process('echo').pid).toBeGreaterThan(0);
		const env = await get('/env');
		expect(env.OPAL_PLUGIN_ID).toBe('echo');
		expect(env.BUN_BE_BUN).toBe('1');
		expect(env.OPAL_URL).toBe(`http://127.0.0.1:${server.port}`);
		expect(env.OPAL_PLUGIN_PORT).toBe(String(host.port('echo')));
		expect(env.OPAL_TOKEN.startsWith('opal_')).toBe(true);
		expect(env.OPAL_PLUGIN_DATA).toBe(join(process.env.OPAL_DATA_DIR!, 'plugin-data', 'echo'));
		expect(JSON.parse(env.OPAL_SETTINGS)).toEqual({ greeting: 'hi', apiKey: 's3' });
	});

	test('a disabled plugin does not start', async () => {
		addPlugin(db, { enabled: false });
		await host.start('echo');
		expect(host.process('echo').state).toBe('stopped');
		expect(host.port('echo')).toBeNull();
	});

	test('the plugin token works inside its scope and is refused outside it', async () => {
		addPlugin(db);
		await host.start('echo');
		await until(() => host.process('echo').state === 'running');
		const me = await get('/call?path=/auth/me');
		expect(me.status).toBe(200);
		expect(me.body.username).toBe('plugin.echo');
		const health = await get('/call?path=/health');
		expect(health.status).toBe(200);
		const out = await get('/call?path=/plugins');
		expect(out.status).toBe(403);
		expect(out.body.error).toBe('out_of_scope');
	});

	test('stop ends the process and revokes the token; a restart revokes the earlier token', async () => {
		addPlugin(db);
		await host.start('echo');
		await until(() => host.process('echo').state === 'running');
		const first = (await get('/env')).OPAL_TOKEN as string;
		await host.start('echo');
		await until(() => host.process('echo').state === 'running');
		const second = (await get('/env')).OPAL_TOKEN as string;
		expect(second).not.toBe(first);
		const live = () => db.select().from(apiToken).all().filter((t) => !t.revokedAt);
		expect(live()).toHaveLength(1);

		await host.stop('echo');
		await flush();
		expect(host.process('echo').state).toBe('stopped');
		expect(host.port('echo')).toBeNull();
		expect(live()).toHaveLength(0);
		const res = await fetch(`http://127.0.0.1:${server.port}/api/auth/me`, { headers: { authorization: `Bearer ${second}` } });
		expect(res.status).toBe(401);
	});

	test('a crashed plugin restarts with a new process and the log keeps its output', async () => {
		addPlugin(db);
		await host.start('echo');
		await until(() => host.process('echo').state === 'running');
		await get('/say');
		const pid = host.process('echo').pid;
		await get('/crash');
		await until(() => host.process('echo').exitCode === 3 || host.process('echo').restarts > 0);
		await until(() => host.process('echo').state === 'running' && host.process('echo').pid !== pid);
		expect(host.process('echo').restarts).toBe(1);
		const log = host.log('echo');
		expect(log.some((l) => /^\S+Z hello from echo$/.test(l))).toBe(true);
		expect(log.some((l) => /^\S+Z \[err\] trouble from echo$/.test(l))).toBe(true);
		expect(log.some((l) => l.includes('exited with code 3'))).toBe(true);
	});

	test('a stopped plugin does not restart', async () => {
		addPlugin(db);
		await host.start('echo');
		await until(() => host.process('echo').state === 'running');
		await host.stop('echo');
		await Bun.sleep(300);
		expect(host.process('echo').state).toBe('stopped');
	});

	test('a plugin that never answers health is killed and counted as crashed', async () => {
		addPlugin(db, { manifest: { ...manifest, main: 'missing.js' } });
		const slow = new PluginHost(db, { healthTimeoutMs: 300, healthPollMs: 25, backoffStartMs: 5000 });
		await slow.start('echo');
		await until(() => slow.process('echo').state === 'crashed');
		await slow.stopAll();
		expect(slow.process('echo').state).toBe('stopped');
	});
});

describe('plugin operations', () => {
	let db: Db;
	let actor: Actor;
	let call: (method: string, path: string, body?: unknown) => Promise<Response>;
	const calls: string[] = [];

	beforeEach(async () => {
		process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-plugins-'));
		db = await openTestDb();
		const admin = db
			.insert(user)
			.values({ username: 'admin', name: 'Admin', isAdmin: true, createdAt: ts, updatedAt: ts })
			.returning()
			.get();
		actor = { kind: 'user', userId: admin.id, isAdmin: true, sessionId: 1 };
		calls.length = 0;
		setRuntime({
			...idleRuntime,
			start: async (k) => void calls.push(`start:${k}`),
			stop: async (k) => void calls.push(`stop:${k}`)
		});
		const app = new Hono();
		app.onError((err, c) => {
			const { status, body } = errorResponse(err);
			return c.json(body, status as 400);
		});
		mountOps(app, pluginsImpls, db, () => actor);
		call = async (method, path, body) =>
			app.request(`/api${path}`, {
				method,
				headers: body ? { 'content-type': 'application/json' } : {},
				body: body ? JSON.stringify(body) : undefined
			});
		addPlugin(db, { enabled: false });
	});
	afterEach(() => setRuntime(idleRuntime));

	const stored = (key: string) => db.select().from(pluginSetting).where(eq(pluginSetting.key, key)).get();

	test('plugins.list shows every plugin with its process state', async () => {
		const res = await call('GET', '/plugins');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.items).toHaveLength(1);
		expect(body.items[0]).toMatchObject({ id: 'echo', enabled: false, process: { state: 'stopped' } });
	});

	test('plugins.get masks secrets and shows the plugin username', async () => {
		await call('PUT', '/plugins/echo/settings', { values: { apiKey: 'topsecret', greeting: 'yo' } });
		const res = await call('GET', '/plugins/echo');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.username).toBe('plugin.echo');
		expect(body.settings.find((s: any) => s.key === 'apiKey')).toEqual({ key: 'apiKey', value: null, set: true });
		expect(body.settings.find((s: any) => s.key === 'greeting').value).toBe('yo');
		expect((await call('GET', '/plugins/nope')).status).toBe(404);
	});

	test('plugins.settings refuses an unknown key and a value of the wrong type', async () => {
		const res = await call('PUT', '/plugins/echo/settings', { values: { nope: 1, retries: 'x', mode: 'medium', url: 'ftp://a' } });
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(Object.keys(body.fields).sort()).toEqual(['mode', 'nope', 'retries', 'url']);
		expect(stored('retries')).toBeUndefined();
	});

	test('plugins.settings keeps a secret that is left out and clears it with an empty string', async () => {
		await call('PUT', '/plugins/echo/settings', { values: { apiKey: 'one', retries: 3, verbose: true, mode: 'fast', extra: { a: 1 } } });
		expect(stored('apiKey')?.value).toBe('one');
		expect(stored('apiKey')?.secret).toBe(true);
		await call('PUT', '/plugins/echo/settings', { values: { greeting: 'x' } });
		expect(stored('apiKey')?.value).toBe('one');
		await call('PUT', '/plugins/echo/settings', { values: { apiKey: null } });
		expect(stored('apiKey')?.value).toBe('one');
		await call('PUT', '/plugins/echo/settings', { values: { apiKey: '' } });
		expect(stored('apiKey')).toBeUndefined();
		expect(stored('extra')?.value).toEqual({ a: 1 });
	});

	test('plugins.settings restarts an enabled plugin and leaves a disabled one alone', async () => {
		await call('PUT', '/plugins/echo/settings', { values: { greeting: 'a' } });
		expect(calls).toEqual([]);
		db.update(plugin).set({ enabled: true }).run();
		await call('PUT', '/plugins/echo/settings', { values: { greeting: 'b' } });
		expect(calls).toEqual(['start:echo']);
	});

	test('a secret value never reaches the audit log', async () => {
		await call('PUT', '/plugins/echo/settings', { values: { apiKey: 'topsecret' } });
		const rows = db.$client.query('select after from audit_log where entity = ?').all('plugin_setting') as { after: string }[];
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((r) => r.after.includes('topsecret'))).toBe(false);
	});

	test('plugins.enable lists the required settings that have no value', async () => {
		const res = await call('POST', '/plugins/echo/enable');
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error).toBe('missing_settings');
		expect(body.fields).toEqual({ apiKey: 'Required' });
		expect(calls).toEqual([]);
	});

	test('plugins.enable sets enabled and starts the plugin', async () => {
		await call('PUT', '/plugins/echo/settings', { values: { apiKey: 'k' } });
		const res = await call('POST', '/plugins/echo/enable');
		expect(res.status).toBe(200);
		expect((await res.json()).enabled).toBe(true);
		expect(calls).toEqual(['start:echo']);
	});

	test('plugins.disable sets disabled and stops the plugin', async () => {
		db.update(plugin).set({ enabled: true }).run();
		const res = await call('POST', '/plugins/echo/disable');
		expect(res.status).toBe(200);
		expect((await res.json()).enabled).toBe(false);
		expect(calls).toEqual(['stop:echo']);
	});

	test('plugins.restart refuses a disabled plugin and restarts an enabled one', async () => {
		const res = await call('POST', '/plugins/echo/restart');
		expect(res.status).toBe(409);
		expect(calls).toEqual([]);
		db.update(plugin).set({ enabled: true }).run();
		expect((await call('POST', '/plugins/echo/restart')).status).toBe(200);
		expect(calls).toEqual(['start:echo']);
	});

	test('a person who is not an admin cannot list plugins', async () => {
		actor = { kind: 'user', userId: 1, isAdmin: false, sessionId: 1 };
		expect((await call('GET', '/plugins')).status).toBe(403);
		expect(runtime()).not.toBeUndefined();
	});
});
