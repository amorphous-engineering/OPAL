import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { ADMIN, beginOidc, configureOidc, fakeProvider, harness } from './helpers.ts';

const provider = await fakeProvider();
afterAll(() => provider.stop());
afterEach(() => {
	delete process.env.OPAL_TRUST_PROXY;
	delete process.env.OPAL_PUBLIC_URL;
});

const setup = (h: Awaited<ReturnType<typeof harness>>, headers: Record<string, string> = {}) =>
	h.call('POST', '/auth/setup', ADMIN, { host: 'demo.example', ...headers });
const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith('opal_session='))!;

describe('cookie Secure flag', () => {
	test('over plain HTTP with no proxy or public URL the session cookie is not Secure, so LAN sign-in works', async () => {
		const res = await setup(await harness());
		expect(sessionCookie(res)).not.toMatch(/;\s*Secure/i);
	});

	test('a forwarded https scheme from an untrusted client does not make the cookie Secure', async () => {
		const res = await setup(await harness(), { 'x-forwarded-proto': 'https' });
		expect(sessionCookie(res)).not.toMatch(/;\s*Secure/i);
	});

	test('behind a trusted TLS proxy the session cookie is Secure', async () => {
		process.env.OPAL_TRUST_PROXY = '1';
		const res = await setup(await harness(), { 'x-forwarded-proto': 'https' });
		expect(sessionCookie(res)).toMatch(/;\s*Secure/i);
	});

	test('with an https OPAL_PUBLIC_URL the session cookie is Secure whatever the request scheme', async () => {
		process.env.OPAL_PUBLIC_URL = 'https://demo.example';
		const res = await setup(await harness());
		expect(sessionCookie(res)).toMatch(/;\s*Secure/i);
	});

	test('the sliding session renewal keeps the Secure flag', async () => {
		process.env.OPAL_PUBLIC_URL = 'https://demo.example';
		const h = await harness();
		const cookie = sessionCookie(await setup(h)).split(';')[0]!;
		// Age the session so the next request renews it.
		const { session } = await import('../../src/db/schema/index.ts');
		h.db.update(session).set({ lastSeenAt: '2020-01-01T00:00:00.000Z' }).run();
		const res = await h.call('GET', '/auth/me', undefined, { cookie, host: 'demo.example' });
		expect(res.status).toBe(200);
		expect(sessionCookie(res)).toMatch(/;\s*Secure/i);
	});

	test('the passkey state cookie follows the same answer', async () => {
		process.env.OPAL_TRUST_PROXY = '1';
		const h = await harness();
		const res = await h.call('POST', '/auth/passkeys/login/begin', { rpId: 'opal.test' }, { 'x-forwarded-proto': 'https' });
		const state = res.headers.getSetCookie().find((c) => c.startsWith('opal_webauthn_state='))!;
		expect(state).toMatch(/;\s*Secure/i);
		const plain = await (await harness()).call('POST', '/auth/passkeys/login/begin', { rpId: 'opal.test' });
		expect(plain.headers.getSetCookie().find((c) => c.startsWith('opal_webauthn_state='))!).not.toMatch(/;\s*Secure/i);
	});

	test('the single sign-on state cookie follows the same answer', async () => {
		const h = await harness();
		configureOidc(h, provider);
		expect((await beginOidc(h)).res.headers.getSetCookie()[0]!).not.toMatch(/;\s*Secure/i);
		process.env.OPAL_PUBLIC_URL = 'https://demo.example';
		const secure = await h.raw('/oidc/login', { host: 'demo.example' });
		expect(secure.headers.getSetCookie()[0]!).toMatch(/;\s*Secure/i);
	});

	test('signing out clears the cookie with the same Secure flag', async () => {
		process.env.OPAL_PUBLIC_URL = 'https://demo.example';
		const h = await harness();
		const cookie = sessionCookie(await setup(h)).split(';')[0]!;
		const res = await h.call('POST', '/auth/logout', undefined, { cookie, host: 'demo.example' });
		expect(sessionCookie(res)).toMatch(/;\s*Secure/i);
	});
});
