import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Actor, Ctx } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import { apiToken, externalLink, plugin, pluginSetting, user } from '../../src/db/schema/index.ts';
import { pluginsInstallImpls } from '../../src/ops/plugins-install.ts';
import { errorResponse, mountOps } from '../../src/registry.ts';
import { isCompatible } from '../../src/services/plugins/install.ts';
import { parseSource, setGithubFetch } from '../../src/services/plugins/github.ts';
import { pluginDir, pluginsRoot } from '../../src/services/plugins/store.ts';
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
afterEach(() => setGithubFetch());

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
		expect(existsSync(join(pluginsRoot(), '.staging', SHA1))).toBe(false);
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
	test('install creates the plugin user and a disabled row', async () => {
		const res = await installSha(SHA1, 'HEAD', goodFiles());
		expect(res.status).toBe(200);
		const row = db.select().from(plugin).get()!;
		expect(row).toMatchObject({ key: 'demo', source: 'github:owner/repo', sha: SHA1, enabled: false, previousSha: null });
		const u = db.select().from(user).where(eq(user.id, row.userId)).get()!;
		expect(u).toMatchObject({ username: 'plugin.demo', name: 'Demo', isAdmin: false, isActive: true, passwordHash: null });
		expect(existsSync(join(pluginDir('demo', SHA1), 'dist/plugin.js'))).toBe(true);
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
