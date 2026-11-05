import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { project, user } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

// Undo is for pencil. Identity, authority and directory records other work relies on are not
// pencil, so undo never reaches them, whoever asks.
describe('undo does not reach authority, identity or stamped records', () => {
	test('a user change cannot be undone, so an admin grant stays until someone changes it back', async () => {
		const { call, makeUser, db } = await setup();
		const boss = makeUser('boss', { admin: true });
		const other = makeUser('other');
		expect((await call(boss, 'PATCH', `/users/${other.id}`, { isAdmin: true })).status).toBe(200);
		expect((await call(boss, 'GET', '/undo/last')).json.canUndo).toBe(false);
		expect((await call(boss, 'POST', '/undo/last')).status).toBe(409);
		expect(db.select().from(user).where(eq(user.id, other.id)).get()!.isAdmin).toBe(true);
	});

	test('a role change cannot be undone', async () => {
		const { call, makeUser } = await setup();
		const boss = makeUser('boss', { admin: true });
		expect((await call(boss, 'POST', '/roles', { name: 'Zeta' })).status).toBe(201);
		expect((await call(boss, 'GET', '/undo/last')).json.canUndo).toBe(false);
		expect((await call(boss, 'POST', '/undo/last')).status).toBe(409);
		const list = (await call(boss, 'GET', '/roles')).json;
		expect(list.some((r: { name: string }) => r.name === 'Zeta')).toBe(true);
	});

	test('a project change cannot be undone', async () => {
		const { call, makeUser, db } = await setup();
		const boss = makeUser('boss', { admin: true });
		const made = await call(boss, 'POST', '/projects', { code: 'UNDO', name: 'Original' });
		expect(made.status).toBe(201);
		expect((await call(boss, 'PATCH', `/projects/${made.json.id}`, { name: 'Renamed' })).status).toBe(200);
		expect((await call(boss, 'POST', '/undo/last')).status).toBe(409);
		expect(db.select().from(project).where(eq(project.id, made.json.id)).get()!.name).toBe('Renamed');
	});

	test('a workcenter deactivation is a stamp that undo does not reverse', async () => {
		const { call, makeUser } = await setup();
		const boss = makeUser('boss', { admin: true });
		const made = await call(boss, 'POST', '/workcenters', { code: 'WC-U', name: 'Bench' });
		expect(made.status).toBe(201);
		expect((await call(boss, 'DELETE', `/workcenters/${made.json.id}`)).status).toBe(200);
		expect((await call(boss, 'GET', '/undo/last')).json.canUndo).toBe(false);
	});
});
