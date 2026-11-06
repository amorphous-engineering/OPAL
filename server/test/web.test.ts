import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { securityHeaders } from '../src/http/headers.ts';
import { mountWeb } from '../src/http/web.ts';

const INLINE = 'window.boot = 1;';
let dir: string;
let app: Hono;
const get = (path: string, init?: RequestInit) => app.request(path, init);

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'opal-web-'));
	mkdirSync(join(dir, '_app/immutable'), { recursive: true });
	writeFileSync(join(dir, 'index.html'), `<!doctype html><title>shell</title><script src="/_app/x.js"></script><script>${INLINE}</script>`);
	writeFileSync(join(dir, 'robots.txt'), 'User-agent: *');
	writeFileSync(join(dir, '_app/immutable/app.abc.js'), 'export {};');
	writeFileSync(join(dir, '..secret.txt'), 'outside');
	app = new Hono();
	app.use('*', securityHeaders);
	app.get('/api/health', (c) => c.json({ ok: true }));
	mountWeb(app, dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('web client', () => {
	test('a real file is served as is with its content type', async () => {
		const res = await get('/robots.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		expect(await res.text()).toBe('User-agent: *');
	});

	test('an extension-less path gets index.html so client routes work', async () => {
		for (const path of ['/', '/parts/12', '/executions/3/steps']) {
			const res = await get(path);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toContain('text/html');
			expect(await res.text()).toContain('<title>shell</title>');
		}
	});

	test('a missing file with an extension is 404, not the app shell', async () => {
		expect((await get('/x.js')).status).toBe(404);
		expect((await get('/_app/immutable/gone.js')).status).toBe(404);
	});

	test('nothing under /api or /mcp is served as the client', async () => {
		for (const path of ['/api/nothing', '/api', '/mcp', '/mcp/x']) {
			const res = await get(path);
			expect(res.status).toBe(404);
			expect(res.headers.get('content-type')).toContain('application/json');
		}
		expect(await (await get('/api/health')).json()).toEqual({ ok: true });
	});

	test('hashed assets cache for a year and index.html is never cached', async () => {
		const asset = await get('/_app/immutable/app.abc.js');
		expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect((await get('/')).headers.get('cache-control')).toBe('no-cache');
		expect((await get('/index.html')).headers.get('cache-control')).toBe('no-cache');
		expect((await get('/robots.txt')).headers.get('cache-control')).toBe('no-cache');
	});

	test('a path cannot climb out of the client folder', async () => {
		for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%5c..%5cx']) {
			const res = await get(path);
			expect(res.status).toBe(404);
		}
	});

	test('a directory path serves the app shell', async () => {
		const res = await get('/_app');
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('shell');
	});

	test('POST is not handled by the client', async () => {
		expect((await get('/parts/12', { method: 'POST' })).status).toBe(404);
	});

	test('a folder without index.html answers 503', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'opal-web-empty-'));
		const bare = new Hono();
		mountWeb(bare, empty);
		expect((await bare.request('/parts')).status).toBe(503);
		rmSync(empty, { recursive: true });
	});
});


describe('page security headers', () => {
	const hash = `'sha256-${createHash('sha256').update(INLINE).digest('base64')}'`;

	test('a page cannot be framed, sniffed, or script from anywhere but itself and its own inline bootstrap', async () => {
		const res = await get('/parts/12');
		const csp = res.headers.get('content-security-policy') ?? '';
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).toContain("img-src 'self' data:");
		expect(csp).toContain(`script-src 'self' ${hash}`);
		expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
		expect(res.headers.get('x-frame-options')).toBe('DENY');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('referrer-policy')).toBe('same-origin');
	});

	test('a changed bootstrap script gets its own hash, so a rebuilt client still runs', async () => {
		const other = mkdtempSync(join(tmpdir(), 'opal-web-csp-'));
		writeFileSync(join(other, 'index.html'), '<script>a()</script>');
		const a = new Hono();
		mountWeb(a, other);
		const first = (await a.request('/')).headers.get('content-security-policy');
		await Bun.sleep(5);
		writeFileSync(join(other, 'index.html'), '<script>bb()</script>');
		const second = (await a.request('/')).headers.get('content-security-policy');
		expect(second).not.toBe(first);
		expect(second).toContain(createHash('sha256').update('bb()').digest('base64'));
		rmSync(other, { recursive: true });
	});

	test('API replies are nosniff, unframeable and never cached', async () => {
		const res = await get('/api/health');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('x-frame-options')).toBe('DENY');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
	});

	test('a reply that sets its own policy keeps it', async () => {
		const own = new Hono();
		own.use('*', securityHeaders);
		own.get('/f', (c) => c.body('x', 200, { 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=60' }));
		const res = await own.request('/f');
		expect(res.headers.get('content-security-policy')).toBe('sandbox');
		expect(res.headers.get('cache-control')).toBe('private, max-age=60');
	});

	test('HSTS is sent over https only', async () => {
		expect((await get('/api/health')).headers.get('strict-transport-security')).toBeNull();
		const res = await get('https://opal.example/api/health');
		expect(res.headers.get('strict-transport-security')).toContain('max-age=');
	});
});
