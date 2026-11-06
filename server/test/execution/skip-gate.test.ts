import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Actor } from '../../src/context.ts';
import { role, user, userRole } from '../../src/db/schema/index.ts';
import { ensureSystemRoles } from '../../src/services/org/roles.ts';
import { setup } from './helpers.ts';

const REQUIRED = { fields: [{ name: 'torque', label: 'Torque', type: 'number', required: true }] };

async function world() {
	const t = await setup();
	ensureSystemRoles(t.db);
	const asUser = (u: { id: number; isAdmin: boolean }): Actor => ({ kind: 'user', userId: u.id, isAdmin: u.isAdmin, sessionId: 1 });
	const roleId = (key: string) => t.db.select().from(role).where(eq(role.key, key)).get()!.id;
	const person = (name: string, roleKey?: string) => {
		const u = t.db.select().from(user).where(eq(user.username, name)).get() ?? t.db.insert(user).values({ username: name, name, createdAt: 'x', updatedAt: 'x' }).returning().get();
		if (roleKey) t.db.insert(userRole).values({ userId: u.id, roleId: roleId(roleKey), grantedAt: 'x' }).run();
		return asUser(u);
	};
	const cutWith = async (extra: Record<string, unknown>) => {
		const p = await t.proc('Skip ' + Math.random().toString(36).slice(2, 6));
		await t.step(p.id, 'Guarded', extra);
		await t.step(p.id, 'Plain');
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		return t.cut(p.id);
	};
	return { ...t, asUser, roleId, person, cutWith };
}

describe('skipping a step with required data', () => {
	test('a technician cannot skip a step with required data', async () => {
		const t = await world();
		const e = await t.cutWith({ dataSchema: REQUIRED });
		const r = await t.skip(e.id, '1', {}, t.person('tom', 'technician'));
		expect(r.status).toBe(403);
		expect(r.json.message).toBe('Requires Engineer or Quality');
		expect((await t.skip(e.id, '1', {}, t.person('nobody'))).status).toBe(403);
	});

	test('an engineer or a quality user can skip a step with required data', async () => {
		const t = await world();
		const e = await t.cutWith({ dataSchema: REQUIRED });
		expect((await t.skip(e.id, '1', {}, t.person('eve', 'engineer'))).status).toBe(200);
		const e2 = await t.cutWith({ dataSchema: REQUIRED });
		expect((await t.skip(e2.id, '1', {}, t.person('quinn', 'quality'))).status).toBe(200);
	});

	test('an admin can skip a step with required data', async () => {
		const t = await world();
		const e = await t.cutWith({ dataSchema: REQUIRED });
		const admin = t.db.insert(user).values({ username: 'root', name: 'root', isAdmin: true, createdAt: 'x', updatedAt: 'x' }).returning().get();
		expect((await t.skip(e.id, '1', {}, t.asUser(admin))).status).toBe(200);
	});

	test('a role the roles setting maps to the gate can skip, and a role removed from it cannot', async () => {
		const t = await world();
		const admin = t.db.insert(user).values({ username: 'root', name: 'root', isAdmin: true, createdAt: 'x', updatedAt: 'x' }).returning().get();
		const tech = t.person('tom', 'technician');
		await t.call('PUT', '/gates/execution.skipRequired', { roleIds: [t.roleId('technician')] }, t.asUser(admin));
		const e = await t.cutWith({ dataSchema: REQUIRED });
		expect((await t.skip(e.id, '1', {}, tech)).status).toBe(200);
		// Engineer lost the default mapping, so the setting is what decides.
		const e2 = await t.cutWith({ dataSchema: REQUIRED });
		const r = await t.skip(e2.id, '1', {}, t.person('eve', 'engineer'));
		expect(r.status).toBe(403);
		expect(r.json.message).toBe('Requires Technician');
	});

	test('a step with no required data stays skippable by anyone signed in', async () => {
		const t = await world();
		const e = await t.cutWith({ dataSchema: { fields: [{ name: 'note', type: 'text' }] } });
		expect((await t.skip(e.id, '1', {}, t.person('tom', 'technician'))).status).toBe(200);
		expect((await t.skip(e.id, '2', {}, t.person('nobody'))).status).toBe(200);
	});
});

describe('skipping needs a reason', () => {
	test('a skip with no reason is refused and the step stays open', async () => {
		const t = await world();
		const e = await t.cutWith({});
		const sid = await t.stepOf(e.id, '1');
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/skip`, {})).status).toBe(422);
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/skip`, { reason: '   ' })).status).toBe(422);
		expect((await t.get(e.id)).steps[0].status).toBe('pending');
	});

	test('the reason stays on the skipped step', async () => {
		const t = await world();
		const e = await t.cutWith({});
		expect((await t.skip(e.id, '1', { reason: 'bracket already fitted' })).status).toBe(200);
		expect((await t.doc(e.id)).ops[0].step.skipReason).toBe('bracket already fitted');
	});

	test('the document names the gate on a step this person cannot skip, and only for them', async () => {
		const t = await world();
		const e = await t.cutWith({ dataSchema: REQUIRED });
		const asTech = await t.call('GET', `/executions/${e.id}/document`, undefined, t.person('tom', 'technician'));
		expect(asTech.json.ops[0].step.skipBlockers).toMatchObject([{ kind: 'role', message: 'Requires Engineer or Quality' }]);
		const asEng = await t.call('GET', `/executions/${e.id}/document`, undefined, t.person('eve', 'engineer'));
		expect(asEng.json.ops[0].step.skipBlockers).toEqual([]);
		expect(asEng.json.ops[1].step.skipBlockers).toEqual([]);
	});
});

describe('skipping a step with a role-gated sign-off slot', () => {
	test('a user without the slot role or the gate cannot skip a step that declares a buyoff', async () => {
		const t = await world();
		const e = await t.cutWith({ signoffs: [{ role: null }, { role: 'Quality' }] });
		const r = await t.skip(e.id, '1', {}, t.person('ted', 'technician'));
		expect(r.status).toBe(403);
		expect((await t.skip(e.id, '1', {}, t.person('quinn', 'quality'))).status).toBe(200);
	});

	test('a holder of the slot role can skip even when the gate is unmapped', async () => {
		const t = await world();
		const admin = t.db.insert(user).values({ username: 'root', name: 'root', isAdmin: true, createdAt: 'x', updatedAt: 'x' }).returning().get();
		await t.call('PUT', '/gates/execution.skipRequired', { roleIds: [] }, t.asUser(admin));
		const e = await t.cutWith({ signoffs: [{ role: 'Quality' }] });
		expect((await t.skip(e.id, '1', {}, t.person('tom', 'technician'))).status).toBe(403);
		expect((await t.skip(e.id, '1', {}, t.person('quinn', 'quality'))).status).toBe(200);
	});
});

describe('skipping a step with a declared sign-off', () => {
	test('a second slot that names no role still needs the gate', async () => {
		const t = await world();
		const e = await t.cutWith({ signoffs: [{ role: null }, { role: null }] });
		expect((await t.skip(e.id, '1', {}, t.person('tom', 'technician'))).status).toBe(403);
		expect((await t.skip(e.id, '1', {}, t.person('eve', 'engineer'))).status).toBe(200);
	});

	test('holding the role of one slot gives no authority over an unnamed one', async () => {
		const t = await world();
		const admin = t.db.insert(user).values({ username: 'root', name: 'root', isAdmin: true, createdAt: 'x', updatedAt: 'x' }).returning().get();
		await t.call('PUT', '/gates/execution.skipRequired', { roleIds: [] }, t.asUser(admin));
		const e = await t.cutWith({ signoffs: [{ role: null }, { role: 'Quality' }] });
		expect((await t.skip(e.id, '1', {}, t.person('quinn', 'quality'))).status).toBe(403);
	});

	test('a signed slot refuses every skip, gate or not, and the stamps of the signature stay', async () => {
		const t = await world();
		const e = await t.cutWith({ signoffs: [{ role: null }, { role: 'Quality' }] });
		const tom = t.person('tom', 'technician');
		expect((await t.complete(e.id, '1', {}, tom)).status).toBe(200);
		const before = (await t.get(e.id)).steps[0];
		expect(before.status).toBe('awaiting_signoff');
		for (const who of [t.person('quinn', 'quality'), t.person('eve', 'engineer')]) {
			const r = await t.skip(e.id, '1', {}, who);
			expect(r.status).toBe(409);
			expect(r.json.message).toContain('sign-off');
		}
		expect((await t.get(e.id)).steps[0]).toEqual(before);
		const doc = await t.call('GET', `/executions/${e.id}/document`, undefined, t.person('eve'));
		expect(doc.json.ops[0].step.skipBlockers.map((b: any) => b.kind)).toEqual(['signoff']);
	});

	test('an OP whose sub-steps are done and that waits on its buyoff cannot be skipped', async () => {
		const t = await world();
		const p = await t.proc('Skip buyoff');
		const op = await t.step(p.id, 'Inspect', { signoffs: [{ role: null }] });
		await t.step(p.id, 'Look', { parentId: op.id });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		expect((await t.skip(e.id, '1.1', {}, t.person('tom', 'technician'))).status).toBe(200);
		expect((await t.get(e.id)).steps[0].status).toBe('awaiting_signoff');
		expect((await t.skip(e.id, '1', {}, t.person('eve', 'engineer'))).status).toBe(409);
		expect((await t.get(e.id)).steps[0].status).toBe('awaiting_signoff');
	});

	test('a routine step keeps its implicit slot out of the gate', async () => {
		const t = await world();
		const e = await t.cutWith({});
		expect((await t.skip(e.id, '1', {}, t.person('nobody'))).status).toBe(200);
	});
});
