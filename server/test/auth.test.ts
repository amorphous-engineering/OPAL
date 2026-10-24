import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app.ts';
import { verifyPassword } from '../src/auth/tokens.ts';
import { openDb } from '../src/db/client.ts';
import { apiToken, auditLog, session } from '../src/db/schema/index.ts';

// Made by legacy argon2-cffi: PasswordHasher().hash('kestrel-demo')
const LEGACY_HASH =
	'$argon2id$v=19$m=65536,t=3,p=4$Sdr4tVHrgUDg3Br7dD2JnQ$mzDKM7CiK0RPp+ASgrMDciuY7g5gtUoElGQTbY0Xr0Y';

const ADMIN = { username: 'Abby', name: 'Abby', password: 'correct-horse-battery' };

function setup() {
	const db = openDb(':memory:');
	const app = createApp({ db });
	const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
		app.request(`http://opal.test/api${path}`, {
			method,
			headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
			body: body ? JSON.stringify(body) : undefined
		});
	return { db, call };
}

function cookieOf(res: Response): string {
	const raw = res.headers.get('set-cookie') ?? '';
	return raw.split(';')[0]!;
}

async function signedIn() {
	const s = setup();
	const res = await s.call('POST', '/auth/setup', ADMIN);
	return { ...s, cookie: cookieOf(res), res };
}

describe('auth', () => {
	test('setup only works once', async () => {
		const { call } = setup();
		expect((await (await call('GET', '/auth/config')).json()).needsSetup).toBe(true);
		const first = await call('POST', '/auth/setup', ADMIN);
		expect(first.status).toBe(200);
		expect((await first.json()).user.isAdmin).toBe(true);
		const second = await call('POST', '/auth/setup', { ...ADMIN, username: 'other' });
		expect(second.status).toBe(409);
		expect((await (await call('GET', '/auth/config')).json()).needsSetup).toBe(false);
	});

	test('login sets an HttpOnly cookie and auth.me works with it', async () => {
		const { call, res } = await signedIn();
		const setCookie = res.headers.get('set-cookie')!;
		expect(setCookie).toContain('opal_session=');
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('SameSite=Lax');
		const login = await call('POST', '/auth/login', { username: 'abby', password: ADMIN.password });
		expect(login.status).toBe(200);
		const me = await call('GET', '/auth/me', undefined, { cookie: cookieOf(login) });
		expect((await me.json()).username).toBe('abby');
		expect((await call('GET', '/auth/me')).status).toBe(401);
	});

	test('wrong password and unknown user give the same 401 message', async () => {
		const { call } = await signedIn();
		const a = await call('POST', '/auth/login', { username: 'abby', password: 'nope-nope-nope' });
		const b = await call('POST', '/auth/login', { username: 'ghost', password: 'nope-nope-nope' });
		expect(a.status).toBe(401);
		expect(b.status).toBe(401);
		expect(await a.json()).toEqual(await b.json());
	});

	test('login locks out after repeated failures', async () => {
		const { call } = await signedIn();
		let last = 0;
		for (let i = 0; i < 11; i++) {
			last = (await call('POST', '/auth/login', { username: 'locky', password: 'x' })).status;
		}
		expect(last).toBe(429);
	});

	test('logout revokes the session', async () => {
		const { call, db, cookie } = await signedIn();
		expect((await call('POST', '/auth/logout', {}, { cookie })).status).toBe(200);
		expect((await call('GET', '/auth/me', undefined, { cookie })).status).toBe(401);
		expect(db.select().from(session).get()!.revokedAt).not.toBeNull();
	});

	test('a bearer token works and a revoked token fails', async () => {
		const { call, cookie } = await signedIn();
		const made = await call('POST', '/auth/tokens', { name: 'ci' }, { cookie });
		expect(made.status).toBe(201);
		const { id, token } = await made.json();
		expect(token.startsWith('opal_')).toBe(true);
		const bearer = { authorization: `Bearer ${token}` };
		expect((await call('GET', '/auth/me', undefined, bearer)).status).toBe(200);
		const list = await (await call('GET', '/auth/tokens', undefined, bearer)).json();
		expect(list.items.map((t: { name: string }) => t.name)).toEqual(['ci']);
		// A token cannot mint tokens.
		expect((await call('POST', '/auth/tokens', { name: 'x' }, bearer)).status).toBe(403);
		expect((await call('DELETE', `/auth/tokens/${id}`, undefined, { cookie })).status).toBe(200);
		expect((await call('GET', '/auth/me', undefined, bearer)).status).toBe(401);
	});

	test('legacy token hashes stay valid: sha256 hex of the raw token', async () => {
		const { call, db, cookie } = await signedIn();
		const { token } = await (await call('POST', '/auth/tokens', { name: 'k' }, { cookie })).json();
		const expected = new Bun.CryptoHasher('sha256').update(token).digest('hex');
		expect(db.select().from(apiToken).get()!.tokenHash).toBe(expected);
	});

	test('a cross-origin cookie POST is rejected; same-origin and bearer pass', async () => {
		const { call, cookie } = await signedIn();
		const evil = await call('POST', '/auth/logout', {}, { cookie, origin: 'http://evil.test' });
		expect(evil.status).toBe(403);
		const nul = await call('POST', '/auth/logout', {}, { cookie, origin: 'null' });
		expect(nul.status).toBe(403);
		const same = await call('POST', '/auth/tokens', { name: 'a' }, { cookie, origin: 'http://opal.test' });
		expect(same.status).toBe(201);
		const { token } = await same.json();
		const bearer = await call('POST', '/auth/tokens', { name: 'b' }, {
			authorization: `Bearer ${token}`,
			origin: 'http://evil.test'
		});
		// Reaches the handler (humanOnly refuses it) instead of the CSRF guard.
		expect((await bearer.json()).message).toContain('signed-in person');
	});

	test('a legacy argon2-cffi hash verifies with Bun.password', async () => {
		expect(await verifyPassword(LEGACY_HASH, 'kestrel-demo')).toBe(true);
		expect(await verifyPassword(LEGACY_HASH, 'wrong')).toBe(false);
		expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
	});

	test('audit rows never contain a hash', async () => {
		const { call, db, cookie } = await signedIn();
		await call('POST', '/auth/tokens', { name: 'ci' }, { cookie });
		const text = JSON.stringify(db.select().from(auditLog).all());
		expect(text).not.toContain('$argon2');
		expect(text).toContain('[redacted]');
		for (const row of [...db.select().from(session).all(), ...db.select().from(apiToken).all()]) {
			expect(text).not.toContain(row.tokenHash);
		}
	});
});
