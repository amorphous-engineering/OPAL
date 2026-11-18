import { waiverLine } from '@opal/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Actor } from '../../src/context.ts';
import { role, user, userRole } from '../../src/db/schema/index.ts';
import { ensureSystemRoles } from '../../src/services/org/roles.ts';
import { setup } from './helpers.ts';

/** A published procedure whose first step declares these slots, then one routine step. */
async function declared(t: Awaited<ReturnType<typeof setup>>, signoffs: { role: string | null }[]) {
	const p = await t.proc('Declared ' + Math.random().toString(36).slice(2, 6));
	await t.step(p.id, 'Torque flange', { signoffs });
	await t.step(p.id, 'Routine');
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return t.cut(p.id);
}

async function world() {
	const t = await setup();
	/** `reason` null sends none. */
	const waive = async (id: number, number: string, slot: number, reason: string | null = 'only one tech on shift', as?: Actor) =>
		t.call('POST', `/executions/${id}/steps/${await t.stepOf(id, number)}/signoffs/${slot}/waive`, reason === null ? {} : { reason }, as);
	const person = (name: string, roleKey?: string): Actor => {
		ensureSystemRoles(t.db);
		const u = t.db.insert(user).values({ username: name, name, createdAt: 'x', updatedAt: 'x' }).returning().get();
		if (roleKey) {
			const r = t.db.select().from(role).where(eq(role.key, roleKey)).get()!;
			t.db.insert(userRole).values({ userId: u.id, roleId: r.id, grantedAt: 'x' }).run();
		}
		return { kind: 'user', userId: u.id, isAdmin: false, sessionId: 1 };
	};
	return { ...t, waive, person };
}

describe('the one person there waives the second sign-off', () => {
	test('whoever signed the first slot waives the second with a reason, and the step completes', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const r = await t.waive(e.id, '1', 1, '  solo bench test  ');
		expect(r.status).toBe(200);
		expect(r.json.stepCompleted).toBe(true);
		expect(r.json.step.status).toBe('completed');
		expect(r.json.signoffs[1]).toMatchObject({ signedBy: null, signedAt: null, waived: { reason: 'solo bench test', by: { name: 'Author' } } });
		expect(r.json.signoffs[1].waived.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
		expect((await t.complete(e.id, '2')).json.executionCompleted).toBe(true);
	});

	test('a waiver needs the first signature', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		const r = await t.waive(e.id, '1', 1);
		expect(r.status).toBe(409);
		expect(r.json.message).toBe('Cannot waive: Waiting on Primary buyoff');
	});

	test('a waiver needs a reason', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		expect((await t.waive(e.id, '1', 1, null)).status).toBe(422);
		expect((await t.waive(e.id, '1', 1, '   ')).status).toBe(422);
		expect((await t.get(e.id)).steps[0].status).toBe('awaiting_signoff');
	});

	test('the first slot is the work itself and cannot be waived', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		expect((await t.waive(e.id, '1', 0)).status).toBe(422);
	});

	test('someone who could sign the slot signs it: a waiver is for the person who signed an earlier one', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const r = await t.waive(e.id, '1', 1, 'busy', t.benActor);
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('is yours to sign');
	});

	test("the slot's role still stands: a first signer without it cannot waive it", async () => {
		const t = await world();
		const tech = t.person('tess', 'technician');
		const qa = t.person('quinn', 'quality');
		const a = await declared(t, [{ role: null }, { role: 'Quality' }]);
		await t.sign(a.id, '1', 0, {}, tech);
		expect((await t.waive(a.id, '1', 1, 'no QA tonight', tech)).status).toBe(403);
		const b = await declared(t, [{ role: null }, { role: 'Quality' }]);
		await t.sign(b.id, '1', 0, {}, qa);
		expect((await t.waive(b.id, '1', 1, 'QA did the work herself', qa)).status).toBe(200);
	});

	test('a hold in the step scope refuses the waiver as it refuses the signature', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		expect((await t.nc(e.id, '1')).status).toBe(200);
		const r = await t.waive(e.id, '1', 1);
		expect(r.status).toBe(409);
		expect(r.json.message).toStartWith('Cannot waive:');
	});

	test('with three slots a waiver fills one, and the next sign-off takes the slot after it', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const w = await t.waive(e.id, '1', 1);
		expect(w.json.stepCompleted).toBe(false);
		expect(w.json.step.status).toBe('awaiting_signoff');
		const sid = await t.stepOf(e.id, '1');
		const r = await t.call('POST', `/executions/${e.id}/steps/${sid}/signoff`, {}, t.benActor);
		expect(r.status).toBe(200);
		expect(r.json.slot).toBe(2);
		expect(r.json.stepCompleted).toBe(true);
	});
});

describe('a waiver is a committed record', () => {
	test('it cannot be waived again, signed over or removed, and the audit log has it', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		await t.waive(e.id, '1', 1, 'first reason');
		const again = await t.waive(e.id, '1', 1, 'second reason');
		expect(again.status).toBe(409);
		expect(again.json.message).toBe('Secondary buyoff already waived');
		const over = await t.sign(e.id, '1', 1, {}, t.benActor);
		expect(over.status).toBe(409);
		expect(over.json.message).toBe('Secondary buyoff was waived');
		const sid = await t.stepOf(e.id, '1');
		expect((await t.call('DELETE', `/executions/${e.id}/steps/${sid}/signoffs/1/waive`)).status).toBe(404);
		const doc = await t.doc(e.id);
		expect(doc.ops[0].step.signoffs[1].waived.reason).toBe('first reason');
		const audit = await t.ok('GET', '/audit?entity=signoff_waiver');
		expect(audit.items.map((i: any) => [i.action, i.op])).toEqual([['create', 'execution.waive']]);
		expect(audit.items[0].changes.find((c: any) => c.field === 'reason').new).toBe('first reason');
		const undo = await t.call('POST', '/undo/last', {});
		expect(undo.status).toBe(409);
		expect((await t.doc(e.id)).ops[0].step.signoffs[1].waived.reason).toBe('first reason');
	});

	test('an API token cannot waive: it is a person setting a signature aside', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		expect((await t.waive(e.id, '1', 1, 'agent', t.token)).status).toBe(403);
	});
});

describe('what the run view and the report show', () => {
	test('the first signer is offered the waiver, anyone else the signature', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const mine = (await t.doc(e.id)).ops[0].step.signoffs[1];
		expect(mine).toMatchObject({ canSign: false, canWaive: true, waived: null });
		const theirs = (await t.call('GET', `/executions/${e.id}/document`, undefined, t.benActor)).json.ops[0].step.signoffs[1];
		expect(theirs).toMatchObject({ canSign: true, canWaive: false });
	});

	test('a waived slot shows the waiver, never a signature, and the step is not signed off by anyone', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		await t.waive(e.id, '1', 1, 'solo bench test');
		const step = (await t.doc(e.id)).ops[0].step;
		expect(step.signoffs[1]).toMatchObject({ signedBy: null, canSign: false, canWaive: false, waived: { reason: 'solo bench test' } });
		expect(step.signedOff).toBeNull();
		expect(step.status).toBe('completed');
	});

	test('the printed report carries the waiver in the slot it filled, after the signature', async () => {
		const t = await world();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		await t.waive(e.id, '1', 1, 'solo bench test');
		await t.complete(e.id, '2');
		const signoffs = (await t.ok('GET', `/executions/${e.id}/report`)).operations[0].signoffs;
		expect(signoffs).toHaveLength(2);
		expect(signoffs[0]).toMatchObject({ slot: 0, label: 'Primary buyoff', signedBy: 'Author', waived: null });
		expect(signoffs[1]).toMatchObject({ slot: 1, label: 'Secondary buyoff', signedBy: null, signedAt: null, waived: { by: 'Author', reason: 'solo bench test' } });
		expect(waiverLine(signoffs[1].label, { ...signoffs[1].waived, at: '2026-11-17 14:02' })).toBe(
			'Secondary buyoff waived: solo bench test, Author, 2026-11-17 14:02'
		);
	});
});
