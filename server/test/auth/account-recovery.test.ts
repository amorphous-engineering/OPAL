import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { apiToken, auditLog, passkeyCredential } from '../../src/db/schema/index.ts';
import { hashPassword } from '../../src/auth/tokens.ts';
import { adminSession, harness, makeUser, signIn } from './helpers.ts';

/** An admin, plus a person with a password, a session, an API token and a passkey. */
async function team() {
	const h = await harness();
	const admin = await adminSession(h);
	const bob = makeUser(h, { username: 'bob', passwordHash: await hashPassword('bobs-password-1') });
	const cookie = await signIn(h, 'bob', 'bobs-password-1');
	const { token } = await (await h.call('POST', '/auth/tokens', { name: 'agent' }, { cookie })).json();
	const ts = new Date().toISOString();
	h.db
		.insert(passkeyCredential)
		.values({ userId: bob.id, credentialId: Buffer.from('cred-1'), publicKey: Buffer.from('pk'), name: 'Laptop', createdAt: ts, updatedAt: ts })
		.run();
	const me = (t: string) => h.call('GET', '/auth/me', undefined, { authorization: `Bearer ${t}` });
	return { h, admin, bob, token, me };
}

describe('account recovery', () => {
	test('an admin password reset ends the API tokens and removes the passkeys of the account', async () => {
		const { h, admin, bob, token, me } = await team();
		expect((await me(token)).status).toBe(200);
		const res = await h.call('POST', `/users/${bob.id}/reset-password`, undefined, { cookie: admin });
		expect(res.status).toBe(200);
		expect((await me(token)).status).toBe(401);
		expect(h.db.select().from(passkeyCredential).where(eq(passkeyCredential.userId, bob.id)).all()).toHaveLength(0);
		const audited = h.db.select().from(auditLog).all();
		expect(audited.some((a) => a.entity === 'api_token' && a.action === 'update')).toBe(true);
		expect(audited.some((a) => a.entity === 'passkey_credential' && a.action === 'delete')).toBe(true);
	});

	test('deactivating a person ends their API tokens for good, and reactivating does not bring them back', async () => {
		const { h, admin, bob, token, me } = await team();
		expect((await h.call('PATCH', `/users/${bob.id}`, { isActive: false }, { cookie: admin })).status).toBe(200);
		expect(h.db.select().from(apiToken).where(eq(apiToken.userId, bob.id)).get()?.revokedAt).not.toBeNull();
		expect((await h.call('PATCH', `/users/${bob.id}`, { isActive: true }, { cookie: admin })).status).toBe(200);
		expect((await me(token)).status).toBe(401);
	});

	test('deactivating through the delete route also ends the API tokens', async () => {
		const { h, admin, bob, token, me } = await team();
		expect((await h.call('DELETE', `/users/${bob.id}`, undefined, { cookie: admin })).status).toBe(200);
		await h.call('PATCH', `/users/${bob.id}`, { isActive: true }, { cookie: admin });
		expect((await me(token)).status).toBe(401);
	});

	test('a reset leaves the tokens of other people working', async () => {
		const { h, admin, bob } = await team();
		const { token: adminToken } = await (await h.call('POST', '/auth/tokens', { name: 'admin-agent' }, { cookie: admin })).json();
		await h.call('POST', `/users/${bob.id}/reset-password`, undefined, { cookie: admin });
		expect((await h.call('GET', '/auth/me', undefined, { authorization: `Bearer ${adminToken}` })).status).toBe(200);
	});
});
