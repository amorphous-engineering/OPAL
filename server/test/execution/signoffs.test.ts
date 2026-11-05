import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

/** A published procedure whose first step declares these slots. */
async function declared(t: Awaited<ReturnType<typeof setup>>, signoffs: { role: string | null }[]) {
	const p = await t.proc('Declared ' + Math.random().toString(36).slice(2, 6));
	await t.step(p.id, 'Torque flange', { signoffs });
	await t.step(p.id, 'Routine');
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return t.cut(p.id);
}

describe('two slots mean two different people', () => {
	test('whoever signed the first slot cannot sign the second', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }]);
		expect((await t.sign(e.id, '1', 0)).status).toBe(200);
		const r = await t.sign(e.id, '1', 1);
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('Needs a different person from Primary buyoff');
	});

	test('another person signs the second slot and the step completes', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const r = await t.sign(e.id, '1', 1, {}, t.benActor);
		expect(r.status).toBe(200);
		expect(r.json.stepCompleted).toBe(true);
	});

	test('a third slot needs someone other than both earlier signers', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		await t.sign(e.id, '1', 1, {}, t.benActor);
		expect((await t.sign(e.id, '1', 2, {}, t.benActor)).status).toBe(409);
		expect((await t.sign(e.id, '1', 2)).status).toBe(409);
		expect((await t.sign(e.id, '1', 2, {}, t.catActor)).status).toBe(200);
	});

	test('signoff, which takes the next slot, refuses the same person too', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const sid = await t.stepOf(e.id, '1');
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/signoff`, {})).status).toBe(409);
		expect((await t.call('POST', `/executions/${e.id}/steps/${sid}/signoff`, {}, t.benActor)).status).toBe(200);
	});

	test('the document shows the slot inert with its reason to the person who signed, live to anyone else', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		const mine = (await t.doc(e.id)).ops[0].step.signoffs[1];
		expect(mine.canSign).toBe(false);
		expect(mine.blockers).toMatchObject([{ kind: 'same_person', message: 'Needs a different person from Primary buyoff' }]);
		const theirs = (await t.call('GET', `/executions/${e.id}/document`, undefined, t.benActor)).json.ops[0].step.signoffs[1];
		expect(theirs).toMatchObject({ canSign: true, blockers: [] });
	});

	test('a default slot on another step is not affected by who signed this one', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		expect((await t.complete(e.id, '2')).status).toBe(200);
	});
});

describe('routine work is implicit', () => {
	test('completing a default step stamps who and when with no second act', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const r = await t.complete(e.id, '1');
		expect(r.status).toBe(200);
		expect(r.json.step.status).toBe('completed');
		const step = (await t.doc(e.id)).ops[0].step;
		expect(step.completed).toMatchObject({ initials: expect.any(String), at: expect.any(String) });
		expect(step.completed.by).not.toBeNull();
	});

	test('the report lists no signature for a routine step, and the operator stamps it', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		await t.complete(e.id, '1');
		const op = (await t.ok('GET', `/executions/${e.id}/report`)).operations[0];
		expect(op.signoffs).toEqual([]);
		expect(op.operator).not.toBeNull();
	});

	test('the report lists the slots of a declared sign-off by label', async () => {
		const t = await setup();
		const e = await declared(t, [{ role: null }, { role: null }]);
		await t.sign(e.id, '1', 0);
		await t.sign(e.id, '1', 1, {}, t.benActor);
		await t.complete(e.id, '2');
		const ops = (await t.ok('GET', `/executions/${e.id}/report`)).operations;
		expect(ops[0].signoffs.map((s: any) => s.label)).toEqual(['Primary buyoff', 'Secondary buyoff']);
		expect(ops[1].signoffs).toEqual([]);
	});

	test('one slot with a role is a declared sign-off, not routine', async () => {
		const t = await setup();
		const p = await t.proc('Role slot');
		await t.step(p.id, 'Inspect', { signoffs: [{ role: 'Quality' }] });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.sign(e.id, '1', 0);
		const op = (await t.ok('GET', `/executions/${e.id}/report`)).operations[0];
		expect(op.signoffs.map((s: any) => s.role)).toEqual(['Quality']);
	});
});
