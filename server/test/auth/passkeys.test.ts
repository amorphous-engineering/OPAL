import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { passkeyCredential, webauthnChallenge } from '../../src/db/schema/auth.ts';
import { user } from '../../src/db/schema/index.ts';
import { coseKeyOf, consumeChallenge, storeChallenge } from '../../src/services/auth/passkeys.ts';
import { SoftAuthenticator } from './authenticator.ts';
import { adminSession, ADMIN, cookieOf, harness, type Harness, makeUser, signIn } from './helpers.ts';
import { hashPassword } from '../../src/auth/tokens.ts';

const RP = 'opal.test';

async function register(h: Harness, session: string, auth: SoftAuthenticator, name = 'Laptop') {
	const begin = await h.call('POST', '/auth/passkeys/register/begin', { rpId: RP }, { cookie: session });
	expect(begin.status).toBe(200);
	const state = cookieOf(begin, 'opal_webauthn_state');
	const { publicKey } = await begin.json();
	const complete = await h.call(
		'POST',
		'/auth/passkeys/register/complete',
		{ name, credential: auth.create(publicKey, RP) },
		{ cookie: `${session}; ${state}` }
	);
	return { begin, complete, state, publicKey };
}

async function beginLogin(h: Harness) {
	const res = await h.call('POST', '/auth/passkeys/login/begin', { rpId: RP });
	return { res, state: cookieOf(res, 'opal_webauthn_state'), publicKey: (await res.clone().json()).publicKey };
}

describe('passkey challenges', () => {
	test('a challenge is single use', async () => {
		const h = await harness();
		const nonce = storeChallenge(h.db, 'login', RP, { challenge: 'abc' });
		const first = consumeChallenge(h.db, nonce, 'login');
		expect(first?.state).toEqual({ challenge: 'abc' });
		expect(first?.rpId).toBe(RP);
		expect(consumeChallenge(h.db, nonce, 'login')).toBeNull();
	});

	test('a challenge of the wrong kind is refused and burned', async () => {
		const h = await harness();
		const u = makeUser(h, { username: 'a' });
		const nonce = storeChallenge(h.db, 'register', RP, { challenge: 'x' }, u.id);
		expect(consumeChallenge(h.db, nonce, 'login')).toBeNull();
		expect(consumeChallenge(h.db, nonce, 'register')).toBeNull();
	});

	test('an expired challenge is refused', async () => {
		const h = await harness();
		const nonce = storeChallenge(h.db, 'login', RP, { challenge: 'x' });
		h.db.update(webauthnChallenge).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).run();
		expect(consumeChallenge(h.db, nonce, 'login')).toBeNull();
	});

	test('an unknown or missing nonce finds nothing', async () => {
		const h = await harness();
		expect(consumeChallenge(h.db, 'no-such-nonce', 'login')).toBeNull();
		expect(consumeChallenge(h.db, null, 'login')).toBeNull();
		expect(consumeChallenge(h.db, undefined, 'login')).toBeNull();
	});

	test('starting a sign-in stores a login challenge server-side and sets a signed cookie', async () => {
		const h = await harness();
		const { res, state } = await beginLogin(h);
		expect(res.status).toBe(200);
		expect(state.startsWith('opal_webauthn_state=')).toBe(true);
		const rows = h.db.select().from(webauthnChallenge).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.kind).toBe('login');
		expect(rows[0]!.rpId).toBe(RP);
	});

	test('sign-in options ask for no specific credential (usernameless)', async () => {
		const h = await harness();
		const { publicKey } = await beginLogin(h);
		expect(publicKey.allowCredentials ?? []).toEqual([]);
		expect(publicKey.rpId).toBe(RP);
	});
});

describe('passkeys', () => {
	test('a user registers a passkey, lists it, and signs in with it', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		const { complete } = await register(h, session, auth);
		expect(complete.status).toBe(200);
		const made = await complete.json();
		expect(made.name).toBe('Laptop');

		const list = await (await h.call('GET', '/auth/passkeys', undefined, { cookie: session })).json();
		expect(list.items).toHaveLength(1);
		expect(list.items[0].transports).toBe('internal,hybrid');
		expect(list.items[0].lastUsedAt).toBeNull();

		const { state, publicKey } = await beginLogin(h);
		const login = await h.call(
			'POST',
			'/auth/passkeys/login/complete',
			{ credential: auth.get(publicKey, RP) },
			{ cookie: state }
		);
		expect(login.status).toBe(200);
		expect((await login.json()).user.username).toBe('abby');
		const cookie = cookieOf(login, 'opal_session');
		const me = await h.call('GET', '/auth/me', undefined, { cookie });
		expect(me.status).toBe(200);
		const sessions = await (await h.call('GET', '/auth/sessions', undefined, { cookie })).json();
		expect(sessions.items.find((s: { current: boolean }) => s.current).method).toBe('passkey');
		const row = h.db.select().from(passkeyCredential).get()!;
		expect(row.lastUsedAt).not.toBeNull();
		expect(row.signCount).toBe(1);
	});

	test('the stored key keeps the legacy layout so imported credentials work unchanged', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		await register(h, session, auth);
		const row = h.db.select().from(passkeyCredential).get()!;
		expect(Buffer.from(row.credentialId).equals(auth.credentialId)).toBe(true);
		expect(row.publicKey.readUInt16BE(16)).toBe(auth.credentialId.length);
		expect(Buffer.from(coseKeyOf(row.publicKey)).equals(auth.coseKey)).toBe(true);
	});

	test('a completed challenge cannot be replayed', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		await register(h, session, auth);
		const { state, publicKey } = await beginLogin(h);
		const body = { credential: auth.get(publicKey, RP) };
		expect((await h.call('POST', '/auth/passkeys/login/complete', body, { cookie: state })).status).toBe(200);
		const again = await h.call('POST', '/auth/passkeys/login/complete', body, { cookie: state });
		expect(again.status).toBe(400);
	});

	test('a failed assertion burns its challenge', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		await register(h, session, auth);
		const { state, publicKey } = await beginLogin(h);
		const bad = auth.get(publicKey, RP, { origin: 'https://evil.test' });
		expect((await h.call('POST', '/auth/passkeys/login/complete', { credential: bad }, { cookie: state })).status).toBe(401);
		await Bun.sleep(30);
		const good = await h.call('POST', '/auth/passkeys/login/complete', { credential: auth.get(publicKey, RP) }, { cookie: state });
		expect(good.status).toBe(400);
	});

	test('an unknown credential cannot sign in', async () => {
		const h = await harness();
		await adminSession(h);
		const stranger = new SoftAuthenticator();
		const { state, publicKey } = await beginLogin(h);
		const res = await h.call('POST', '/auth/passkeys/login/complete', { credential: stranger.get(publicKey, RP) }, { cookie: state });
		expect(res.status).toBe(401);
	});

	test('a signature counter that goes backwards is refused as a cloned key', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		await register(h, session, auth);
		for (const counter of [5, 3]) {
			const { state, publicKey } = await beginLogin(h);
			const res = await h.call('POST', '/auth/passkeys/login/complete', { credential: auth.get(publicKey, RP, { counter }) }, { cookie: state });
			expect(res.status).toBe(counter === 5 ? 200 : 401);
		}
	});

	test('a deactivated user cannot sign in with a passkey', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		await register(h, session, auth);
		h.db.update(user).set({ isActive: false }).run();
		const { state, publicKey } = await beginLogin(h);
		const res = await h.call('POST', '/auth/passkeys/login/complete', { credential: auth.get(publicKey, RP) }, { cookie: state });
		expect(res.status).toBe(401);
	});

	test('sign-in without the challenge cookie is refused', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const auth = new SoftAuthenticator();
		await register(h, session, auth);
		const { publicKey } = await beginLogin(h);
		const res = await h.call('POST', '/auth/passkeys/login/complete', { credential: auth.get(publicKey, RP) });
		expect(res.status).toBe(400);
	});

	test("a registration challenge started by one user cannot finish for another", async () => {
		const h = await harness();
		const admin = await adminSession(h);
		makeUser(h, { username: 'bea', passwordHash: await hashPassword('bea-password-1') });
		const bea = await signIn(h, 'bea', 'bea-password-1');
		const begin = await h.call('POST', '/auth/passkeys/register/begin', { rpId: RP }, { cookie: admin });
		const state = cookieOf(begin, 'opal_webauthn_state');
		const { publicKey } = await begin.json();
		const res = await h.call(
			'POST',
			'/auth/passkeys/register/complete',
			{ name: 'x', credential: new SoftAuthenticator().create(publicKey, RP) },
			{ cookie: `${bea}; ${state}` }
		);
		expect(res.status).toBe(400);
		expect(h.db.select().from(passkeyCredential).all()).toHaveLength(0);
	});

	test('a registration from a foreign origin is refused', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const begin = await h.call('POST', '/auth/passkeys/register/begin', { rpId: RP }, { cookie: session });
		const state = cookieOf(begin, 'opal_webauthn_state');
		const { publicKey } = await begin.json();
		const credential = new SoftAuthenticator().create(publicKey, RP, 'https://evil.test');
		const res = await h.call('POST', '/auth/passkeys/register/complete', { name: 'x', credential }, { cookie: `${session}; ${state}` });
		expect(res.status).toBe(400);
		expect((await res.json()).message).toContain('Passkey registration failed');
	});

	test('registering excludes passkeys the user already has', async () => {
		const h = await harness();
		const session = await adminSession(h);
		await register(h, session, new SoftAuthenticator());
		const begin = await h.call('POST', '/auth/passkeys/register/begin', { rpId: RP }, { cookie: session });
		const { publicKey } = await begin.json();
		expect(publicKey.excludeCredentials).toHaveLength(1);
		expect(publicKey.authenticatorSelection.residentKey).toBe('required');
	});

	test('a user renames and removes only their own passkeys', async () => {
		const h = await harness();
		const admin = await adminSession(h);
		await register(h, admin, new SoftAuthenticator());
		const id = h.db.select().from(passkeyCredential).get()!.id;
		makeUser(h, { username: 'bea', passwordHash: await hashPassword('bea-password-1') });
		const bea = await signIn(h, 'bea', 'bea-password-1');
		expect((await h.call('PATCH', `/auth/passkeys/${id}`, { name: 'mine' }, { cookie: bea })).status).toBe(404);
		expect((await h.call('DELETE', `/auth/passkeys/${id}`, undefined, { cookie: bea })).status).toBe(404);
		const renamed = await h.call('PATCH', `/auth/passkeys/${id}`, { name: 'Shop laptop' }, { cookie: admin });
		expect((await renamed.json()).name).toBe('Shop laptop');
		expect((await h.call('DELETE', `/auth/passkeys/${id}`, undefined, { cookie: admin })).status).toBe(200);
		expect(h.db.select().from(passkeyCredential).all()).toHaveLength(0);
	});

	test('passkeys can be switched off', async () => {
		const h = await harness();
		const session = await adminSession(h);
		const off = await h.call(
			'PUT',
			'/settings/auth',
			{ passwordLoginEnabled: true, passkeysEnabled: false },
			{ cookie: session }
		);
		expect(off.status).toBe(200);
		expect((await h.call('POST', '/auth/passkeys/register/begin', { rpId: RP }, { cookie: session })).status).toBe(403);
		expect((await h.call('POST', '/auth/passkeys/login/begin', { rpId: RP })).status).toBe(403);
		expect((await (await h.call('GET', '/auth/config')).json()).passkeysEnabled).toBe(false);
	});

	test('a pinned RP ID beats the browser hint', async () => {
		const h = await harness();
		const session = await adminSession(h);
		await h.call(
			'PUT',
			'/settings/auth',
			{ passwordLoginEnabled: true, passkeysEnabled: true },
			{ cookie: session }
		);
		h.db.insert((await import('../../src/db/schema/auth.ts')).authSetting)
			.values({ key: 'passkey_rp_id', value: 'opal.example.com', createdAt: 'x', updatedAt: 'x' })
			.run();
		const { publicKey } = await beginLogin(h);
		expect(publicKey.rpId).toBe('opal.example.com');
	});

	test('the admin account stays the owner of its credential row', async () => {
		const h = await harness();
		const session = await adminSession(h);
		await register(h, session, new SoftAuthenticator());
		const row = h.db.select().from(passkeyCredential).get()!;
		expect(row.userId).toBe(h.db.select().from(user).where(eq(user.username, ADMIN.username.toLowerCase())).get()!.id);
	});
});
