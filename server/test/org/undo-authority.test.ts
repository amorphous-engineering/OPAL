import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { user } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

describe('undo needs the authority of the reversed operation', () => {
	test('a demoted admin gets 403 when undoing an admin-only change', async () => {
		const { call, makeUser, db } = await setup();
		const root = makeUser('root', { admin: true });
		const boss = makeUser('boss', { admin: true });
		const other = makeUser('other');
		expect((await call(boss, 'PATCH', `/users/${other.id}`, { isAdmin: true })).status).toBe(200);
		// boss loses admin: the session stays valid but the actor is no longer admin
		expect((await call(root, 'PATCH', `/users/${boss.id}`, { isAdmin: false })).status).toBe(200);
		const demoted = { ...boss.actor, isAdmin: false } as typeof boss.actor;
		expect((await call(demoted, 'POST', '/undo/last')).status).toBe(403);
		expect(db.select().from(user).where(eq(user.id, other.id)).get()!.isAdmin).toBe(true);
	});

	test('a demoted admin gets 403 when undoing a role change', async () => {
		const { call, makeUser } = await setup();
		const boss = makeUser('boss', { admin: true });
		const made = await call(boss, 'POST', '/roles', { name: 'Zeta' });
		expect(made.status).toBe(201);
		const demoted = { ...boss.actor, isAdmin: false } as typeof boss.actor;
		expect((await call(demoted, 'POST', '/undo/last')).status).toBe(403);
		const list = (await call(boss, 'GET', '/roles')).json;
		expect(list.some((r: any) => r.name === 'Zeta')).toBe(true);
	});

	test('undo of users.update keeps the password hash', async () => {
		const { call, makeUser, db } = await setup();
		const admin = makeUser('root', { admin: true });
		const other = makeUser('other');
		db.update(user).set({ passwordHash: 'real-hash' }).where(eq(user.id, other.id)).run();
		expect((await call(admin, 'PATCH', `/users/${other.id}`, { name: 'Renamed' })).status).toBe(200);
		expect((await call(admin, 'POST', '/undo/last')).status).toBe(200);
		const row = db.select().from(user).where(eq(user.id, other.id)).get()!;
		expect(row.passwordHash).toBe('real-hash');
		expect(row.name).toBe('other');
	});
});
