import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { isSealed } from '../../src/auth/sealed.ts';
import type { Actor, Ctx } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, auditLog, externalLink, plugin, pluginSetting, user } from '../../src/db/schema/index.ts';
import { pluginsInstallImpls } from '../../src/ops/plugins-install.ts';
import { errorResponse, mountOps, serialized } from '../../src/registry.ts';
import { isCompatible } from '../../src/services/plugins/install.ts';
import { MAX_DOWNLOAD_BYTES, parseSource, setGithubFetch } from '../../src/services/plugins/github.ts';
import { saveSettings } from '../../src/services/plugins/settings.ts';
import { pluginDir, pluginsRoot, settingValues, toDetail } from '../../src/services/plugins/store.ts';
import { insert } from '../../src/write.ts';
import { openTestDb } from '../helpers/db.ts';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);

const manifest = (over: Record<string, unknown> = {}) => ({
	id: 'demo',
	name: 'Demo',
	version: '0.1.0',
	opal: '>=0.0.1',
	main: 'dist/plugin.js',
	settings: [{ key: 'url', label: 'URL', type: 'url' }],
	...over
});

/** A repository folder packed like GitHub does: one top-level folder, built with the tar CLI. */
function repoTarball(files: Record<string, string>): Uint8Array {
	const work = mkdtempSync(join(tmpdir(), 'opal-tar-'));
	const top = join(work, 'owner-repo-abc1234');
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(top, path, '..'), { recursive: true });
		writeFileSync(join(top, path), content);
	}
	const out = join(work, 'out.tar.gz');
	const r = Bun.spawnSync(['tar', '-czf', out, '-C', work, 'owner-repo-abc1234']);
	if (r.exitCode !== 0) throw new Error('tar failed');
	return new Uint8Array(readFileSync(out));
}

/** A raw ustar archive, for entries the tar CLI refuses to write. */
function rawTarball(entries: { name: string; body?: string; type?: string; link?: string }[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const e of entries) {
		const body = new TextEncoder().encode(e.body ?? '');
		const h = new Uint8Array(512);
		const put = (s: string, at: number) => h.set(new TextEncoder().encode(s), at);
		put(e.name, 0);
		put('0000644\0', 100);
		put(body.length.toString(8).padStart(11, '0') + '\0', 124);
		h[156] = (e.type ?? '0').charCodeAt(0);
		if (e.link) put(e.link, 157);
		put('ustar\0', 257);
		put('        ', 148);
		let sum = 0;
		for (const b of h) sum += b;
		put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
		blocks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
	}
	blocks.push(new Uint8Array(1024));
	return gzipSync(Buffer.concat(blocks));
}

const goodFiles = (over: Record<string, unknown> = {}) => ({
	'opal-plugin.json': JSON.stringify(manifest(over)),
	'dist/plugin.js': 'console.log(1)'
});

/** Serve tarballs by commit: the injected fetch answers GitHub's two endpoints. */
function serve(shaByRef: Record<string, string>, tarByRef: Record<string, Uint8Array>) {
	const calls: string[] = [];
	setGithubFetch(async (url) => {
		calls.push(url);
		const m = /commits\/(.+)$/.exec(url);
		if (m) {
			const sha = shaByRef[decodeURIComponent(m[1]!)];
			return sha ? new Response(sha) : new Response('no', { status: 404 });
		}
		const t = /tar\.gz\/([0-9a-f]{40})$/.exec(url);
		const sha = t?.[1];
		const ref = Object.keys(shaByRef).find((k) => shaByRef[k] === sha);
		const tar = ref ? tarByRef[ref] : undefined;
		return tar ? new Response(tar as unknown as BodyInit) : new Response('no', { status: 404 });
	});
	return calls;
}

let db: Db;
let actor: Actor;
let app: Hono;
const call = (method: string, path: string, body?: unknown) =>
	app.request(`/api${path}`, {
		method,
		headers: body ? { 'content-type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined
	});
const sys = (): Ctx => ({ db, actor: { kind: 'system' }, op: 'test' });

beforeEach(async () => {
	process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-plugins-'));
	delete process.env.OPAL_PLUGINS_LOCAL;
	delete process.env.OPAL_PLUGINS;
	db = await openTestDb();
	const admin = insert(sys(), user, { username: 'admin', name: 'Admin', isAdmin: true });
	actor = { kind: 'user', userId: admin.id, isAdmin: true, sessionId: 1 };
	app = new Hono();
	app.onError((err, c) => {
		const { status, body } = errorResponse(err);
		return c.json(body, status as 400);
	});
	mountOps(app, pluginsInstallImpls, db, () => actor);
});
afterEach(() => {
	setGithubFetch();
	delete process.env.OPAL_PLUGINS;
});

const stagedFolders = () => {
	const root = join(pluginsRoot(), '.staging');
	return existsSync(root) ? readdirSync(root) : [];
};

describe('a server with plugins off', () => {
	for (const value of ['0', 'false', 'off', 'FALSE']) {
		test(`OPAL_PLUGINS=${value} refuses a preview without touching the network or the disk`, async () => {
			process.env.OPAL_PLUGINS = value;
			const calls = serve({ HEAD: SHA1 }, { HEAD: repoTarball(goodFiles()) });
			const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
			expect(res.status).toBe(409);
			const body = (await res.json()) as any;
			expect(body.error).toBe('plugins_off');
			expect(body.message).toContain('off on this server');
			expect(calls).toEqual([]);
			expect(stagedFolders()).toEqual([]);
		});
	}

	test('install is refused as well', async () => {
		process.env.OPAL_PLUGINS = '0';
		const calls = serve({ HEAD: SHA1 }, { HEAD: repoTarball(goodFiles()) });
		const res = await call('POST', '/plugins/install', { source: 'owner/repo', sha: SHA1 });
		expect(res.status).toBe(409);
		expect(calls).toEqual([]);
		expect(db.select().from(plugin).all()).toHaveLength(0);
	});

	test('plugins are on when the setting is unset or says so', async () => {
		for (const value of [undefined, '', '1', 'true', 'on']) {
			if (value === undefined) delete process.env.OPAL_PLUGINS;
			else process.env.OPAL_PLUGINS = value;
			serve({ HEAD: SHA1 }, { HEAD: repoTarball(goodFiles()) });
			expect((await call('POST', '/plugins/preview', { source: 'owner/repo' })).status).toBe(200);
		}
	});
});

describe('source parsing', () => {
	test('four spellings name the same repository', () => {
		expect(parseSource('o/r')).toMatchObject({ source: 'github:o/r', ref: null });
		expect(parseSource('o/r@v1')).toMatchObject({ source: 'github:o/r', ref: 'v1' });
		expect(parseSource('https://github.com/o/r')).toMatchObject({ source: 'github:o/r', ref: null });
		expect(parseSource('https://github.com/o/r/tree/feat/x')).toMatchObject({ source: 'github:o/r', ref: 'feat/x' });
	});
	test('a source outside github.com is refused', () => {
		expect(() => parseSource('https://example.com/o/r')).toThrow();
	});
});

describe('plugins.preview', () => {
	test('preview shows the manifest and the commit, and writes nothing', async () => {
		serve({ HEAD: SHA1 }, { HEAD: repoTarball(goodFiles()) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ source: 'github:owner/repo', ref: null, sha: SHA1, installed: null, compatible: true });
		expect(body.manifest.id).toBe('demo');
		expect(db.select().from(plugin).all()).toHaveLength(0);
	});

	test('preview resolves the requested ref', async () => {
		const calls = serve({ v2: SHA2 }, { v2: repoTarball(goodFiles()) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo@v2' });
		expect(((await res.json()) as any).sha).toBe(SHA2);
		expect(calls[0]).toBe('https://api.github.com/repos/owner/repo/commits/v2');
	});

	test('preview of a missing repository answers 404 with a clear code', async () => {
		serve({}, {});
		const res = await call('POST', '/plugins/preview', { source: 'owner/nothing' });
		expect(res.status).toBe(404);
		expect(((await res.json()) as any).error).toBe('github_not_found');
	});

	test('preview reports a GitHub rate limit as 429', async () => {
		setGithubFetch(async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(429);
	});

	test('preview reports a network failure as 502', async () => {
		setGithubFetch(async () => {
			throw new Error('offline');
		});
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(502);
	});

	test('a manifest with a bad field gives 422 with the field named', async () => {
		serve({ HEAD: SHA1 }, { HEAD: repoTarball(goodFiles({ id: 'Bad Id', extra: 1 })) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(422);
		expect(Object.keys(((await res.json()) as any).fields).length).toBeGreaterThan(0);
	});

	test('a repository without a manifest is refused', async () => {
		serve({ HEAD: SHA1 }, { HEAD: repoTarball({ 'readme.md': 'x' }) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(422);
	});

	test('a manifest whose main file is missing is refused', async () => {
		serve({ HEAD: SHA1 }, { HEAD: repoTarball({ 'opal-plugin.json': JSON.stringify(manifest()) }) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(422);
		expect(((await res.json()) as any).fields.main).toBeTruthy();
	});

	test('an archive entry with .. is refused and leaves nothing behind', async () => {
		serve({ HEAD: SHA1 }, { HEAD: rawTarball([{ name: 'top/../../evil.txt', body: 'x' }]) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(422);
		expect(((await res.json()) as any).error).toBe('invalid_archive');
		expect(stagedFolders()).toEqual([]);
	});

	test('an archive entry with a negative size is refused instead of looping', async () => {
		serve({ HEAD: SHA1 }, { HEAD: rawTarball([{ name: 'pax', type: 'x', body: '14 size=-1536\n' }, { name: 'top/a.txt', body: 'x' }]) });
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(422);
		expect(((await res.json()) as any).error).toBe('invalid_archive');
	});

	test('a preview leaves no staging folder behind, and install still works after it', async () => {
		serve({ v1: SHA1 }, { v1: repoTarball(goodFiles()) });
		const p = (await (await call('POST', '/plugins/preview', { source: 'owner/repo@v1' })).json()) as any;
		expect(stagedFolders()).toEqual([]);
		const res = await call('POST', '/plugins/install', { source: `${p.source}@${p.ref}`, sha: p.sha });
		expect(res.status).toBe(200);
		expect(existsSync(join(pluginDir('demo', SHA1), 'opal-plugin.json'))).toBe(true);
		expect(stagedFolders()).toEqual([]);
	});

	test('a preview that finds a bad manifest leaves no staging folder behind', async () => {
		serve({ HEAD: SHA1 }, { HEAD: repoTarball({ 'README.md': 'x' }) });
		expect((await call('POST', '/plugins/preview', { source: 'owner/repo' })).status).toBe(422);
		expect(stagedFolders()).toEqual([]);
	});

	test('a failed install leaves no staging folder behind', async () => {
		serve({ HEAD: SHA1 }, { HEAD: repoTarball({ 'opal-plugin.json': JSON.stringify(manifest()) }) });
		const res = await call('POST', '/plugins/install', { source: 'owner/repo', sha: SHA1 });
		expect(res.status).toBe(422);
		expect(stagedFolders()).toEqual([]);
	});

	test('a staging folder a crash left behind is removed on the next download', async () => {
		const old = join(pluginsRoot(), '.staging', 'left-behind');
		mkdirSync(old, { recursive: true });
		const hourAgo = new Date(Date.now() - 2 * 3_600_000);
		utimesSync(old, hourAgo, hourAgo);
		serve({ HEAD: SHA1 }, { HEAD: repoTarball(goodFiles()) });
		expect((await call('POST', '/plugins/preview', { source: 'owner/repo' })).status).toBe(200);
		expect(stagedFolders()).toEqual([]);
	});

	test('a download over the size cap is refused while it streams, without trusting content-length', async () => {
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		let cancelled = false;
		const endless = new ReadableStream<Uint8Array>({
			pull(c) {
				sent += chunk.length;
				c.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			}
		});
		setGithubFetch(async (url) => (url.includes('/commits/') ? new Response(SHA1) : new Response(endless)));
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(413);
		expect(((await res.json()) as any).error).toBe('plugin_too_large');
		expect(sent).toBeLessThan(MAX_DOWNLOAD_BYTES + 8 * chunk.length);
		expect(cancelled).toBe(true);
	});

	test('a download that declares too many bytes is refused before reading any', async () => {
		setGithubFetch(async (url) =>
			url.includes('/commits/') ? new Response(SHA1) : new Response('x', { headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } })
		);
		expect((await call('POST', '/plugins/preview', { source: 'owner/repo' })).status).toBe(413);
	});

	test('a download that stalls is given up on with a clear error', async () => {
		setGithubFetch(
			async (url, init) => {
				if (url.includes('/commits/')) return new Response(SHA1);
				// What a real fetch does with the signal: the body fails when it fires.
				const stalled = new ReadableStream<Uint8Array>({
					start(c) {
						init!.signal!.addEventListener('abort', () => c.error(new Error('timed out')));
					}
				});
				return new Response(stalled);
			},
			{ downloadTimeoutMs: 20 }
		);
		const res = await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(res.status).toBe(502);
		expect(((await res.json()) as any).error).toBe('github_unreachable');
	});

	test('every request to GitHub carries a timeout', async () => {
		const signals: unknown[] = [];
		setGithubFetch(async (url, init) => {
			signals.push(init?.signal);
			return url.includes('/commits/') ? new Response(SHA1) : new Response(repoTarball(goodFiles()) as unknown as BodyInit);
		});
		await call('POST', '/plugins/preview', { source: 'owner/repo' });
		expect(signals).toHaveLength(2);
		expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
	});

	test('other writes go ahead while a plugin downloads', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		setGithubFetch(async (url) => {
			if (url.includes('/commits/')) return new Response(SHA1);
			await gate;
			return new Response(repoTarball(goodFiles()) as unknown as BodyInit);
		});
		const pending = call('POST', '/plugins/preview', { source: 'owner/repo' });
		await Bun.sleep(10);
		// Would never settle if the preview held the write queue.
		await serialized(async () => undefined);
		release();
		expect((await pending).status).toBe(200);
	});

	test('an absolute path or a symlink in the archive is refused', async () => {
		serve({ HEAD: SHA1 }, { HEAD: rawTarball([{ name: '/etc/evil', body: 'x' }]) });
		expect((await call('POST', '/plugins/preview', { source: 'owner/repo' })).status).toBe(422);
		serve({ HEAD: SHA1 }, { HEAD: rawTarball([{ name: 'top/link', type: '2', link: '/etc/passwd' }]) });
		expect((await call('POST', '/plugins/preview', { source: 'owner/repo' })).status).toBe(422);
	});

	test('a manifest range excludes a server that is too old', () => {
		expect(isCompatible('>=2.0.0', '2.1.0')).toBe(true);
		expect(isCompatible('>=2.0.0', '2.0.0-rc.13')).toBe(true);
		expect(isCompatible('>=3.0.0', '2.1.0')).toBe(false);
		expect(isCompatible('>=3.0.0', '0.0.0-dev')).toBe(true);
	});
});

async function installSha(sha: string, ref: string, files: Record<string, string>, source = 'owner/repo') {
	serve({ [ref]: sha }, { [ref]: repoTarball(files) });
	return call('POST', '/plugins/install', { source, sha });
}

describe('plugins.install', () => {
	test('install accepts the source as preview returns it, with its ref', async () => {
		serve({ v1: SHA1 }, { v1: repoTarball(goodFiles()) });
		const p = (await (await call('POST', '/plugins/preview', { source: 'owner/repo@v1' })).json()) as any;
		expect(p).toMatchObject({ source: 'github:owner/repo', ref: 'v1', sha: SHA1 });
		const res = await call('POST', '/plugins/install', { source: `${p.source}@${p.ref}`, sha: p.sha });
		expect(res.status).toBe(200);
		expect(db.select().from(plugin).get()).toMatchObject({ source: 'github:owner/repo', ref: 'v1', sha: SHA1 });
	});

	test('install creates the plugin user and a disabled row', async () => {
		const res = await installSha(SHA1, 'HEAD', goodFiles());
		expect(res.status).toBe(200);
		const row = db.select().from(plugin).get()!;
		expect(row).toMatchObject({ key: 'demo', source: 'github:owner/repo', sha: SHA1, enabled: false, previousSha: null });
		const u = db.select().from(user).where(eq(user.id, row.userId)).get()!;
		expect(u).toMatchObject({ username: 'plugin.demo', name: 'Demo', isAdmin: false, isActive: true, passwordHash: null });
		expect(existsSync(join(pluginDir('demo', SHA1), 'dist/plugin.js'))).toBe(true);
	});

	test('a pre-existing human named plugin.<id> is not reused or reactivated', async () => {
		const human = insert(sys(), user, { username: 'plugin.demo', name: 'Pat', email: 'pat@x.local', isActive: false });
		const res = await installSha(SHA1, 'HEAD', goodFiles());
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).error).toBe('plugin_user_taken');
		expect(db.select().from(plugin).all()).toHaveLength(0);
		expect(db.select().from(user).where(eq(user.id, human.id)).get()).toMatchObject({ name: 'Pat', isActive: false });
	});

	test('install refuses a token actor', async () => {
		actor = { kind: 'token', userId: 1, isAdmin: true, tokenId: 1 };
		const res = await installSha(SHA1, 'HEAD', goodFiles());
		expect(res.status).toBe(403);
	});

	test('install refuses a plugin id that another source already owns', async () => {
		await installSha(SHA1, 'HEAD', goodFiles());
		const res = await installSha(SHA2, 'HEAD', goodFiles(), 'other/repo');
		expect(res.status).toBe(409);
		expect(((await res.json()) as any).error).toBe('plugin_source_differs');
	});

	test('update keeps the previous commit folder and removes older ones', async () => {
		await installSha(SHA1, 'HEAD', goodFiles());
		await installSha(SHA2, 'HEAD', goodFiles({ version: '0.2.0' }));
		let row = db.select().from(plugin).get()!;
		expect(row).toMatchObject({ sha: SHA2, previousSha: SHA1, version: '0.2.0' });
		expect(existsSync(pluginDir('demo', SHA1))).toBe(true);
		expect(existsSync(pluginDir('demo', SHA2))).toBe(true);
		await installSha(SHA3, 'HEAD', goodFiles({ version: '0.3.0' }));
		row = db.select().from(plugin).get()!;
		expect(row).toMatchObject({ sha: SHA3, previousSha: SHA2 });
		expect(existsSync(pluginDir('demo', SHA1))).toBe(false);
		expect(existsSync(pluginDir('demo', SHA2))).toBe(true);
		expect(db.select().from(user).all().filter((u) => u.username === 'plugin.demo')).toHaveLength(1);
	});

	test('update drops settings the new manifest no longer has', async () => {
		await installSha(SHA1, 'HEAD', goodFiles({ settings: [{ key: 'url', label: 'URL', type: 'url' }, { key: 'old', label: 'Old', type: 'text' }] }));
		const row = db.select().from(plugin).get()!;
		insert(sys(), pluginSetting, { pluginId: row.id, key: 'url', value: 'http://x', secret: false });
		insert(sys(), pluginSetting, { pluginId: row.id, key: 'old', value: 'v', secret: false });
		await installSha(SHA2, 'HEAD', goodFiles());
		expect(db.select().from(pluginSetting).all().map((s) => s.key)).toEqual(['url']);
	});

	test('an update that makes a setting secret seals the value it has and hides it from the audit log', async () => {
		await installSha(SHA1, 'HEAD', goodFiles({ settings: [{ key: 'token', label: 'Token', type: 'text' }] }));
		const row = db.select().from(plugin).get()!;
		insert(sys(), pluginSetting, { pluginId: row.id, key: 'token', value: 'was-visible', secret: false });
		await installSha(SHA2, 'HEAD', goodFiles({ settings: [{ key: 'token', label: 'Token', type: 'secret' }] }));
		const stored = db.select().from(pluginSetting).get()!;
		expect(stored.secret).toBe(true);
		expect(isSealed(stored.value)).toBe(true);
		expect(settingValues(db, db.select().from(plugin).get()!)).toMatchObject({ token: 'was-visible' });
		expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain('was-visible');
		// The change to the log is on the log, with the admin who updated the plugin.
		const hidden = db.select().from(auditLog).all().filter((r) => r.reason === 'Earlier values hidden: this setting became secret');
		expect(hidden).toHaveLength(1);
		expect(hidden[0]).toMatchObject({ entity: 'plugin_setting', entityId: stored.id, actorUserId: 1, after: { earlierValues: '[redacted]' } });
	});

	test('an update that stops calling a setting secret keeps it sealed and hidden', async () => {
		await installSha(SHA1, 'HEAD', goodFiles({ settings: [{ key: 'token', label: 'Token', type: 'secret' }] }));
		let row = db.select().from(plugin).get()!;
		saveSettings(sys(), row, { token: 'still-secret' });
		await installSha(SHA2, 'HEAD', goodFiles({ settings: [{ key: 'token', label: 'Token', type: 'text' }] }));
		row = db.select().from(plugin).get()!;
		expect(isSealed(db.select().from(pluginSetting).get()!.value)).toBe(true);
		expect(settingValues(db, row)).toMatchObject({ token: 'still-secret' });
		expect(toDetail(db, row).settings[0]!.value).toBeNull();
		saveSettings(sys(), row, { token: 'changed' });
		expect(db.select().from(pluginSetting).get()!.secret).toBe(true);
		expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain('changed');
	});

	test('a local source is refused without OPAL_PLUGINS_LOCAL', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'opal-local-'));
		const res = await call('POST', '/plugins/preview', { source: `local:${dir}` });
		expect(res.status).toBe(422);
	});

	test('a local source runs in place with the SHA local', async () => {
		process.env.OPAL_PLUGINS_LOCAL = '1';
		const dir = mkdtempSync(join(tmpdir(), 'opal-local-'));
		mkdirSync(join(dir, 'dist'));
		writeFileSync(join(dir, 'opal-plugin.json'), JSON.stringify(manifest()));
		writeFileSync(join(dir, 'dist/plugin.js'), '1');
		const p = (await (await call('POST', '/plugins/preview', { source: `local:${dir}` })).json()) as any;
		expect(p).toMatchObject({ sha: 'local', source: `local:${dir}` });
		const res = await call('POST', '/plugins/install', { source: `local:${dir}`, sha: 'local' });
		expect(res.status).toBe(200);
		expect(db.select().from(plugin).get()).toMatchObject({ sha: 'local', source: `local:${dir}` });
		expect(existsSync(pluginDir('demo', 'local'))).toBe(false);
	});

	test('installing a local plugin again reads its changed manifest', async () => {
		process.env.OPAL_PLUGINS_LOCAL = '1';
		const dir = mkdtempSync(join(tmpdir(), 'opal-local-'));
		mkdirSync(join(dir, 'dist'));
		writeFileSync(join(dir, 'opal-plugin.json'), JSON.stringify(manifest()));
		writeFileSync(join(dir, 'dist/plugin.js'), '1');
		await call('POST', '/plugins/install', { source: `local:${dir}`, sha: 'local' });
		writeFileSync(join(dir, 'opal-plugin.json'), JSON.stringify({ ...manifest(), version: '9.9.9' }));
		const res = await call('POST', '/plugins/install', { source: `local:${dir}`, sha: 'local' });
		expect(res.status).toBe(200);
		expect(db.select().from(plugin).get()).toMatchObject({ version: '9.9.9', sha: 'local', previousSha: null });
	});
});

describe('plugins.remove', () => {
	test('remove deletes files, settings and links, revokes tokens and deactivates the user', async () => {
		await installSha(SHA1, 'HEAD', goodFiles());
		const row = db.select().from(plugin).get()!;
		insert(sys(), pluginSetting, { pluginId: row.id, key: 'url', value: 'x', secret: false });
		insert(sys(), externalLink, { pluginId: row.id, entityType: 'issue', entityId: 1, externalId: 'K-1', url: 'http://k/1' });
		insert(sys(), apiToken, { userId: row.userId, name: 'plugin', tokenHash: 'h1', scopes: { ops: [], events: [] } });
		const res = await call('DELETE', '/plugins/demo');
		expect(res.status).toBe(200);
		expect(db.select().from(plugin).all()).toHaveLength(0);
		expect(db.select().from(pluginSetting).all()).toHaveLength(0);
		expect(db.select().from(externalLink).all()).toHaveLength(0);
		expect(db.select().from(apiToken).get()!.revokedAt).not.toBeNull();
		expect(db.select().from(user).where(eq(user.id, row.userId)).get()!.isActive).toBe(false);
		expect(existsSync(join(pluginsRoot(), 'demo'))).toBe(false);
	});

	test('remove of an unknown plugin answers 404', async () => {
		expect((await call('DELETE', '/plugins/nope')).status).toBe(404);
	});

	test('a plugin installed again after removal reuses its deactivated user', async () => {
		await installSha(SHA1, 'HEAD', goodFiles());
		await call('DELETE', '/plugins/demo');
		await installSha(SHA1, 'HEAD', goodFiles());
		const u = db.select().from(user).all().filter((x) => x.username === 'plugin.demo');
		expect(u).toHaveLength(1);
		expect(u[0]!.isActive).toBe(true);
	});
});
