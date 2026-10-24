import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWeb } from '../src/http/web.ts';

let dir: string;
let app: Hono;
const get = (path: string, init?: RequestInit) => app.request(path, init);

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'opal-web-'));
	mkdirSync(join(dir, '_app/immutable'), { recursive: true });
	writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>');
	writeFileSync(join(dir, 'robots.txt'), 'User-agent: *');
	writeFileSync(join(dir, '_app/immutable/app.abc.js'), 'export {};');
	writeFileSync(join(dir, '..secret.txt'), 'outside');
	app = new Hono();
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
