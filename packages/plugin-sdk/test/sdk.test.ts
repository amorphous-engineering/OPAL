import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { definePlugin, escapeHtml, html, makeTransport, OpalApiError, panelPage, raw, SseParser, verifyHmac, userOf } from '../src/index.ts';
import { Hono } from 'hono';

describe('transport', () => {
	test('adds the bearer header and the /api prefix', async () => {
		let seen: { url: string; auth: string | null; body: string } | undefined;
		const f = (async (url: string, init: RequestInit) => {
			seen = { url, auth: new Headers(init.headers).get('authorization'), body: String(init.body) };
			return Response.json({ ok: true });
		}) as unknown as typeof fetch;
		const out = await makeTransport('http://x:1', 'opal_t', f)({ method: 'POST', url: '/a', body: { n: 1 } });
		expect(out).toEqual({ ok: true });
		expect(seen).toEqual({ url: 'http://x:1/api/a', auth: 'Bearer opal_t', body: '{"n":1}' });
	});

	test('maps an API error body to status, code and message', async () => {
		const f = (async () => Response.json({ error: 'out_of_scope', message: 'No' }, { status: 403 })) as unknown as typeof fetch;
		const err = (await makeTransport('http://x', 't', f)({ method: 'GET', url: '/a' }).catch((e: unknown) => e)) as OpalApiError;
		expect(err).toBeInstanceOf(OpalApiError);
		expect([err.status, err.code, err.message]).toEqual([403, 'out_of_scope', '403 out_of_scope: No']);
	});
});

describe('SseParser', () => {
	test('joins an event split across chunks', () => {
		const p = new SseParser();
		expect(p.push('data: {"a"')).toEqual([]);
		expect(p.push(':1}\n')).toEqual([]);
		expect(p.push('\ndata: 2\n\n')).toEqual(['{"a":1}', '2']);
	});
	test('joins multi-line data, skips comments, handles CRLF', () => {
		const p = new SseParser();
		expect(p.push(': ping\r\ndata: one\r\ndata: two\r\n\r\n')).toEqual(['one\ntwo']);
	});
	test('waits when a chunk ends between CR and LF', () => {
		const p = new SseParser();
		expect(p.push('data: x\r')).toEqual([]);
		expect(p.push('\n\r\n')).toEqual(['x']);
	});
});

describe('verifyHmac', () => {
	const sig = createHmac('sha256', 's3').update('body').digest('hex');
	test('accepts hex with and without prefix', () => {
		expect(verifyHmac('s3', 'body', sig)).toBe(true);
		expect(verifyHmac('s3', 'body', `sha256=${sig}`)).toBe(true);
	});
	test('refuses a wrong secret, body, length or empty value', () => {
		expect(verifyHmac('x', 'body', sig)).toBe(false);
		expect(verifyHmac('s3', 'bod', sig)).toBe(false);
		expect(verifyHmac('s3', 'body', sig.slice(2))).toBe(false);
		expect(verifyHmac('s3', 'body', 'zz')).toBe(false);
		expect(verifyHmac('s3', 'body', null)).toBe(false);
	});
	test('supports another algorithm', () => {
		const s = createHmac('sha1', 'k').update('b').digest('hex');
		expect(verifyHmac('k', 'b', `sha1=${s}`, 'sha1')).toBe(true);
	});
});

describe('html', () => {
	test('escapes interpolations, not nested html', () => {
		const name = '<script>"&\'';
		expect(String(html`<b>${name}</b>`)).toBe('<b>&lt;script&gt;&quot;&amp;&#39;</b>');
		expect(String(html`<ul>${[1, 2].map((n) => html`<li>${n}</li>`)}</ul>`)).toBe('<ul><li>1</li><li>2</li></ul>');
		expect(String(html`${raw('<i>')}`)).toBe('<i>');
		expect(escapeHtml(5)).toBe('5');
	});
});

describe('panelPage', () => {
	test('builds a document with theme, height message and opal.fetch', () => {
		const d = panelPage({ title: 'A <b>', body: html`<p>x</p>`, theme: 'dark', pluginId: 'kaneo' });
		expect(d).toContain('<title>A &lt;b&gt;</title>');
		expect(d).toContain('data-theme="dark"');
		expect(d).toContain('opal-panel-height');
		expect(d).toContain('X-Opal-Panel');
		expect(d).toContain('var id="kaneo";');
		expect(panelPage({ title: 't', body: '', theme: 'x', pluginId: 'a' })).toContain('data-theme="light"');
	});
});

describe('userOf', () => {
	test('parses X-Opal-User and returns null when absent or broken', async () => {
		const app = new Hono();
		app.get('/', (c) => c.json(userOf(c)));
		const get = async (h?: string) => (await app.request('/', { headers: h ? { 'X-Opal-User': h } : {} })).json();
		expect(await get('{"id":1,"name":"A","username":"a"}')).toEqual({ id: 1, name: 'A', username: 'a' });
		expect(await get()).toBeNull();
		expect(await get('{')).toBeNull();
	});
});

describe('definePlugin', () => {
	let fake: ReturnType<typeof Bun.serve> | undefined;
	let plugin: ReturnType<typeof definePlugin> | undefined;
	afterEach(async () => {
		await plugin?.stop();
		fake?.stop(true);
		plugin = fake = undefined;
	});

	const envFor = (url: string) => ({
		OPAL_URL: url,
		OPAL_TOKEN: 'opal_tok',
		OPAL_PLUGIN_ID: 'demo',
		OPAL_PLUGIN_PORT: '0',
		OPAL_PLUGIN_DATA: '/tmp/demo',
		OPAL_SETTINGS: '{"k":"v"}'
	});

	test('names the missing variable', () => {
		expect(() => definePlugin({}, { env: {}, signals: false })).toThrow('OPAL_PLUGIN_ID');
	});

	test('gets an event, runs reconcile on connect, serves health and routes', async () => {
		const auths: (string | null)[] = [];
		const enc = new TextEncoder();
		fake = Bun.serve({
			port: 0,
			fetch(req) {
				const u = new URL(req.url);
				auths.push(req.headers.get('authorization'));
				if (u.pathname === '/api/auth/me') return Response.json({ user: { id: 1 } });
				if (u.pathname === '/api/events/stream') {
					return new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(enc.encode('data: {"type":"heartbeat","data":{},"timestamp":"t"}\n\n'));
								c.enqueue(enc.encode('data: {"type":"record_changed","da'));
								setTimeout(() => c.enqueue(enc.encode('ta":{"id":7},"timestamp":"t"}\n\n')), 20);
							}
						}),
						{ headers: { 'Content-Type': 'text/event-stream' } }
					);
				}
				return new Response('no', { status: 404 });
			}
		});
		const got: unknown[] = [];
		let reconciled = 0;
		let resolveBoth!: () => void;
		const both = new Promise<void>((r) => (resolveBoth = r));
		const check = () => got.length && reconciled && resolveBoth();
		plugin = definePlugin(
			{
				events: {
					record_changed: (e) => {
						got.push(e.data);
						check();
					},
					boom: () => {
						throw new Error('x');
					}
				},
				reconcile: {
					everyMinutes: 60,
					run: async () => {
						reconciled++;
						check();
					}
				},
				routes: (app, ctx) => app.get('/who', (c) => c.json({ id: ctx.id, k: ctx.settings.k }))
			},
			{ env: envFor(`http://127.0.0.1:${fake.port}`), signals: false }
		);
		await Promise.race([both, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
		expect(got).toEqual([{ id: 7 }]);
		expect(reconciled).toBe(1);
		expect(auths).toContain('Bearer opal_tok');

		const base = `http://127.0.0.1:${plugin.port}`;
		const h = await fetch(`${base}/__health`);
		expect([h.status, await h.text()]).toEqual([200, 'ok']);
		expect(await (await fetch(`${base}/who`)).json()).toEqual({ id: 'demo', k: 'v' });

		const me = await plugin.ctx.api.auth.me({});
		expect(me).toEqual({ user: { id: 1 } } as never);
	});
});

describe('bundle', () => {
	test('bun build puts a sample plugin, hono and shared into one file', async () => {
		const out = `${process.env.TMPDIR ?? '/tmp'}/opal-sdk-bundle-${Date.now()}`;
		const p = Bun.spawnSync(['bun', 'build', 'test/sample/plugin.ts', '--target=bun', '--outfile', `${out}/plugin.js`], { cwd: `${import.meta.dir}/..` });
		expect(p.exitCode).toBe(0);
		const text = await Bun.file(`${out}/plugin.js`).text();
		expect(text).not.toContain('from "hono"');
		expect(text).not.toContain('from "zod"');
	});
});
