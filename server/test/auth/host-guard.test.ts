import { afterEach, describe, expect, test } from 'bun:test';
import { harness } from './helpers.ts';

afterEach(() => {
	delete process.env.OPAL_PUBLIC_URL;
	delete process.env.OPAL_ALLOWED_HOSTS;
	delete process.env.OPAL_TRUST_PROXY;
});

const status = (h: Awaited<ReturnType<typeof harness>>, host: string, path = '/api/auth/me', headers: Record<string, string> = {}) =>
	h.app.request(`http://opal.test${path}`, { headers: { host, ...headers } });

describe('host allowlist', () => {
	test('with nothing configured every host name is served, so LAN instances work by any address', async () => {
		const h = await harness();
		for (const host of ['192.168.1.20:8080', 'opal.lan', 'anything.example']) {
			expect((await status(h, host)).status).not.toBe(421);
		}
	});

	test('with OPAL_ALLOWED_HOSTS set, a request for another host name is refused', async () => {
		process.env.OPAL_ALLOWED_HOSTS = 'opal.lan, 192.168.1.20:8080';
		const h = await harness();
		expect((await status(h, 'evil.example')).status).toBe(421);
		expect((await status(h, 'evil.example:8080')).status).toBe(421);
		expect((await status(h, 'opal.lan:8080')).status).not.toBe(421);
		expect((await status(h, 'OPAL.LAN')).status).not.toBe(421);
		expect((await status(h, '192.168.1.20:8080')).status).not.toBe(421);
		// A listed address with a port is that port only.
		expect((await status(h, '192.168.1.20:9999')).status).toBe(421);
	});

	test('localhost and the loopback addresses are always served once a list is set', async () => {
		process.env.OPAL_ALLOWED_HOSTS = 'opal.lan';
		const h = await harness();
		for (const host of ['localhost:8080', '127.0.0.1:8080', '127.0.0.2', '[::1]:8080']) {
			expect((await status(h, host)).status).not.toBe(421);
		}
	});

	test('OPAL_PUBLIC_URL puts its host on the list', async () => {
		process.env.OPAL_PUBLIC_URL = 'https://opal.example.com';
		const h = await harness();
		expect((await status(h, 'opal.example.com')).status).not.toBe(421);
		expect((await status(h, 'evil.example')).status).toBe(421);
	});

	test('an unlisted host cannot claim a fresh instance', async () => {
		process.env.OPAL_ALLOWED_HOSTS = 'opal.lan';
		const h = await harness();
		const res = await h.app.request('http://evil.example/api/auth/setup', {
			method: 'POST',
			headers: { host: 'evil.example', origin: 'http://evil.example', 'content-type': 'application/json' },
			body: JSON.stringify({ username: 'attacker', name: 'A', password: 'attacker-pass-1' })
		});
		expect(res.status).toBe(421);
		expect((await (await status(h, 'opal.lan', '/api/auth/config')).json()).needsSetup).toBe(true);
	});

	test('an unlisted host is not reflected in the OAuth metadata or the MCP challenge', async () => {
		process.env.OPAL_ALLOWED_HOSTS = 'opal.lan';
		const h = await harness();
		const meta = await status(h, 'evil.example', '/.well-known/oauth-authorization-server');
		expect(meta.status).toBe(421);
		expect(await meta.text()).not.toContain('evil.example');
		const mcp = await h.app.request('http://opal.test/mcp', { method: 'POST', headers: { host: 'evil.example' } });
		expect(mcp.status).toBe(421);
		expect(mcp.headers.get('www-authenticate')).toBeNull();
		const ok = await status(h, 'opal.lan', '/.well-known/oauth-authorization-server');
		expect((await ok.json()).issuer).toBe('http://opal.lan');
	});

	test('behind a trusted proxy an unlisted forwarded host is refused too', async () => {
		process.env.OPAL_ALLOWED_HOSTS = 'opal.lan';
		process.env.OPAL_TRUST_PROXY = '1';
		const h = await harness();
		expect((await status(h, '127.0.0.1:8080', '/api/auth/me', { 'x-forwarded-host': 'evil.example' })).status).toBe(421);
		// The proxy reaches the backend by its own address; the forwarded host is what counts.
		expect((await status(h, '10.0.0.5:8080', '/api/auth/me', { 'x-forwarded-host': 'opal.lan' })).status).not.toBe(421);
		// Without a forwarded host the Host header counts.
		expect((await status(h, '10.0.0.5:8080')).status).toBe(421);
	});
});
