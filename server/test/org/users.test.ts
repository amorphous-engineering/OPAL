import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLog, session, user } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

describe('creating users', () => {
	test('an admin creates a user; a username is derived and made unique', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const a = await call(admin, 'POST', '/users', { name: 'Ada Lovelace', email: 'ada@lab.local' });
		expect(a.status).toBe(201);
		expect(a.json.username).toBe('ada');
		expect(a.json.hasPassword).toBe(false);
		const b = await call(admin, 'POST', '/users', { name: 'Ada Two', username: 'Ada' });
		expect(b.json.username).toBe('ada2');
	});

	test('a user created with a password has one; a short password is refused', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const ok = await call(admin, 'POST', '/users', { name: 'P', password: 'correct horse battery' });
		expect(ok.json.hasPassword).toBe(true);
		const bad = await call(admin, 'POST', '/users', { name: 'Q', password: 'short' });
		expect(bad.status).toBe(400);
	});

	test('only an admin creates users', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'POST', '/users', { name: 'X' })).status).toBe(403);
	});

	test('a duplicate email is a conflict', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const r = await call(admin, 'POST', '/users', { name: 'X', email: 'bob@x.local' });
		expect(r.status).toBe(409);
		const patch = await call(admin, 'PATCH', `/users/${admin.id}`, { email: 'bob@x.local' });
		expect(patch.status).toBe(409);
		expect(bob.id).toBeGreaterThan(0);
	});

	test('LAN style email domains are accepted and garbage is not', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		expect((await call(admin, 'POST', '/users', { name: 'A', email: 'a@host.local' })).status).toBe(201);
		expect((await call(admin, 'POST', '/users', { name: 'B', email: 'not an email' })).status).toBe(422);
		expect((await call(admin, 'POST', '/users', { name: 'C', email: 'a@b' })).status).toBe(422);
	});

	test('creating a user writes an audit row without the password hash', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/users', { name: 'P', password: 'correct horse battery' });
		const row = db.select().from(auditLog).where(eq(auditLog.op, 'users.create')).get()!;
		expect((row.after as any).passwordHash).toBe('[redacted]');
		expect(row.actorUserId).toBe(admin.id);
	});
});

describe('reading users', () => {
	test('a user reads self but not others; an admin reads anyone', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		expect((await call(bob, 'GET', `/users/${bob.id}`)).status).toBe(200);
		expect((await call(bob, 'GET', `/users/${admin.id}`)).status).toBe(403);
		expect((await call(admin, 'GET', `/users/${bob.id}`)).status).toBe(200);
		expect((await call(admin, 'GET', '/users/9999')).status).toBe(404);
	});

	test('the roster is admin only, filters by active state and searches name, username and email', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		makeUser('alice');
		makeUser('bob', { active: false });
		expect((await call(makeUser('eve'), 'GET', '/users')).status).toBe(403);
		const all = (await call(admin, 'GET', '/users')).json;
		expect(all.total).toBe(4);
		expect((await call(admin, 'GET', '/users?isActive=false')).json.items.map((u: any) => u.username)).toEqual(['bob']);
		expect((await call(admin, 'GET', '/users?isActive=true')).json.total).toBe(3);
		expect((await call(admin, 'GET', '/users?search=ALI')).json.items.map((u: any) => u.username)).toEqual(['alice']);
		expect((await call(admin, 'GET', '/users?search=bob@x')).json.items.map((u: any) => u.username)).toEqual(['bob']);
	});

	test('the roster pages by cursor', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		for (const n of ['a', 'b', 'c']) makeUser(n);
		const first = (await call(admin, 'GET', '/users?limit=2')).json;
		expect(first.items.map((u: any) => u.username)).toEqual(['a', 'b']);
		const second = (await call(admin, 'GET', `/users?limit=2&cursor=${first.next}`)).json;
		expect(second.items.map((u: any) => u.username)).toEqual(['c', 'root']);
		expect(second.next).toBeNull();
	});

	test('the directory is open to users, lists only active users by name and hides contact details', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		makeUser('zed');
		makeUser('amy');
		makeUser('gone', { active: false });
		const res = await call(bob, 'GET', '/users/directory');
		expect(res.status).toBe(200);
		expect(res.json.map((u: any) => u.username)).toEqual(['amy', 'bob', 'zed']);
		expect(res.json[0]).not.toHaveProperty('email');
		expect(res.json[0]).not.toHaveProperty('isAdmin');
		expect((await call(null, 'GET', '/users/directory')).status).toBe(401);
	});
});

describe('updating users', () => {
	test('a user edits own name, email, job title, phone and workcenter but not admin or active state', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const wc = (await call(admin, 'POST', '/workcenters', { name: 'Clean room', code: 'cr' })).json;
		const r = await call(bob, 'PATCH', `/users/${bob.id}`, {
			name: 'Bob B', jobTitle: ' Tech ', phone: '555', workcenterId: wc.id
		});
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ name: 'Bob B', jobTitle: 'Tech', phone: '555', workcenter: { id: wc.id, name: 'Clean room' } });
		const bad = await call(bob, 'PATCH', `/users/${bob.id}`, { isAdmin: true });
		expect(bad.status).toBe(403);
		expect(bad.json.message).toContain('isAdmin');
		expect((await call(bob, 'PATCH', `/users/${admin.id}`, { name: 'x' })).status).toBe(403);
	});

	test('a blank job title or phone is stored as nothing', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		await call(bob, 'PATCH', `/users/${bob.id}`, { jobTitle: 'Tech' });
		const r = await call(bob, 'PATCH', `/users/${bob.id}`, { jobTitle: '  ', phone: '' });
		expect(r.json.jobTitle).toBeNull();
		expect(r.json.phone).toBeNull();
	});

	test('a blank name is refused', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'PATCH', `/users/${bob.id}`, { name: '   ' })).status).toBe(422);
	});

	test('an unknown workcenter is refused', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'PATCH', `/users/${bob.id}`, { workcenterId: 999 })).status).toBe(400);
	});

	test('the last active admin cannot be demoted or deactivated', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const demote = await call(admin, 'PATCH', `/users/${admin.id}`, { isAdmin: false });
		expect(demote.status).toBe(400);
		expect(demote.json.message).toBe('Cannot remove the last admin');
		expect((await call(admin, 'PATCH', `/users/${admin.id}`, { isActive: false })).status).toBe(400);
		expect((await call(admin, 'DELETE', `/users/${admin.id}`)).status).toBe(400);
		// a second admin lifts the guard
		makeUser('two', { admin: true });
		expect((await call(admin, 'PATCH', `/users/${admin.id}`, { isAdmin: false })).status).toBe(200);
	});

	test('deactivating a user ends their sessions', async () => {
		const { db, call, makeUser, addSession } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		addSession(bob.id);
		addSession(bob.id);
		const r = await call(admin, 'PATCH', `/users/${bob.id}`, { isActive: false });
		expect(r.json.isActive).toBe(false);
		const rows = db.select().from(session).where(eq(session.userId, bob.id)).all();
		expect(rows.every((s) => s.revokedAt !== null)).toBe(true);
	});

	test('a user may deactivate self, not others, and the account stays', async () => {
		const { db, call, makeUser, addSession } = await setup();
		makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const eve = makeUser('eve');
		expect((await call(bob, 'DELETE', `/users/${eve.id}`)).status).toBe(403);
		addSession(bob.id);
		expect((await call(bob, 'DELETE', `/users/${bob.id}`)).status).toBe(200);
		expect(db.select().from(user).where(eq(user.id, bob.id)).get()?.isActive).toBe(false);
		expect(db.select().from(session).where(eq(session.userId, bob.id)).all()[0]!.revokedAt).not.toBeNull();
	});
});

describe('reset password', () => {
	test('reset clears the password, ends the sessions and leaves the account unclaimed', async () => {
		const { db, call, makeUser, addSession } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		db.update(user).set({ passwordHash: 'x' }).where(eq(user.id, bob.id)).run();
		addSession(bob.id);
		const r = await call(admin, 'POST', `/users/${bob.id}/reset-password`);
		expect(r.json).toEqual({ ok: true, sessionsRevoked: 1 });
		expect(db.select().from(user).where(eq(user.id, bob.id)).get()?.passwordHash).toBeNull();
	});

	test('an admin cannot reset their own password and a user cannot reset anyone', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		expect((await call(admin, 'POST', `/users/${admin.id}/reset-password`)).status).toBe(400);
		expect((await call(bob, 'POST', `/users/${admin.id}/reset-password`)).status).toBe(403);
	});
});

describe('activity', () => {
	test('activity lists the recent audited changes of a user, newest first, with their subject', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/workcenters', { name: 'Bay', code: 'b1' });
		await call(admin, 'POST', '/roles', { name: 'Welder' });
		const r = await call(admin, 'GET', `/users/${admin.id}/activity?limit=5`);
		expect(r.status).toBe(200);
		expect(r.json[0]).toMatchObject({ table: 'role', action: 'create', subject: 'Welder' });
		expect(r.json[1]).toMatchObject({ table: 'workcenter', action: 'create', subject: 'Bay' });
		expect(r.json[0].timestamp).toMatch(/Z$/);
	});

	test('a user reads own activity but not that of others', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		expect((await call(bob, 'GET', `/users/${bob.id}/activity`)).status).toBe(200);
		expect((await call(bob, 'GET', `/users/${admin.id}/activity`)).status).toBe(403);
	});
});

describe('onboarding', () => {
	test('a user owes the orientation until it is completed', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		expect((await call(bob, 'GET', '/users/me/profile-state')).json).toEqual({ needsProfileSetup: false, needsOnboarding: true });
		expect((await call(bob, 'POST', '/welcome/complete')).status).toBe(200);
		expect((await call(bob, 'GET', '/users/me/profile-state')).json.needsOnboarding).toBe(false);
	});

	test('the first admin on an empty catalog gets setup, everyone else the tutorial', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		expect((await call(admin, 'GET', '/welcome')).json.mode).toBe('setup');
		expect((await call(bob, 'GET', '/welcome')).json.mode).toBe('tutorial');
	});

	test('each user chooses local or UTC time display, and cannot change another user', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const amy = makeUser('amy', { admin: true });
		expect((await call(bob, 'PUT', '/users/me/time-display', { timeDisplay: 'utc' })).json).toEqual({ timeDisplay: 'utc' });
		expect((await call(bob, 'PUT', '/users/me/time-display', { timeDisplay: 'moon' })).status).toBe(422);
		expect((await call(null, 'PUT', '/users/me/time-display', { timeDisplay: 'utc' })).status).toBe(401);
		// The operation takes no user id: an admin changes only their own choice.
		expect((await call(amy, 'PUT', '/users/me/time-display', { timeDisplay: 'utc' })).status).toBe(200);
		expect((await call(amy, 'PUT', '/users/me/time-display', { timeDisplay: 'local' })).status).toBe(200);
		expect((await call(bob, 'GET', '/auth/me')).json.timeDisplay).toBe('utc');
		expect((await call(amy, 'GET', '/auth/me')).json.timeDisplay).toBe('local');
	});

	test('setting up a profile sets the display name', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const r = await call(bob, 'POST', '/users/me/setup-profile', { name: 'Robert' });
		expect(r.json.name).toBe('Robert');
	});
});
