import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLog, roleGate, role as roleT } from '../../src/db/schema/index.ts';
import { holdsGate } from '../../src/services/org/gates.ts';
import { canonicalRoleName, holdsSlotRole, roleNamesOf } from '../../src/services/org/roles.ts';
import { setup } from './helpers.ts';

describe('system roles', () => {
	test('a new database lists Engineer, Technician, Quality, Admin first and in that order', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/roles', { name: 'Zeta' });
		await call(admin, 'POST', '/roles', { name: 'Alpha' });
		const list = (await call(admin, 'GET', '/roles')).json;
		expect(list.map((r: any) => r.name)).toEqual(['Engineer', 'Technician', 'Quality', 'Admin', 'Alpha', 'Zeta']);
		expect(list.slice(0, 4).every((r: any) => r.isSystem)).toBe(true);
	});

	test('a system role cannot be renamed or deleted', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const eng = (await call(admin, 'GET', '/roles')).json.find((r: any) => r.key === 'engineer');
		expect((await call(admin, 'PATCH', `/roles/${eng.id}`, { name: 'Boss' })).status).toBe(400);
		expect((await call(admin, 'DELETE', `/roles/${eng.id}`)).status).toBe(400);
		// the description may change
		const ok = await call(admin, 'PATCH', `/roles/${eng.id}`, { description: 'x' });
		expect(ok.status).toBe(200);
		expect(ok.json.description).toBe('x');
	});

	test('a custom role with a system name becomes the system role in place and keeps its id', async () => {
		const { db, call, makeUser } = await setup();
		const ts = new Date().toISOString();
		const custom = db.insert(roleT).values({ name: 'quality', description: 'mine', createdAt: ts, updatedAt: ts }).returning().get();
		const admin = makeUser('root', { admin: true });
		const list = (await call(admin, 'GET', '/roles')).json;
		const q = list.find((r: any) => r.key === 'quality');
		expect(q.id).toBe(custom.id);
		expect(q.name).toBe('Quality');
		expect(q.description).toBe('mine');
		expect(list.filter((r: any) => r.name.toLowerCase() === 'quality')).toHaveLength(1);
	});
});

describe('role crud', () => {
	test('creating, renaming and deleting a role is admin only', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const user = makeUser('bob');
		expect((await call(user, 'POST', '/roles', { name: 'QA' })).status).toBe(403);
		const made = await call(admin, 'POST', '/roles', { name: 'QA', description: 'quality' });
		expect(made.status).toBe(201);
		expect((await call(user, 'PATCH', `/roles/${made.json.id}`, { name: 'QC' })).status).toBe(403);
		expect((await call(user, 'DELETE', `/roles/${made.json.id}`)).status).toBe(403);
		const renamed = await call(admin, 'PATCH', `/roles/${made.json.id}`, { name: 'QC' });
		expect(renamed.json.name).toBe('QC');
		expect((await call(admin, 'DELETE', `/roles/${made.json.id}`)).status).toBe(200);
		expect((await call(user, 'GET', `/roles/${made.json.id}`)).status).toBe(404);
	});

	test('role names are unique ignoring case', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/roles', { name: 'Welder' });
		expect((await call(admin, 'POST', '/roles', { name: 'welder' })).status).toBe(409);
		const other = await call(admin, 'POST', '/roles', { name: 'Fitter' });
		expect((await call(admin, 'PATCH', `/roles/${other.json.id}`, { name: 'WELDER' })).status).toBe(409);
	});

	test('a blank role name is refused', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		expect((await call(admin, 'POST', '/roles', { name: '   ' })).status).toBe(422);
	});

	test('member counts and detail count active holders only; the Admin role counts active admins', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const a = makeUser('a');
		const b = makeUser('b', { active: false });
		const role = (await call(admin, 'POST', '/roles', { name: 'Welder' })).json;
		await call(admin, 'PUT', `/users/${a.id}/roles`, { roleIds: [role.id] });
		await call(admin, 'PUT', `/users/${b.id}/roles`, { roleIds: [role.id] });
		const list = (await call(admin, 'GET', '/roles')).json;
		expect(list.find((r: any) => r.id === role.id).memberCount).toBe(1);
		expect(list.find((r: any) => r.key === 'admin').memberCount).toBe(1);
		const detail = (await call(a, 'GET', `/roles/${role.id}`)).json;
		expect(detail.members.map((m: any) => m.name)).toEqual(['a']);
	});

	test('deleting a custom role drops its grants and its gate mapping', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const a = makeUser('a');
		const role = (await call(admin, 'POST', '/roles', { name: 'Lead' })).json;
		await call(admin, 'PUT', `/users/${a.id}/roles`, { roleIds: [role.id] });
		await call(admin, 'PUT', '/gates/issue.approve', { roleIds: [role.id] });
		expect(holdsGate(db, a.actor, 'issue.approve')).toBe(true);
		await call(admin, 'DELETE', `/roles/${role.id}`);
		expect(db.select().from(roleGate).where(eq(roleGate.roleId, role.id)).all()).toHaveLength(0);
		expect(holdsGate(db, a.actor, 'issue.approve')).toBe(false);
		expect((await call(a, 'GET', `/users/${a.id}`)).json.roles).toEqual([]);
	});

	test('deleting a role leaves audit rows for the role, its grants and its gates', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const role = (await call(admin, 'POST', '/roles', { name: 'Temp' })).json;
		await call(admin, 'PUT', '/gates/issue.approve', { roleIds: [role.id] });
		await call(admin, 'DELETE', `/roles/${role.id}`);
		const rows = db.select().from(auditLog).where(eq(auditLog.op, 'roles.delete')).all();
		expect(rows.map((r) => r.entity).sort()).toEqual(['role', 'role_gate']);
	});
});

describe('assigning roles to a user', () => {
	test('setting roles replaces the set and the user shows the new roles', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const [w, f] = [(await call(admin, 'POST', '/roles', { name: 'Welder' })).json, (await call(admin, 'POST', '/roles', { name: 'Fitter' })).json];
		let u = (await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [w.id, f.id] })).json;
		expect(u.roles.map((r: any) => r.name)).toEqual(['Fitter', 'Welder']);
		u = (await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [f.id] })).json;
		expect(u.roles.map((r: any) => r.name)).toEqual(['Fitter']);
	});

	test('an unknown role id is refused and only an admin may assign', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		expect((await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [9999] })).status).toBe(400);
		expect((await call(bob, 'PUT', `/users/${bob.id}/roles`, { roleIds: [] })).status).toBe(403);
	});

	test('the Admin role mirrors isAdmin in both directions', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const adminRole = (await call(admin, 'GET', '/roles')).json.find((r: any) => r.key === 'admin');
		let u = (await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [adminRole.id] })).json;
		expect(u.isAdmin).toBe(true);
		expect(u.roles.map((r: any) => r.name)).toEqual(['Admin']);
		u = (await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [] })).json;
		expect(u.isAdmin).toBe(false);
		expect(u.roles).toEqual([]);
		// the flag shows up as the role
		u = (await call(admin, 'PATCH', `/users/${bob.id}`, { isAdmin: true })).json;
		expect(u.roles.map((r: any) => r.name)).toEqual(['Admin']);
	});

	test('the last active admin cannot lose the Admin role', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const r = await call(admin, 'PUT', `/users/${admin.id}/roles`, { roleIds: [] });
		expect(r.status).toBe(400);
		expect(r.json.message).toContain('last admin');
	});
});

describe('gates', () => {
	test('every signed-in user lists the gates; defaults map Engineer to disposition and Quality to approve', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const gates = (await call(bob, 'GET', '/gates')).json;
		expect(gates.map((g: any) => g.key)).toEqual(['issue.disposition', 'issue.approve']);
		const roles = (await call(bob, 'GET', '/roles')).json;
		const id = (key: string) => roles.find((r: any) => r.key === key).id;
		expect(gates[0].roleIds).toEqual([id('engineer')]);
		expect(gates[1].roleIds).toEqual([id('quality')]);
	});

	test('a role holder passes the gate its role is mapped to and nobody else but admins does', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const eng = makeUser('eng');
		const tech = makeUser('tech');
		const roles = (await call(admin, 'GET', '/roles')).json;
		await call(admin, 'PUT', `/users/${eng.id}/roles`, { roleIds: [roles.find((r: any) => r.key === 'engineer').id] });
		await call(admin, 'PUT', `/users/${tech.id}/roles`, { roleIds: [roles.find((r: any) => r.key === 'technician').id] });
		expect(holdsGate(db, eng.actor, 'issue.disposition')).toBe(true);
		expect(holdsGate(db, eng.actor, 'issue.approve')).toBe(false);
		expect(holdsGate(db, tech.actor, 'issue.disposition')).toBe(false);
		expect(holdsGate(db, admin.actor, 'issue.approve')).toBe(true);
		expect(holdsGate(db, { kind: 'system' }, 'admin')).toBe(true);
		expect(holdsGate(db, eng.actor, 'admin')).toBe(false);
		expect(holdsGate(db, { kind: 'anonymous' }, 'issue.approve')).toBe(false);
	});

	test('an admin can remap a gate; a non-admin cannot; an unknown gate or role is refused', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const tech = makeUser('tech');
		const roles = (await call(admin, 'GET', '/roles')).json;
		const technician = roles.find((r: any) => r.key === 'technician');
		await call(admin, 'PUT', `/users/${tech.id}/roles`, { roleIds: [technician.id] });
		expect((await call(tech, 'PUT', '/gates/issue.approve', { roleIds: [] })).status).toBe(403);
		expect((await call(admin, 'PUT', '/gates/nope', { roleIds: [] })).status).toBe(404);
		expect((await call(admin, 'PUT', '/gates/issue.approve', { roleIds: [9999] })).status).toBe(400);
		const set = await call(admin, 'PUT', '/gates/issue.approve', { roleIds: [technician.id] });
		expect(set.json.roleIds).toEqual([technician.id]);
		expect(holdsGate(db, tech.actor, 'issue.approve')).toBe(true);
	});

	test('an operation behind a role gate refuses a user without the role', async () => {
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		// roles.create needs the admin gate; a plain user is refused with 403
		expect((await call(bob, 'POST', '/roles', { name: 'X' })).status).toBe(403);
		expect((await call(null, 'GET', '/roles')).status).toBe(401);
	});
});

describe('role names in sign-off slots', () => {
	test('a slot naming a role is open to its holder and to an admin; a slot with no role is open to all', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const other = makeUser('other');
		const w = (await call(admin, 'POST', '/roles', { name: 'Welder' })).json;
		await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [w.id] });
		expect(holdsSlotRole(roleNamesOf(db, bob.id), 'welder')).toBe(true);
		expect(holdsSlotRole(roleNamesOf(db, other.id), 'Welder')).toBe(false);
		expect(holdsSlotRole(roleNamesOf(db, admin.id), 'Welder')).toBe(true);
		expect(holdsSlotRole(roleNamesOf(db, other.id), null)).toBe(true);
		expect(holdsSlotRole(roleNamesOf(db, other.id), '  ')).toBe(true);
	});

	test('a role name is canonicalised, a blank name is null and an unknown name is refused', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		await call(admin, 'POST', '/roles', { name: 'Welder' });
		expect(canonicalRoleName(db, ' welder ')).toBe('Welder');
		expect(canonicalRoleName(db, '')).toBeNull();
		expect(() => canonicalRoleName(db, 'Nobody')).toThrow("Unknown role 'Nobody'");
	});

	test('a deleted role can no longer be signed', async () => {
		const { db, call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const w = (await call(admin, 'POST', '/roles', { name: 'Welder' })).json;
		await call(admin, 'PUT', `/users/${bob.id}/roles`, { roleIds: [w.id] });
		await call(admin, 'DELETE', `/roles/${w.id}`);
		expect(holdsSlotRole(roleNamesOf(db, bob.id), 'Welder')).toBe(false);
	});
});
