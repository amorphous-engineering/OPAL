import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { signPayload } from '../../src/auth/signing.ts';
import { user } from '../../src/db/schema/index.ts';
import { eq } from 'drizzle-orm';
import { addPlugin, restoreRuntime, setup, stubRuntime } from './helpers.ts';

let upstream: ReturnType<typeof Bun.serve>;
beforeAll(() => {
	// Echoes what it received, so the tests can see what the proxy forwarded.
	upstream = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: '/x' } });
			return Response.json(
				{ method: req.method, path: url.pathname, query: url.search, body: await req.text(), headers: Object.fromEntries(req.headers) },
				{ status: 201, headers: { 'x-from-plugin': 'yes', 'set-cookie': 'a=b' } }
			);
		}
	});
});
afterAll(() => upstream.stop(true));
afterEach(restoreRuntime);

describe('plugin proxy', () => {
	test('a signed-in request reaches the plugin without cookie or authorization and with X-Opal-User', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		stubRuntime({ kaneo: upstream.port! });
		const res = await s.app.request('/plugins/kaneo/panel/issue?issue=4', {
			method: 'POST',
			headers: { cookie: 'opal_session=secret', authorization: 'Bearer x', 'x-custom': '1' },
			body: 'hello'
		});
		expect(res.status).toBe(201);
		expect(res.headers.get('x-from-plugin')).toBe('yes');
		expect(res.headers.get('set-cookie')).toBeNull();
		const seen = await res.json();
		expect(seen).toMatchObject({ method: 'POST', path: '/panel/issue', body: 'hello' });
		expect(seen.query).toBe('?issue=4');
		expect(seen.headers.cookie).toBeUndefined();
		expect(seen.headers.authorization).toBeUndefined();
		expect(seen.headers['x-custom']).toBe('1');
		expect(JSON.parse(seen.headers['x-opal-user'])).toEqual({ id: s.person.id, name: 'Ann', username: 'ann' });
	});

	test('an anonymous request is 401', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		stubRuntime({ kaneo: upstream.port! });
		s.setActor({ kind: 'anonymous' });
		expect((await s.app.request('/plugins/kaneo/x')).status).toBe(401);
	});

	test('a valid panel token works, as query or header, and a bad or foreign one is 401', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		addPlugin(s.db, 'other');
		stubRuntime({ kaneo: upstream.port!, other: upstream.port! });
		s.setActor({ kind: 'anonymous' });
		const pt = signPayload({ k: 'panel', u: s.person.id, p: 'kaneo' });
		const viaQuery = await s.app.request(`/plugins/kaneo/p?pt=${pt}&a=1`);
		expect(viaQuery.status).toBe(201);
		expect((await viaQuery.json()).query).toBe('?a=1');
		const viaHeader = await s.app.request('/plugins/kaneo/p', { headers: { 'x-opal-panel': pt } });
		expect(viaHeader.status).toBe(201);
		expect((await s.app.request('/plugins/kaneo/p?pt=garbage')).status).toBe(401);
		expect((await s.app.request('/plugins/other/p', { headers: { 'x-opal-panel': pt } })).status).toBe(401);
		const wrongKind = signPayload({ k: 'claim', u: s.person.id, p: 'kaneo' });
		expect((await s.app.request('/plugins/kaneo/p', { headers: { 'x-opal-panel': wrongKind } })).status).toBe(401);
		const expired = signPayload({ k: 'panel', u: s.person.id, p: 'kaneo' }, -1000);
		expect((await s.app.request('/plugins/kaneo/p', { headers: { 'x-opal-panel': expired } })).status).toBe(401);
	});

	test('a panel token stops working when its user is deactivated', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		stubRuntime({ kaneo: upstream.port! });
		s.setActor({ kind: 'anonymous' });
		const pt = signPayload({ k: 'panel', u: s.person.id, p: 'kaneo' });
		s.db.update(user).set({ isActive: false }).where(eq(user.id, s.person.id)).run();
		expect((await s.app.request('/plugins/kaneo/p', { headers: { 'x-opal-panel': pt } })).status).toBe(401);
	});

	test('a sandboxed panel (Origin: null) may POST with its panel token, and not without it', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		stubRuntime({ kaneo: upstream.port! });
		s.setActor({ kind: 'anonymous' });
		const pt = signPayload({ k: 'panel', u: s.person.id, p: 'kaneo' });
		const ok = await s.app.request('/plugins/kaneo/do', { method: 'POST', headers: { origin: 'null', 'x-opal-panel': pt }, body: '{}' });
		expect(ok.status).toBe(201);
		const cross = await s.app.request(`/plugins/kaneo/do?pt=${pt}`, { method: 'POST', headers: { origin: 'null' }, body: '{}' });
		expect(cross.status).toBe(403);
	});

	test('an unknown or disabled plugin is 404', async () => {
		const s = await setup();
		addPlugin(s.db, 'off', {}, false);
		stubRuntime({ off: upstream.port! });
		expect((await s.app.request('/plugins/nope/x')).status).toBe(404);
		expect((await s.app.request('/plugins/off/x')).status).toBe(404);
		expect((await s.app.request('/hooks/off/x', { method: 'POST' })).status).toBe(404);
	});

	test('a plugin that is not running is 503 plugin_not_running', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo', { permissions: { ops: [], events: [], hooks: true } });
		const res = await s.app.request('/plugins/kaneo/x');
		expect(res.status).toBe(503);
		expect((await res.json()).error).toBe('plugin_not_running');
		expect((await s.app.request('/hooks/kaneo/x', { method: 'POST' })).status).toBe(503);
	});

	test('a plugin that refuses connections is 502', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		const dead = Bun.serve({ port: 0, fetch: () => new Response('') });
		const port = dead.port!;
		dead.stop(true);
		stubRuntime({ kaneo: port });
		expect((await s.app.request('/plugins/kaneo/x')).status).toBe(502);
	});

	test('hooks need no sign-in, reach /hooks/<rest> without X-Opal-User, and need permissions.hooks', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo', { permissions: { ops: [], events: [], hooks: true } });
		addPlugin(s.db, 'quiet');
		stubRuntime({ kaneo: upstream.port!, quiet: upstream.port! });
		s.setActor({ kind: 'anonymous' });
		const res = await s.app.request('/hooks/kaneo/task?x=1', {
			method: 'POST',
			headers: { origin: 'https://kaneo.example', cookie: 'c=1' },
			body: '{"a":1}'
		});
		expect(res.status).toBe(201);
		const seen = await res.json();
		expect(seen).toMatchObject({ path: '/hooks/task', query: '?x=1', body: '{"a":1}' });
		expect(seen.headers['x-opal-user']).toBeUndefined();
		expect(seen.headers.cookie).toBeUndefined();
		expect((await s.app.request('/hooks/quiet/task', { method: 'POST' })).status).toBe(404);
	});

	test('an upstream redirect passes through and proxied pages are sandboxed', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo');
		stubRuntime({ kaneo: upstream.port! });
		const res = await s.app.request('/plugins/kaneo/redirect');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/x');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
	});

	test('plugins.panels lists running plugins with a panel in the slot, with a working panel token', async () => {
		const s = await setup();
		addPlugin(s.db, 'kaneo', { panels: [{ slot: 'issue.side', title: 'Kaneo', path: '/panel/issue' }] });
		addPlugin(s.db, 'idle', { panels: [{ slot: 'issue.side', title: 'Idle', path: '/p' }] });
		addPlugin(s.db, 'parts', { panels: [{ slot: 'part.side', title: 'Parts', path: '/p' }] });
		stubRuntime({ kaneo: upstream.port!, parts: upstream.port! });
		const res = await s.app.request('/api/plugin-panels?slot=issue.side');
		expect(res.status).toBe(200);
		const { items } = await res.json();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ plugin: 'kaneo', title: 'Kaneo' });
		expect(items[0].src).toMatch(/^\/plugins\/kaneo\/panel\/issue\?pt=/);
		s.setActor({ kind: 'anonymous' });
		expect((await s.app.request(items[0].src)).status).toBe(201);
	});
});
