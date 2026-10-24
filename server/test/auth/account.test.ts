import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { hashPassword, verifyPassword } from '../../src/auth/tokens.ts';
import { signPayload, verifyPayload } from '../../src/auth/signing.ts';
import { session, user } from '../../src/db/schema/index.ts';
import { adminSession, ADMIN, cookieOf, harness, type Harness, makeUser, signIn } from './helpers.ts';

async function twoUsers(h: Harness) {
	const admin = await adminSession(h);
	const bea = makeUser(h, { username: 'bea', passwordHash: await hashPassword('bea-password-1') });
	return { admin, bea, beaCookie: await signIn(h, 'bea', 'bea-password-1') };
}

describe('signed payloads', () => {
	test('a payload round trips and a tampered one fails', () => {
		const value = signPayload({ kind: 'x', uid: 7 });
		expect(verifyPayload(value)).toEqual({ kind: 'x', uid: 7 });
		expect(verifyPayload(value.slice(0, -1) + (value.endsWith('a') ? 'b' : 'a'))).toBeNull();
		expect(verifyPayload('garbage')).toBeNull();
		expect(verifyPayload(null)).toBeNull();
	});

	test('an expired payload fails', () => {
		expect(verifyPayload(signPayload({ kind: 'x' }, -1000))).toBeNull();
	});

	test('a payload from the Python release verifies (same wire format)', () => {
		// Made with legacy sign_payload and the secret test-secret-for-signing.
		const raw = JSON.stringify({ kind: 'account-claim', uid: 9, __exp: Date.now() / 1000 + 600 });
		const sig = new Bun.CryptoHasher('sha256', 'test-secret-for-signing').update(raw).digest('hex');
		const padded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
		expect(verifyPayload(`${padded}.${sig}`)).toEqual({ kind: 'account-claim', uid: 9 });
	});
});

describe('claim links', () => {
	async function passwordless(h: Harness) {
		const admin = await adminSession(h);
		const u = makeUser(h, { username: 'oldtimer', passwordHash: null });
		return { admin, u };
	}

	test('only an admin issues a claim link', async () => {
		const h = await harness();
		const { u } = await passwordless(h);
		makeUser(h, { username: 'bea', passwordHash: await hashPassword('bea-password-1') });
		const bea = await signIn(h, 'bea', 'bea-password-1');
		expect((await h.call('POST', '/auth/claim-links', { userId: u.id }, { cookie: bea })).status).toBe(403);
		expect((await h.call('POST', '/auth/claim-links', { userId: u.id })).status).toBe(401);
		expect(h.db.select().from(user).where(eq(user.id, u.id)).get()!.passwordHash).toBeNull();
	});

	test('the owner sets a password once through the link', async () => {
		const h = await harness();
		const { admin, u } = await passwordless(h);
		const issued = await h.call('POST', '/auth/claim-links', { userId: u.id }, { cookie: admin });
		expect(issued.status).toBe(201);
		const { token, expiresAt } = await issued.json();
		expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6 * 86_400_000);

		expect(await (await h.call('GET', `/auth/claim?token=${encodeURIComponent(token)}`)).json()).toEqual({ username: 'oldtimer' });
		const short = await h.call('POST', '/auth/claim', { token, password: 'short' });
		expect(short.status).toBe(422);
		const ok = await h.call('POST', '/auth/claim', { token, password: 'new-password-1' });
		expect(ok.status).toBe(200);
		expect(cookieOf(ok, 'opal_session')).toStartWith('opal_session=');
		const row = h.db.select().from(user).where(eq(user.id, u.id)).get()!;
		expect(await verifyPassword(row.passwordHash, 'new-password-1')).toBe(true);

		// A spent link cannot claim the now password-holding account again.
		expect((await h.call('GET', `/auth/claim?token=${encodeURIComponent(token)}`)).status).toBe(404);
		expect((await h.call('POST', '/auth/claim', { token, password: 'stolen-pass-1' })).status).toBe(404);
	});

	test('invalid, forged and wrong-kind links look the same', async () => {
		const h = await harness();
		const { u } = await passwordless(h);
		const wrongKind = signPayload({ kind: 'something-else', uid: u.id });
		const missing = signPayload({ kind: 'account-claim', uid: 9999 });
		const messages = new Set<string>();
		for (const token of ['nonsense', wrongKind, missing]) {
			const res = await h.call('GET', `/auth/claim?token=${encodeURIComponent(token)}`);
			expect(res.status).toBe(404);
			messages.add((await res.json()).message);
		}
		expect(messages.size).toBe(1);
	});

	test('an expired link is refused', async () => {
		const h = await harness();
		const { u } = await passwordless(h);
		const token = signPayload({ kind: 'account-claim', uid: u.id }, -1000);
		expect((await h.call('GET', `/auth/claim?token=${encodeURIComponent(token)}`)).status).toBe(404);
	});

	test('a link for a deactivated account is refused', async () => {
		const h = await harness();
		const { admin, u } = await passwordless(h);
		const { token } = await (await h.call('POST', '/auth/claim-links', { userId: u.id }, { cookie: admin })).json();
		h.db.update(user).set({ isActive: false }).where(eq(user.id, u.id)).run();
		expect((await h.call('GET', `/auth/claim?token=${encodeURIComponent(token)}`)).status).toBe(404);
	});

	test('no link is issued for an account that has a password', async () => {
		const h = await harness();
		const admin = await adminSession(h);
		const bea = makeUser(h, { username: 'bea', passwordHash: await hashPassword('bea-password-1') });
		const res = await h.call('POST', '/auth/claim-links', { userId: bea.id }, { cookie: admin });
		expect(res.status).toBe(400);
		expect((await res.json()).message).toContain('already has a password');
		expect((await h.call('POST', '/auth/claim-links', { userId: 999 }, { cookie: admin })).status).toBe(404);
	});

	test('a passwordless account is not a claim oracle at the login form', async () => {
		const h = await harness();
		const { u } = await passwordless(h);
		const res = await h.call('POST', '/auth/login', { username: 'oldtimer', password: 'x' });
		expect(res.status).toBe(401);
		expect((await res.json()).message).toBe('Invalid username or password');
		expect(h.db.select().from(user).where(eq(user.id, u.id)).get()!.passwordHash).toBeNull();
	});

	test('a claim link is single use under audit without leaking the hash', async () => {
		const h = await harness();
		const { admin, u } = await passwordless(h);
		const { token } = await (await h.call('POST', '/auth/claim-links', { userId: u.id }, { cookie: admin })).json();
		await h.call('POST', '/auth/claim', { token, password: 'new-password-1' });
		const { auditLog } = await import('../../src/db/schema/index.ts');
		const text = JSON.stringify(h.db.select().from(auditLog).all());
		expect(text).not.toContain('$argon2');
	});
});

describe('password change', () => {
	test('it ends the other sessions and keeps the current one', async () => {
		const h = await harness();
		const first = await adminSession(h);
		const second = await signIn(h, 'abby', ADMIN.password);
		const res = await h.call(
			'POST',
			'/auth/password',
			{ currentPassword: ADMIN.password, newPassword: 'brand-new-password-1' },
			{ cookie: first }
		);
		expect(res.status).toBe(200);
		expect((await res.json()).otherSessionsRevoked).toBe(1);
		expect((await h.call('GET', '/auth/me', undefined, { cookie: second })).status).toBe(401);
		expect((await h.call('GET', '/auth/me', undefined, { cookie: first })).status).toBe(200);
		expect(await signIn(h, 'abby', 'brand-new-password-1')).toStartWith('opal_session=');
	});

	test('it needs the current password', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const wrong = await h.call('POST', '/auth/password', { currentPassword: 'wrong', newPassword: 'brand-new-password-1' }, { cookie });
		expect(wrong.status).toBe(403);
		const missing = await h.call('POST', '/auth/password', { newPassword: 'brand-new-password-1' }, { cookie });
		expect(missing.status).toBe(403);
	});

	test('the new password must be strong enough', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const res = await h.call('POST', '/auth/password', { currentPassword: ADMIN.password, newPassword: 'short' }, { cookie });
		expect(res.status).toBe(422);
		expect(Object.keys((await res.json()).fields)).toEqual(['newPassword']);
	});

	test('an account with no password sets its first one without a current password', async () => {
		const h = await harness();
		await adminSession(h);
		const sso = makeUser(h, { username: 'sso', passwordHash: null });
		const { mintSession } = await import('../../src/services/auth/sessions.ts');
		const raw = mintSession(h.ctx, sso, 'oidc');
		const cookie = `opal_session=${raw}`;
		const res = await h.call('POST', '/auth/password', { newPassword: 'first-password-1' }, { cookie });
		expect(res.status).toBe(200);
		expect(await signIn(h, 'sso', 'first-password-1')).toStartWith('opal_session=');
	});

	test('an API token cannot change a password', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { token } = await (await h.call('POST', '/auth/tokens', { name: 'ci' }, { cookie })).json();
		const res = await h.call(
			'POST',
			'/auth/password',
			{ currentPassword: ADMIN.password, newPassword: 'brand-new-password-1' },
			{ authorization: `Bearer ${token}` }
		);
		expect(res.status).toBe(403);
	});
});

describe('sessions', () => {
	test('a user lists their live sessions and sees which one is current', async () => {
		const h = await harness();
		const first = await adminSession(h);
		await signIn(h, 'abby', ADMIN.password);
		const list = (await (await h.call('GET', '/auth/sessions', undefined, { cookie: first })).json()).items;
		expect(list).toHaveLength(2);
		expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
		expect(list[0]).toHaveProperty('method', 'password');
	});

	test('revoked and expired sessions are not listed', async () => {
		const h = await harness();
		const first = await adminSession(h);
		await signIn(h, 'abby', ADMIN.password);
		await signIn(h, 'abby', ADMIN.password);
		const rows = h.db.select().from(session).all();
		h.db.update(session).set({ revokedAt: new Date().toISOString() }).where(eq(session.id, rows[1]!.id)).run();
		h.db.update(session).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(session.id, rows[2]!.id)).run();
		const list = (await (await h.call('GET', '/auth/sessions', undefined, { cookie: first })).json()).items;
		expect(list).toHaveLength(1);
	});

	test('a user ends one of their own sessions, not another user\'s', async () => {
		const h = await harness();
		const { admin, beaCookie } = await twoUsers(h);
		const mine = (await (await h.call('GET', '/auth/sessions', undefined, { cookie: beaCookie })).json()).items[0].id;
		const adminSessionId = h.db.select().from(session).where(eq(session.userId, 1)).get()!.id;
		expect((await h.call('DELETE', `/auth/sessions/${adminSessionId}`, undefined, { cookie: beaCookie })).status).toBe(404);
		expect((await h.call('DELETE', `/auth/sessions/${mine}`, undefined, { cookie: beaCookie })).status).toBe(200);
		expect((await h.call('GET', '/auth/me', undefined, { cookie: beaCookie })).status).toBe(401);
		expect((await h.call('GET', '/auth/me', undefined, { cookie: admin })).status).toBe(200);
	});

	test('sign out others ends every session except the current one', async () => {
		const h = await harness();
		const first = await adminSession(h);
		const second = await signIn(h, 'abby', ADMIN.password);
		const third = await signIn(h, 'abby', ADMIN.password);
		const res = await h.call('POST', '/auth/sessions/revoke-others', {}, { cookie: first });
		expect(await res.json()).toEqual({ ok: true, revoked: 2 });
		expect((await h.call('GET', '/auth/me', undefined, { cookie: first })).status).toBe(200);
		expect((await h.call('GET', '/auth/me', undefined, { cookie: second })).status).toBe(401);
		expect((await h.call('GET', '/auth/me', undefined, { cookie: third })).status).toBe(401);
	});

	test('sessions of other users are untouched by sign out others', async () => {
		const h = await harness();
		const { admin, beaCookie } = await twoUsers(h);
		await h.call('POST', '/auth/sessions/revoke-others', {}, { cookie: admin });
		expect((await h.call('GET', '/auth/me', undefined, { cookie: beaCookie })).status).toBe(200);
	});

	test('session routes need a signed-in user', async () => {
		const h = await harness();
		expect((await h.call('GET', '/auth/sessions')).status).toBe(401);
		expect((await h.call('POST', '/auth/sessions/revoke-others', {})).status).toBe(401);
	});
});
